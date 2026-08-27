import type { TenantDb } from "@/lib/prisma";
import { CadenceError } from "@/lib/api/errors";

/**
 * Conversation lifecycle. The transcript IS the agent's state — there is no
 * separate session object that can drift out of sync with what was actually
 * said.
 */

export type ThreadRef = {
  conversationId: string;
  customerId: string;
  botPaused: boolean;
  optedOut: boolean;
};

/**
 * Resolves an inbound message to a thread, creating the customer and
 * conversation if this is a first contact.
 *
 * Matching is by channel identity (a phone number, a widget session), because
 * that is the only thing a channel actually gives us.
 */
export async function openThread(
  db: TenantDb,
  args: {
    tenantId: string;
    channel: string;
    externalThreadId: string;
    /** Channel-level identity — phone for WhatsApp/SMS, email for web. */
    identity?: { phone?: string; email?: string; name?: string };
  },
): Promise<ThreadRef> {
  const existing = await db.conversation.findFirst({
    where: {
      tenantId: args.tenantId,
      channel: args.channel,
      externalThreadId: args.externalThreadId,
    },
    include: { customer: { select: { id: true, optedOut: true } } },
  });

  if (existing) {
    return {
      conversationId: existing.id,
      customerId: existing.customerId,
      botPaused: existing.botPaused,
      optedOut: existing.customer.optedOut,
    };
  }

  const { phone, email, name } = args.identity ?? {};
  const customer =
    (phone || email
      ? await db.customer.findFirst({
          where: { tenantId: args.tenantId, ...(phone ? { phone } : { email }) },
        })
      : null) ??
    (await db.customer.create({
      data: { tenantId: args.tenantId, phone: phone ?? null, email: email ?? null, name: name ?? null },
    }));

  const conversation = await db.conversation.create({
    data: {
      tenantId: args.tenantId,
      customerId: customer.id,
      channel: args.channel,
      externalThreadId: args.externalThreadId,
    },
  });

  return {
    conversationId: conversation.id,
    customerId: customer.id,
    botPaused: false,
    optedOut: customer.optedOut,
  };
}

export async function recordInbound(
  db: TenantDb,
  args: { tenantId: string; conversationId: string; body: string; externalId?: string },
) {
  const [message] = await Promise.all([
    db.conversationMessage.create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        direction: "inbound",
        author: "customer",
        body: args.body,
        externalId: args.externalId ?? null,
      },
    }),
    db.conversation.updateMany({
      where: { id: args.conversationId, tenantId: args.tenantId },
      data: { lastInboundAt: new Date() },
    }),
  ]);
  return message;
}

export async function recordOutbound(
  db: TenantDb,
  args: {
    tenantId: string;
    conversationId: string;
    body: string;
    author: "agent" | "human";
    /** The tool calls behind this reply, kept for audit. */
    toolTrace?: unknown;
    /** Which snapshot the agent was reading when it said this. */
    snapshotAt?: Date | null;
  },
) {
  const [message] = await Promise.all([
    db.conversationMessage.create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        direction: "outbound",
        author: args.author,
        body: args.body,
        toolTrace: (args.toolTrace ?? null) as never,
        snapshotAt: args.snapshotAt ?? null,
      },
    }),
    db.conversation.updateMany({
      where: { id: args.conversationId, tenantId: args.tenantId },
      data: { lastOutboundAt: new Date() },
    }),
  ]);
  return message;
}

/**
 * The whole transcript, oldest first, as alternating turns for the model.
 *
 * Human replies are folded in as assistant turns rather than dropped: when a
 * colleague takes over and later hands back, the agent must see what was
 * promised in its absence, or it will contradict its own business.
 */
export async function loadTranscript(
  db: TenantDb,
  args: { tenantId: string; conversationId: string; limit?: number },
) {
  const rows = await db.conversationMessage.findMany({
    where: { tenantId: args.tenantId, conversationId: args.conversationId },
    orderBy: { createdAt: "desc" },
    take: args.limit ?? 40,
  });

  return rows
    .reverse()
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }))
    .filter((m) => m.content.trim().length > 0);
}

/** Stops the agent replying on this thread. */
export async function pauseBot(
  db: TenantDb,
  args: { tenantId: string; conversationId: string },
) {
  const updated = await db.conversation.updateMany({
    where: { id: args.conversationId, tenantId: args.tenantId },
    data: { botPaused: true, botPausedAt: new Date() },
  });
  if (updated.count === 0) throw new CadenceError("not_found", "Unknown conversation.");
}

/** Hands the thread back to the agent after a human is done. */
export async function resumeBot(
  db: TenantDb,
  args: { tenantId: string; conversationId: string },
) {
  await db.conversation.updateMany({
    where: { id: args.conversationId, tenantId: args.tenantId },
    data: { botPaused: false, botPausedAt: null },
  });
}
