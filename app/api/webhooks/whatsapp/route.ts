import { adminDb, withTenant } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  parseInbound,
  verifyChallenge,
  verifySignature,
  type InboundMessage,
} from "@/lib/channels/whatsapp";
import { openThread, recordInbound } from "@/lib/conversation/thread";
import { scheduleAgentTurn } from "@/lib/queue";
import { decrypt } from "@/lib/crypto";

/**
 * Meta's inbound webhook.
 *
 * Two constraints shape this endpoint:
 *
 *  1. **It must answer fast.** Meta retries anything slow or non-200, and a
 *     retry becomes a duplicate reply. So this does the minimum — verify,
 *     record, enqueue — and returns. The agent turn happens in the worker,
 *     where it can take the ten seconds it needs.
 *
 *  2. **It is one URL for every tenant.** Meta posts all traffic for an app to a
 *     single endpoint; the only tenant discriminator is `phone_number_id`, so
 *     that is the routing key.
 */

/** GET — the one-time subscription handshake performed when saving the URL. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get("hub.verify_token");
  if (!token) return new Response("missing verify token", { status: 400 });

  // Cross-tenant by necessity: the handshake carries no phone_number_id, only
  // the token, so the token itself has to identify the account.
  //
  // Compared after decryption rather than matched in SQL, because the stored
  // value is encrypted with a random IV — the same token encrypts differently
  // every time, so `where: { verifyToken: token }` would never match anything.
  // This runs once when a number is first connected, so scanning the (small)
  // set of accounts is not a hot path.
  const candidates = await adminDb.channelAccount.findMany({
    where: { channel: "whatsapp", active: true, verifyToken: { not: null } },
    select: { verifyToken: true },
  });

  const matched = candidates.find((c) => {
    try {
      return decrypt(c.verifyToken!) === token;
    } catch {
      return false; // a row we cannot decrypt is not a match
    }
  });
  if (!matched?.verifyToken) return new Response("forbidden", { status: 403 });

  const challenge = verifyChallenge(params, decrypt(matched.verifyToken));
  if (!challenge) return new Response("forbidden", { status: 403 });

  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request) {
  // The signature is computed over the exact bytes received, so the body must be
  // read as raw text. Parsing first and re-serialising changes key order and the
  // MAC never matches.
  const raw = await request.text();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const { messages, statuses } = parseInbound(payload);

  // Always 200 from here on. Meta treats anything else as a delivery failure and
  // retries the whole batch — turning one unparseable message into a loop.
  const ok = () => new Response("ok", { status: 200 });

  if (messages.length === 0 && statuses.length === 0) return ok();

  const phoneNumberId = messages[0]?.phoneNumberId;
  if (!phoneNumberId) return ok();

  const account = await adminDb.channelAccount.findUnique({
    where: { externalAccountId: phoneNumberId },
    include: { tenant: { select: { status: true } } },
  });

  if (!account || !account.active || account.tenant.status !== "active") {
    logger.warn("whatsapp inbound for unknown or inactive account", { phoneNumberId });
    return ok();
  }

  if (account.appSecret) {
    if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), decrypt(account.appSecret))) {
      // A bad signature is the one case worth refusing: it is either a
      // misconfiguration or someone forging messages into a real thread.
      logger.error("whatsapp signature verification failed", { phoneNumberId });
      return new Response("bad signature", { status: 401 });
    }
  } else {
    logger.warn("whatsapp account has no appSecret — inbound is UNVERIFIED", {
      phoneNumberId,
    });
  }

  for (const message of messages) {
    try {
      await handleMessage(account.tenantId, message);
    } catch (err) {
      // One bad message must not fail the batch and trigger a redelivery of the
      // good ones alongside it.
      logger.error("whatsapp inbound handling failed", {
        err: err instanceof Error ? err.message : String(err),
        messageId: message.messageId,
      });
    }
  }

  return ok();
}

async function handleMessage(tenantId: string, message: InboundMessage) {
  const shouldReply = await withTenant(tenantId, async (db) => {
    const thread = await openThread(db, {
      tenantId,
      channel: "whatsapp",
      externalThreadId: message.from,
      identity: { phone: `+${message.from}`, name: message.profileName },
    });

    // Meta redelivers on any non-200, and a batch can contain a message we
    // already stored. Recording the provider's id lets us drop the duplicate
    // instead of replying to the same question twice.
    const seen = await db.conversationMessage.findFirst({
      where: { tenantId, externalId: message.messageId },
      select: { id: true },
    });
    if (seen) return null;

    await recordInbound(db, {
      tenantId,
      conversationId: thread.conversationId,
      body: message.text,
      externalId: message.messageId,
    });

    // Both checked AFTER recording: an opted-out customer's message still
    // belongs in the transcript, and a thread a colleague has taken over still
    // needs their incoming messages visible. Neither gets an automated reply.
    if (thread.optedOut || thread.botPaused) return null;

    return { tenantId, conversationId: thread.conversationId, customerId: thread.customerId };
  });

  if (shouldReply) await scheduleAgentTurn(shouldReply);
}
