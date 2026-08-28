/**
 * Proves the WhatsApp inbound path against the running server.
 *
 * Everything up to "a turn is queued" is verifiable without Meta: we sign
 * payloads with the account's own app secret exactly as Meta would. The only
 * untestable part here is the outbound send, which needs real credentials.
 *
 * Requires: npm run dev  (on PORT, default 3111)
 * Run:      npm run prove:webhook
 */
import { createHmac } from "node:crypto";
import { adminDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { agentTurnJobId, agentTurns, closeQueues, DEBOUNCE_MS } from "@/lib/queue";

const BASE = process.env.CADENCE_TEST_URL ?? "http://localhost:3111";
const PHONE_NUMBER_ID = "test_pnid_00001";
const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const CUSTOMER = "447700900555";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function metaPayload(text: string, messageId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "441234567890", phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Test Customer" }, wa_id: CUSTOMER }],
              messages: [
                {
                  from: CUSTOMER,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function post(body: unknown, opts: { sign?: boolean; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) {
    const secret = opts.secret ?? APP_SECRET;
    headers["x-hub-signature-256"] =
      "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  }
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, { method: "POST", headers, body: raw });
  return { status: res.status, text: await res.text() };
}

const queuedFor = async (conversationId: string) =>
  (await agentTurns().getJob(agentTurnJobId(conversationId))) ?? null;

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "demo-studio" } });
  const t = tenant.id;

  // Fresh state.
  await adminDb.channelAccount.deleteMany({ where: { tenantId: t } });
  await adminDb.conversationMessage.deleteMany({ where: { tenantId: t } });
  await adminDb.conversation.deleteMany({ where: { tenantId: t } });
  await adminDb.customer.deleteMany({ where: { tenantId: t, phone: `+${CUSTOMER}` } });
  const stale = await agentTurns().getJobs(["delayed", "waiting"]);
  await Promise.all(stale.map((j) => j.remove().catch(() => {})));

  await adminDb.channelAccount.create({
    data: {
      tenantId: t,
      channel: "whatsapp",
      externalAccountId: PHONE_NUMBER_ID,
      displayNumber: "+441234567890",
      accessToken: "test-token-not-used-inbound",
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
    },
  });

  // ── 1. Subscription handshake ───────────────────────────────────────
  console.log("\n1. Subscription handshake");
  const good = await fetch(
    `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`,
  );
  check("correct verify token echoes the challenge", (await good.text()) === "abc123");
  const bad = await fetch(
    `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`,
  );
  check("wrong verify token is refused", bad.status === 403, String(bad.status));

  // ── 2. Signature verification ───────────────────────────────────────
  console.log("\n2. Signature verification");
  const forged = await post(metaPayload("forged", "wamid.forged"), { secret: "wrong-secret" });
  check("a payload signed with the wrong secret is rejected", forged.status === 401);
  const unsigned = await post(metaPayload("unsigned", "wamid.unsigned"), { sign: false });
  check("an unsigned payload is rejected", unsigned.status === 401);
  const notStored = await adminDb.conversationMessage.count({ where: { tenantId: t } });
  check("and neither was recorded", notStored === 0, `${notStored} rows`);

  // ── 3. A genuine message ────────────────────────────────────────────
  console.log("\n3. A genuine message");
  const first = await post(metaPayload("hi, are you open monday?", "wamid.001"));
  check("returns 200", first.status === 200, String(first.status));

  const convo = await adminDb.conversation.findFirst({
    where: { tenantId: t, externalThreadId: CUSTOMER },
  });
  check("a conversation was opened", Boolean(convo));
  const customer = convo
    ? await adminDb.customer.findUnique({ where: { id: convo.customerId } })
    : null;
  check("an unknown number auto-created a customer", customer?.phone === `+${CUSTOMER}`);
  check("the profile name was captured", customer?.name === "Test Customer");

  const stored = await adminDb.conversationMessage.findMany({
    where: { tenantId: t, direction: "inbound" },
  });
  check("the message was recorded once", stored.length === 1, `${stored.length}`);
  check("with the provider's message id", stored[0]?.externalId === "wamid.001");
  check("a turn was queued", Boolean(convo && (await queuedFor(convo.id))));

  // ── 4. Redelivery ───────────────────────────────────────────────────
  console.log("\n4. Redelivery of the same message");
  const replay = await post(metaPayload("hi, are you open monday?", "wamid.001"));
  check("still returns 200", replay.status === 200);
  const afterReplay = await adminDb.conversationMessage.count({
    where: { tenantId: t, direction: "inbound" },
  });
  check("the duplicate was not recorded again", afterReplay === 1, `${afterReplay} rows`);

  // ── 5. Debounce ─────────────────────────────────────────────────────
  console.log("\n5. A burst of messages becomes ONE turn");
  await post(metaPayload("actually", "wamid.002"));
  await post(metaPayload("make it tuesday", "wamid.003"));
  await post(metaPayload("morning if possible", "wamid.004"));

  const queued = await agentTurns().getJobs(["delayed", "waiting"]);
  const mine = queued.filter((j) => j.data?.conversationId === convo?.id);
  check(`three more messages left one queued turn, not three`, mine.length === 1, `${mine.length}`);

  const allStored = await adminDb.conversationMessage.count({
    where: { tenantId: t, direction: "inbound" },
  });
  check("but all four messages are in the transcript", allStored === 4, `${allStored}`);

  const delay = mine[0] ? (await mine[0].getState()) : "none";
  check("and the turn is still delayed, not yet running", delay === "delayed", delay);

  // ── 6. Human takeover ───────────────────────────────────────────────
  console.log("\n6. A thread a colleague owns gets no automated reply");
  await Promise.all(mine.map((j) => j.remove()));
  await adminDb.conversation.update({
    where: { id: convo!.id },
    data: { botPaused: true, botPausedAt: new Date() },
  });

  const whilePaused = await post(metaPayload("are you still there?", "wamid.005"));
  check("the message is still accepted", whilePaused.status === 200);
  const pausedStored = await adminDb.conversationMessage.count({
    where: { tenantId: t, direction: "inbound" },
  });
  check("and still recorded, so the colleague can see it", pausedStored === 5, `${pausedStored}`);
  check("but NO turn was queued", (await queuedFor(convo!.id)) === null);

  // ── 7. Unknown account ──────────────────────────────────────────────
  console.log("\n7. Traffic for a number we do not host");
  const foreign = JSON.parse(JSON.stringify(metaPayload("hello", "wamid.006")));
  foreign.entry[0].changes[0].value.metadata.phone_number_id = "not_our_number";
  const foreignRes = await post(foreign);
  check("is accepted with 200 rather than retried forever", foreignRes.status === 200);
  const leaked = await adminDb.conversationMessage.count({ where: { tenantId: t } });
  check("and nothing was written to our tenant", leaked === 5, `${leaked}`);

  // Clean up.
  await adminDb.channelAccount.deleteMany({ where: { tenantId: t } });
  await adminDb.conversationMessage.deleteMany({ where: { tenantId: t } });
  await adminDb.conversation.deleteMany({ where: { tenantId: t } });
  await adminDb.customer.deleteMany({ where: { tenantId: t, phone: `+${CUSTOMER}` } });
  const left = await agentTurns().getJobs(["delayed", "waiting"]);
  await Promise.all(left.map((j) => j.remove().catch(() => {})));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`(debounce window is ${DEBOUNCE_MS}ms)\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await adminDb.$disconnect();
    redis.disconnect();
  });
