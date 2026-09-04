/**
 * Executable proof of the conversation layer's guarantees — WITHOUT calling a model.
 *
 * The tools are the dangerous part: they read a customer's data, quote prices,
 * and can double-book a room. The model is the easy part. Every tool exposes a
 * plain `run()`, so all of this is verifiable deterministically, for free, and
 * in CI — no API key, no token spend, no flakiness from sampling.
 *
 * Run: npx dotenv -e .env.local -- npx tsx scripts/proveConversation.ts
 */
import { adminDb, withTenant, type TenantDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { getSnapshot, invalidateSnapshot } from "@/lib/conversation/snapshot";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import {
  openThread,
  recordInbound,
  recordOutbound,
  loadTranscript,
  COLLEAGUE_PREFIX,
} from "@/lib/conversation/thread";
import { systemPrompt } from "@/lib/conversation/agent";
import { buildKnowledgeContext } from "@/lib/knowledge";
import { localToInstant } from "@/lib/engine/time";

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

type Tool = { name: string; run: (input: unknown) => Promise<string> };

function tool(tools: unknown[], name: string): Tool {
  const t = (tools as Tool[]).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}
const has = (tools: unknown[], name: string) => (tools as Tool[]).some((t) => t.name === name);
const call = async (t: Tool, input: unknown) => JSON.parse(await t.run(input));

function nextWeekday(w: number, min = 3) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + min);
  while (d.getUTCDay() !== w) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function makeCtx(
  db: TenantDb,
  tenantId: string,
  conversationId: string,
  customerId: string,
): Promise<{ ctx: ToolContext; tools: unknown[] }> {
  await invalidateSnapshot(conversationId);
  const caps = await resolveCapabilities(db, tenantId);
  const snapshot = await getSnapshot(db, caps, { tenantId, conversationId, customerId });
  const ctx: ToolContext = {
    db,
    caps,
    snapshot,
    knowledge: await buildKnowledgeContext(db, tenantId),
    tenantId,
    conversationId,
    customerId,
    outcome: { escalated: false, escalationReasons: [], bookingIds: [], sources: [] },
  };
  return { ctx, tools: buildTools(ctx) };
}

/**
 * What the agent is told about a colleague's replies.
 *
 * The bug this pins down: every outbound message used to become an `assistant`
 * turn regardless of who wrote it, so a colleague's promise read back to the
 * model as its own. It would then defend a commitment it never made, and had no
 * way to tell "I offered this" from "a person offered this".
 */
async function proveHandoverTranscript(t: string) {
  console.log("\nWhat the agent reads after a colleague replies");

  const customer = await adminDb.customer.findFirstOrThrow({ where: { tenantId: t } });

  // Cleared up front, not only afterwards. A run that fails partway leaves the
  // probe thread behind, and the next run then appends to it and reads a
  // transcript with two of everything in it.
  await adminDb.conversationMessage.deleteMany({
    where: { conversation: { externalThreadId: "__handover_probe" } },
  });
  await adminDb.conversation.deleteMany({ where: { externalThreadId: "__handover_probe" } });

  const thread = await withTenant(t, (db) =>
    openThread(db, {
      tenantId: t,
      channel: "web",
      externalThreadId: "__handover_probe",
      identity: { phone: customer.phone ?? "+000000000000" },
    }),
  );
  const conversationId = thread.conversationId;

  await withTenant(t, async (db) => {
    await recordInbound(db, { tenantId: t, conversationId, body: "is parking free?" });
    await recordOutbound(db, {
      tenantId: t,
      conversationId,
      body: "Let me check that for you.",
      author: "agent",
    });
    await recordOutbound(db, {
      tenantId: t,
      conversationId,
      body: "Parking is free, and I'll waive your consultation fee.",
      author: "human",
    });
    await recordInbound(db, { tenantId: t, conversationId, body: "great, thanks" });
  });

  const transcript = await withTenant(t, (db) =>
    loadTranscript(db, { tenantId: t, conversationId }),
  );

  const outbound = transcript.find((m) => m.content.includes("waive your consultation fee"));
  check("the colleague's message reaches the agent at all", Boolean(outbound));

  // The mark sits immediately before the colleague's words. Asserted on the
  // adjacency rather than on the start of the turn, because the agent's own
  // reply and the colleague's are merged into a single assistant turn — which
  // is exactly why an inline mark is needed instead of a per-turn one.
  check(
    "and is marked as theirs, not passed off as the agent's own words",
    outbound?.content.includes(`${COLLEAGUE_PREFIX}Parking is free`) === true,
    outbound?.content.replace(/\n/g, " ⏎ ").slice(0, 80),
  );
  check(
    "while the agent's own sentence is not marked",
    outbound?.content.includes(`${COLLEAGUE_PREFIX}Let me check`) === false,
  );

  // Two outbound messages in a row is the normal shape here — agent replies,
  // colleague adds something — so the turns must still alternate.
  const runs = transcript.filter((m, i) => i > 0 && transcript[i - 1].role === m.role);
  check("consecutive same-role turns are merged", runs.length === 0, `${runs.length} run(s)`);
  check(
    "and merging kept both outbound messages",
    transcript.some(
      (m) => m.content.includes("Let me check that") && m.content.includes("waive your consultation fee"),
    ),
  );

  // The prompt has to explain the marker, or it is noise the model invents a
  // meaning for.
  const prompt = systemPrompt(
    { name: "Probe", timezone: "UTC", descriptor: null, toneNote: null, escalationTopics: [] },
    ["catalog"],
    { mode: "empty" },
    { degraded: false },
  )
    .map((b) => b.text)
    .join("\n");
  check("the system prompt explains what the mark means", prompt.includes(COLLEAGUE_PREFIX.trim()));

  await adminDb.conversationMessage.deleteMany({ where: { conversationId } });
  await adminDb.conversation.delete({ where: { id: conversationId } });
}

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "demo-studio" } });
  const t = tenant.id;
  const london = await adminDb.location.findFirstOrThrow({ where: { tenantId: t, code: "LDN" } });
  const session = await adminDb.service.findFirstOrThrow({
    where: { tenantId: t, name: "Studio Session" },
  });
  const consult = await adminDb.service.findFirstOrThrow({
    where: { tenantId: t, name: "Consultation" },
  });
  const types = await adminDb.exceptionType.findMany({ where: { tenantId: t } });
  const byCode = Object.fromEntries(types.map((x) => [x.code, x]));

  // Clean slate.
  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });
  await adminDb.bookingResource.deleteMany({ where: { tenantId: t } });
  await adminDb.booking.deleteMany({ where: { tenantId: t } });
  await adminDb.conversationMessage.deleteMany({ where: { tenantId: t } });
  await adminDb.conversation.deleteMany({ where: { tenantId: t } });
  await adminDb.service.update({
    where: { id: consult.id },
    data: { priceQuotable: true, priceMinor: 4000 },
  });

  const day = nextWeekday(1);
  const from = localToInstant(day, "00:00", "Europe/London")!;
  const to = localToInstant(day, "23:59", "Europe/London")!;

  // A thread to hang everything off.
  const thread = await withTenant(t, async (db) => {
    const ref = await openThread(db, {
      tenantId: t,
      channel: "whatsapp",
      externalThreadId: "+447700900123",
      identity: { phone: "+447700900123", name: "Jordan Reed" },
    });
    await recordInbound(db, {
      tenantId: t,
      conversationId: ref.conversationId,
      body: "hi, can I book a studio session monday morning?",
    });
    return ref;
  });
  check("thread opened and inbound recorded", Boolean(thread.conversationId));

  // ────────────────────────────────────────────────────────────────────
  console.log("\n1. The toolset is assembled from capabilities");
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const names = (tools as Tool[]).map((x) => x.name).sort();
    check(`built ${names.length} tools`, names.length > 0, names.join(", "));
    check("booking tools present while booking_write is granted", has(tools, "hold_slot"));
    check("escalation is always available", has(tools, "escalate_to_human"));
  });

  await adminDb.tenantCapability.deleteMany({
    where: { tenantId: t, capability: "booking_write" },
  });
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    check(
      "revoking booking_write REMOVES the booking tools",
      !has(tools, "hold_slot") && !has(tools, "confirm_booking") && !has(tools, "cancel_booking"),
    );
    check("read-only tools survive", has(tools, "check_availability"));
    check("escalation still available", has(tools, "escalate_to_human"));
  });
  await adminDb.tenantCapability.create({
    data: { tenantId: t, capability: "booking_write", mode: "hosted", snapshotTtlSeconds: 60 },
  });

  // ────────────────────────────────────────────────────────────────────
  console.log("\n2. A non-quotable price never reaches the model");
  await adminDb.service.update({ where: { id: consult.id }, data: { priceQuotable: false } });
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "list_services"), {});
    const row = out.services.find((s: { id: string }) => s.id === consult.id);
    check("service is still listed", Boolean(row));
    check("but its price is withheld", row.price === null, JSON.stringify(row?.price));
    check(
      "and the amount appears nowhere in the payload",
      !JSON.stringify(out).includes("40"),
      "found the figure in the tool output",
    );
  });
  await adminDb.service.update({ where: { id: consult.id }, data: { priceQuotable: true } });

  // ────────────────────────────────────────────────────────────────────
  console.log("\n3. Closure explains itself without leaking the internal reason");
  await adminDb.scheduleException.create({
    data: {
      tenantId: t,
      typeId: byCode.closure.id,
      locationId: london.id,
      startsAt: from,
      endsAt: to,
      internalReason: "flooded, insurers involved",
    },
  });
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "check_availability"), {
      serviceId: session.id,
      locationId: london.id,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    check("availability reports failure", out.ok === false);
    check("with the typed reason 'closed'", out.reason === "closed", out.reason);
    check("using the tenant's approved wording", out.message === "We're closed that day.");
    check(
      "and the internal reason is absent",
      !JSON.stringify(out).toLowerCase().includes("flood"),
    );
  });
  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });

  // ────────────────────────────────────────────────────────────────────
  console.log("\n4. Holding is live, and losing carries alternatives");
  const target = localToInstant(day, "09:00", "Europe/London")!;
  let holdId = "";
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "hold_slot"), {
      serviceId: session.id,
      locationId: london.id,
      startsAt: target.toISOString(),
    });
    check("hold succeeds", out.ok === true, JSON.stringify(out).slice(0, 120));
    holdId = out.holdId;
    check("and returns a pre-formatted local label", typeof out.label === "string" && out.label.length > 0, out.label);
  });

  // The customer who is ALREADY holding this slot asks for it again — which is
  // what happens every time the agent re-checks before confirming. It must get
  // its own hold back. This assertion used to require the opposite, and that is
  // the shape the bug arrived in: the assistant held 12:30, the customer said
  // yes, and it announced the slot had gone. Nobody else had it. It did.
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "hold_slot"), {
      serviceId: session.id,
      locationId: london.id,
      startsAt: target.toISOString(),
    });
    check("re-holding your own slot succeeds", out.ok === true, JSON.stringify(out).slice(0, 120));
    check("and hands back the same hold, not a second one", out.holdId === holdId);
  });

  // Somebody else asking for it is a real collision, and must still be one.
  const rival = await withTenant(t, (db) =>
    openThread(db, {
      tenantId: t,
      channel: "whatsapp",
      externalThreadId: "+447700900999",
      identity: { phone: "+447700900999", name: "Someone Else" },
    }),
  );
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, rival.conversationId, rival.customerId);
    const out = await call(tool(tools, "hold_slot"), {
      serviceId: session.id,
      locationId: london.id,
      startsAt: target.toISOString(),
    });
    check("another customer's hold on the same slot still fails", out.ok === false);
    check("it is marked recoverable", out.recoverable === true);
    const alts = out.details?.alternatives ?? [];
    check(
      `and carries alternatives (${alts.length})`,
      alts.length > 0,
      "an agent with no alternatives can only apologise",
    );
  });

  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "confirm_booking"), { holdId });
    check("confirming the hold books it", out.ok === true && out.status === "scheduled");
  });

  // ────────────────────────────────────────────────────────────────────
  console.log("\n5. An opted-out customer is refused before anything happens");
  await adminDb.customer.update({ where: { id: thread.customerId }, data: { optedOut: true } });
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "hold_slot"), {
      serviceId: session.id,
      locationId: london.id,
      startsAt: localToInstant(day, "14:00", "Europe/London")!.toISOString(),
    });
    check("hold is refused", out.ok === false, JSON.stringify(out).slice(0, 100));
    check("with 'forbidden'", out.reason === "forbidden", out.reason);
  });
  await adminDb.customer.update({ where: { id: thread.customerId }, data: { optedOut: false } });

  // ────────────────────────────────────────────────────────────────────
  console.log("\n6. Brokered writes refuse rather than writing locally");
  await adminDb.tenantCapability.update({
    where: { tenantId_capability: { tenantId: t, capability: "booking_write" } },
    data: { mode: "brokered", connector: "some-crm" },
  });
  await withTenant(t, async (db) => {
    const { tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    check("the booking tool still exists", has(tools, "hold_slot"));
    const out = await call(tool(tools, "hold_slot"), {
      serviceId: session.id,
      locationId: london.id,
      startsAt: localToInstant(day, "15:00", "Europe/London")!.toISOString(),
    });
    check("but refuses to write to our own tables", out.ok === false);
    check("with 'capability_unavailable'", out.reason === "capability_unavailable", out.reason);
  });
  const localBookings = await adminDb.booking.count({
    where: { tenantId: t, startsAt: localToInstant(day, "15:00", "Europe/London")! },
  });
  check("and no local booking was created", localBookings === 0);
  await adminDb.tenantCapability.update({
    where: { tenantId_capability: { tenantId: t, capability: "booking_write" } },
    data: { mode: "hosted", connector: null },
  });

  // ────────────────────────────────────────────────────────────────────
  console.log("\n7. Escalation actually silences the bot");
  await withTenant(t, async (db) => {
    const { ctx, tools } = await makeCtx(db, t, thread.conversationId, thread.customerId);
    const out = await call(tool(tools, "escalate_to_human"), {
      reasons: ["price_negotiation"],
      note: "Wants a discount on a package.",
    });
    check("escalation reports success", out.ok === true);
    check("the turn is flagged escalated", ctx.outcome.escalated === true);
    check("and the model is told to stop", String(out.instruction).includes("stop"));
  });
  const convo = await adminDb.conversation.findUniqueOrThrow({
    where: { id: thread.conversationId },
  });
  check("botPaused is persisted, not just in memory", convo.botPaused === true);

  // Leave it clean.
  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });
  await adminDb.bookingResource.deleteMany({ where: { tenantId: t } });
  await adminDb.booking.deleteMany({ where: { tenantId: t } });
  await adminDb.conversationMessage.deleteMany({ where: { tenantId: t } });
  await adminDb.conversation.deleteMany({ where: { tenantId: t } });

  await proveHandoverTranscript(t);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    // Both connections must be closed or the process hangs: ioredis keeps the
    // event loop alive indefinitely. The same applies to any worker or script
    // that touches the snapshot layer.
    await adminDb.$disconnect();
    redis.disconnect();
  });
