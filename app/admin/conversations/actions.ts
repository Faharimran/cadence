"use server";

import { revalidatePath } from "next/cache";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { pauseBot, resumeBot, recordOutbound } from "@/lib/conversation/thread";
import { adminDb } from "@/lib/prisma";
import { sendText } from "@/lib/channels/whatsapp";
import { logger } from "@/lib/logger";
import { decrypt } from "@/lib/crypto";

/**
 * Human takeover.
 *
 * The pair of actions that make an AI assistant safe to put in front of
 * customers: a colleague can step in at any moment, and the assistant goes quiet
 * on that thread until they hand it back.
 */

export async function takeOver(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    await pauseBot(db, { tenantId: user.tenantId, conversationId: id });
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "conversation.taken_over",
        subject: `Conversation:${id}`,
      },
    });
  });

  revalidatePath("/admin/conversations");
  revalidatePath(`/admin/conversations/${id}`);
}

export async function handBack(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, (db) => resumeBot(db, { tenantId: user.tenantId, conversationId: id }));

  revalidatePath("/admin/conversations");
  revalidatePath(`/admin/conversations/${id}`);
}

/**
 * Sends a message as a person.
 *
 * Taking over first is deliberate rather than incidental: two voices answering
 * the same customer is worse than a slow reply, so replying by hand implies the
 * assistant should stop.
 */
export async function replyAsHuman(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!id || !body) return;

  const conversation = await asTenant(user, async (db) => {
    const convo = await db.conversation.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { customer: true },
    });
    if (!convo) return null;

    if (!convo.botPaused) {
      await pauseBot(db, { tenantId: user.tenantId, conversationId: id });
    }
    await recordOutbound(db, {
      tenantId: user.tenantId,
      conversationId: id,
      body,
      author: "human",
    });
    return convo;
  });

  if (!conversation) return;

  if (conversation.channel === "whatsapp" && conversation.externalThreadId) {
    const account = await adminDb.channelAccount.findFirst({
      where: { tenantId: user.tenantId, channel: "whatsapp", active: true },
    });
    if (account?.accessToken) {
      const sent = await sendText({
        phoneNumberId: account.externalAccountId,
        accessToken: decrypt(account.accessToken),
        to: conversation.externalThreadId,
        body,
      });
      if (!sent.ok) {
        // The message is already in the transcript; marking it failed is what
        // tells the colleague it did not actually reach the customer.
        logger.error("human reply failed to send", { conversationId: id, error: sent.error });
        await adminDb.conversationMessage.updateMany({
          where: { conversationId: id, direction: "outbound", author: "human", status: null },
          data: { status: "failed" },
        });
      }
    }
  }

  revalidatePath(`/admin/conversations/${id}`);
}
