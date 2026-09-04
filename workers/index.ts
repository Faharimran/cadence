import { Worker } from "bullmq";
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { decrypt } from "@/lib/crypto";
import {
  AGENT_TURN_QUEUE,
  INGEST_QUEUE,
  createQueueConnection,
  closeQueues,
  type AgentTurnJob,
  type KnowledgeIngestJob,
} from "@/lib/queue";
import { ingestSource, takeUpload } from "@/lib/knowledge/ingest";
import { runAgentTurn, isAgentConfigured } from "@/lib/conversation/agent";
import { expireStaleHolds } from "@/lib/engine/booking";
import { sendText, splitForDelivery } from "@/lib/channels/whatsapp";
import { attemptDelivery, dueDeliveries } from "@/lib/webhooks/deliver";

/**
 * Background workers.
 *
 * The agent turn lives here rather than in the webhook because it takes seconds,
 * and Meta retries anything slow — a retry becomes a duplicate reply to a real
 * customer.
 *
 * Run: npm run worker
 */

const HOLD_SWEEP_INTERVAL_MS = 60_000;
const WEBHOOK_DRAIN_INTERVAL_MS = 5_000;

const connection = createQueueConnection();

const agentWorker = new Worker<AgentTurnJob>(
  AGENT_TURN_QUEUE,
  async (job) => {
    const { tenantId, conversationId, customerId } = job.data;

    // Re-checked here, not just at enqueue time. Minutes of debounce and queue
    // wait can pass, and a colleague may have taken the thread over in between.
    // Replying after a human stepped in is worse than not replying at all.
    const conversation = await adminDb.conversation.findUnique({
      where: { id: conversationId },
      select: { botPaused: true, channel: true, externalThreadId: true },
    });
    if (!conversation) return { skipped: "conversation gone" };
    if (conversation.botPaused) return { skipped: "human has the thread" };

    const turn = await withTenant(
      tenantId,
      (db) => runAgentTurn(db, { tenantId, conversationId, customerId }),
      // A turn makes several model round-trips; the default transaction timeout
      // is nowhere near enough.
      { timeoutMs: 180_000 },
    );

    if (!turn.reply) return { skipped: "no reply produced" };

    if (conversation.channel === "whatsapp" && conversation.externalThreadId) {
      await deliverWhatsApp({
        tenantId,
        to: conversation.externalThreadId,
        body: turn.reply,
        conversationId,
      });
    }

    return {
      escalated: turn.escalated,
      tools: turn.toolCalls.length,
      bookings: turn.bookingIds.length,
    };
  },
  {
    connection,
    // One turn at a time per worker process. Turns are model-bound rather than
    // CPU-bound, so raise this once there is real traffic — but each concurrent
    // turn holds a database transaction, so it is bounded by the connection
    // pool, not by ambition.
    concurrency: 4,
  },
);

agentWorker.on("completed", (job, result) => {
  logger.info("agent turn done", { job: job.id, ...(result as object) });
});
agentWorker.on("failed", (job, err) => {
  logger.error("agent turn failed", { job: job?.id, err: err.message });
});

/**
 * Reading uploaded documents.
 *
 * Separate from the agent worker because the two fail differently and should not
 * share a retry policy: a turn that fails leaves a customer waiting and is worth
 * retrying; an ingestion that fails leaves a row a person can see and re-upload,
 * and retrying it silently re-bills the titling calls.
 */
const ingestWorker = new Worker<KnowledgeIngestJob>(
  INGEST_QUEUE,
  async (job) => {
    const { tenantId, sourceId } = job.data;

    const bytes = await takeUpload(sourceId);
    if (!bytes) {
      // The stash expired, or this is a retry after the bytes were consumed.
      // Recorded on the row rather than thrown, so the reviewer sees a sentence
      // they can act on instead of an empty source stuck at "extracting".
      const note = "The upload expired before it could be read. Please upload the file again.";
      await withTenant(tenantId, (db) =>
        db.knowledgeSource.update({
          where: { id: sourceId },
          data: { status: "failed", failureNote: note },
        }),
      );
      return { skipped: "upload expired" };
    }

    return withTenant(
      tenantId,
      (db) => ingestSource(db, { tenantId, sourceId, bytes }),
      // Extraction plus one titling call per batch of passages. A long brochure
      // legitimately takes minutes.
      { timeoutMs: 600_000 },
    );
  },
  { connection, concurrency: 2 },
);

ingestWorker.on("completed", (job, result) => {
  logger.info("knowledge ingest done", { job: job.id, ...(result as object) });
});
ingestWorker.on("failed", async (job, err) => {
  logger.error("knowledge ingest failed", { job: job?.id, err: err.message });
  // A thrown error would otherwise leave the source sitting at "extracting"
  // forever, which reads as "still working" to whoever uploaded it.
  if (job?.data) {
    await withTenant(job.data.tenantId, (db) =>
      db.knowledgeSource.update({
        where: { id: job.data.sourceId },
        data: {
          status: "failed",
          failureNote: "Something went wrong reading that file. Try uploading it again.",
        },
      }),
    ).catch(() => {});
  }
});

/**
 * Delivers a reply, and records what the customer actually received.
 *
 * The outbound message row was already written by the agent; this attaches the
 * provider's id so delivery receipts can be matched to it later.
 */
async function deliverWhatsApp(args: {
  tenantId: string;
  to: string;
  body: string;
  conversationId: string;
}) {
  const account = await adminDb.channelAccount.findFirst({
    where: { tenantId: args.tenantId, channel: "whatsapp", active: true },
  });
  if (!account?.accessToken) {
    logger.error("no WhatsApp credentials for tenant", { tenantId: args.tenantId });
    return;
  }

  for (const part of splitForDelivery(args.body)) {
    const result = await sendText({
      phoneNumberId: account.externalAccountId,
      accessToken: decrypt(account.accessToken),
      to: args.to,
      body: part,
    });

    if (!result.ok) {
      // Mark the reply as failed rather than pretending it landed — a customer
      // waiting on a confirmation that never arrived needs a human to notice.
      //
      // Stored WITH the reason. "Not delivered" on its own tells an owner that
      // something is wrong and nothing about what, so it reaches us or nobody;
      // the usual cause is an expired access token, which they can fix
      // themselves in two minutes once told that is what happened.
      await adminDb.conversationMessage.updateMany({
        where: { conversationId: args.conversationId, direction: "outbound", status: null },
        data: { status: "failed", failureReason: result.reason },
      });
      return;
    }

    await adminDb.conversationMessage.updateMany({
      where: { conversationId: args.conversationId, direction: "outbound", externalId: null },
      data: { externalId: result.messageId, status: "sent" },
    });
  }
}

/**
 * Releases holds whose window has passed, across every tenant.
 *
 * Housekeeping, not correctness — `confirmHold` independently refuses an expired
 * hold, so if this stops running slots free up late rather than being sold twice.
 */
async function sweepExpiredHolds() {
  try {
    const tenants = await adminDb.tenant.findMany({
      where: { status: "active" },
      select: { id: true },
    });
    let total = 0;
    for (const { id } of tenants) {
      total += await withTenant(id, (db) => expireStaleHolds(db, id));
    }
    if (total > 0) logger.info("released expired holds", { count: total });
  } catch (err) {
    logger.error("hold sweep failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Drains the webhook outbox.
 *
 * Polls the table rather than consuming a queue, because the delivery rows are
 * written in the same transaction as the booking that caused them. Nothing can
 * be enqueued-but-lost, and a worker restart picks up exactly where it left off.
 */
let draining = false;
async function drainWebhooks() {
  if (draining) return; // never overlap two drains onto the same rows
  draining = true;
  try {
    const ids = await dueDeliveries();
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map(attemptDelivery));
    const delivered = results.filter(
      (r) => r.status === "fulfilled" && r.value === "delivered",
    ).length;
    logger.info("webhook drain", { attempted: ids.length, delivered });
  } catch (err) {
    logger.error("webhook drain failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    draining = false;
  }
}

const sweepTimer = setInterval(sweepExpiredHolds, HOLD_SWEEP_INTERVAL_MS);
const webhookTimer = setInterval(drainWebhooks, WEBHOOK_DRAIN_INTERVAL_MS);
void sweepExpiredHolds();
void drainWebhooks();

logger.info("worker started", {
  queues: [AGENT_TURN_QUEUE, INGEST_QUEUE, "webhook-outbox"],
  agent: isAgentConfigured() ? "configured" : "NO ANTHROPIC_API_KEY — turns will fail",
});

async function shutdown(signal: string) {
  logger.info(`worker shutting down (${signal})`);
  clearInterval(sweepTimer);
  clearInterval(webhookTimer);
  // Closing the worker waits for in-flight jobs, so a turn mid-conversation
  // finishes and the customer is not left hanging.
  await agentWorker.close();
  await ingestWorker.close();
  await closeQueues();
  await adminDb.$disconnect();
  redis.disconnect();
  connection.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
