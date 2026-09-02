import { Queue } from "bullmq";
import Redis from "ioredis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Background work.
 *
 * BullMQ needs its own Redis connection: it uses blocking commands and requires
 * `maxRetriesPerRequest: null`, which would make the connection unusable for the
 * ordinary reads in lib/redis.ts. Sharing one client breaks both.
 */

export const AGENT_TURN_QUEUE = "agent-turn";
export const HOLD_EXPIRY_QUEUE = "hold-expiry";
export const INGEST_QUEUE = "knowledge-ingest";

/**
 * How long to wait after a message before replying.
 *
 * People type the way they speak — "hi" / "are you open monday" / "for a
 * session" arrive as three messages in four seconds. Replying to each produces
 * three overlapping answers and three sets of tool calls. Waiting a moment and
 * treating the burst as one turn is both cheaper and far more human.
 */
export const DEBOUNCE_MS = 4_000;

export function createQueueConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

let connection: Redis | null = null;
let agentTurnQueue: Queue | null = null;
let knowledgeIngestQueue: Queue | null = null;

function queueConnection(): Redis {
  connection ??= createQueueConnection();
  return connection;
}

export function agentTurns(): Queue {
  agentTurnQueue ??= new Queue(AGENT_TURN_QUEUE, {
    connection: queueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      // Removed the instant it finishes, NOT retained for an hour.
      //
      // The job id is the conversation id, and BullMQ silently ignores `add()`
      // for an id that still exists — completed or not. Keeping finished jobs
      // around therefore meant a thread could be answered once and then went
      // deaf for the whole retention window: every later message was recorded,
      // no turn was ever queued, and nothing anywhere reported an error.
      //
      // Retention was only ever for inspecting history, which the transcript
      // and the logs already cover.
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    },
  });
  return agentTurnQueue;
}

export type AgentTurnJob = {
  tenantId: string;
  conversationId: string;
  customerId: string;
};

/**
 * Schedules a reply, collapsing a burst of messages into one turn.
 *
 * The job id IS the conversation id, so at most one turn is ever queued per
 * thread. A new message removes the pending job and re-adds it, restarting the
 * debounce window.
 *
 * If removal fails the job has already started running — the message that just
 * arrived was recorded before this call, so the in-flight turn either picks it
 * up from the transcript or the follow-up job we add handles it. Either way
 * nothing is lost; the worst case is one extra reply.
 */
export function agentTurnJobId(conversationId: string): string {
  // BullMQ reserves ':' as its Redis key separator and rejects it in a custom
  // job id. The conversation id is already unique and the queue name namespaces
  // it, so it stands alone as the id.
  return conversationId;
}

export async function scheduleAgentTurn(job: AgentTurnJob): Promise<void> {
  const queue = agentTurns();
  const jobId = agentTurnJobId(job.conversationId);

  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      // Any state that is not currently running is cleared, including
      // `completed` and `failed`. Only `delayed` and `waiting` used to be, so a
      // finished job kept its id occupied and the `add` below became a silent
      // no-op — the bug that made a thread answer once and then ignore
      // everything after it.
      if (state !== "active") await existing.remove();
    }
  } catch (err) {
    logger.debug("debounce: could not remove pending turn", { err: String(err) });
  }

  const added = await queue.add("reply", job, { jobId, delay: DEBOUNCE_MS });

  // BullMQ returns a job whose id is not the one we asked for when it declined
  // to create it. Silence here is what let the original bug hide, so say so.
  if (added.id !== jobId) {
    logger.error("debounce: turn was NOT queued — job id already taken", {
      conversationId: job.conversationId,
      got: added.id,
    });
  }
}

/**
 * Reading an uploaded document.
 *
 * Queued rather than done in the request because extraction plus one titling
 * call per batch of passages takes tens of seconds on a real brochure — well
 * past any HTTP timeout, and not something a receptionist should sit watching a
 * spinner for. The upload returns as soon as the file is banked; the review
 * screen shows progress.
 *
 * One attempt, deliberately. A retry would re-run the titling calls and bill for
 * them again, and a half-ingested source is visible and re-uploadable, so the
 * failure is recoverable by hand rather than silently expensive.
 */
export function knowledgeIngests(): Queue {
  knowledgeIngestQueue ??= new Queue(INGEST_QUEUE, {
    connection: queueConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 604_800 },
    },
  });
  return knowledgeIngestQueue;
}

export type KnowledgeIngestJob = { tenantId: string; sourceId: string };

export async function scheduleIngest(job: KnowledgeIngestJob): Promise<void> {
  // The source id is the job id, so a double-submitted upload form cannot start
  // two extractions over the same rows.
  await knowledgeIngests().add("ingest", job, { jobId: job.sourceId });
}

export async function closeQueues(): Promise<void> {
  await agentTurnQueue?.close();
  await knowledgeIngestQueue?.close();
  connection?.disconnect();
  agentTurnQueue = null;
  knowledgeIngestQueue = null;
  connection = null;
}
