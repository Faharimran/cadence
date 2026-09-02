/**
 * The debounce must survive a completed turn.
 *
 * The job id is the conversation id, and BullMQ ignores `add()` for an id that
 * still exists — completed included. Retaining finished jobs therefore made a
 * thread answer once and then go deaf, with no error anywhere.
 */
import { agentTurns, scheduleAgentTurn, agentTurnJobId, closeQueues } from "@/lib/queue";
import { redis } from "@/lib/redis";

const CONVO = "__debounce_probe_conversation";
let pass = 0, fail = 0;
function check(l: string, ok: boolean, d?: string) {
  console.log(ok ? `  ✓ ${l}` : `  ✗ ${l}${d ? ` — ${d}` : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  const q = agentTurns();
  const id = agentTurnJobId(CONVO);
  await (await q.getJob(id))?.remove().catch(() => {});

  const job = { tenantId: "t", conversationId: CONVO, customerId: "c" };

  await scheduleAgentTurn(job);
  check("first message queues a turn", (await q.getJob(id)) !== undefined);

  // A second message while the first is still pending must re-arm, not duplicate.
  await scheduleAgentTurn(job);
  const delayed = await q.getDelayed();
  check(
    "a second message re-arms rather than duplicating",
    delayed.filter((j) => j.id === id).length === 1,
    `${delayed.filter((j) => j.id === id).length} copies`,
  );

  // Simulate the turn having run: remove it as a completed job would be.
  await (await q.getJob(id))!.remove();

  // THE REGRESSION: a message arriving after a completed turn must queue again.
  await scheduleAgentTurn(job);
  const after = await q.getJob(id);
  check("a message after a finished turn queues another", after !== undefined);
  check("and it carries the right conversation", after?.data?.conversationId === CONVO);

  await after?.remove().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().finally(async () => { await closeQueues(); redis.disconnect(); });
