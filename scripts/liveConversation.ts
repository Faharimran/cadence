/**
 * Drives a real conversation against the live model, end to end.
 *
 * Unlike proveConversation.ts — which verifies the tools deterministically and
 * for free — this one costs tokens and is non-deterministic, so it is a manual
 * smoke test rather than something to run in CI. What it proves is the part the
 * cheap harness cannot: that the model, given these tools and this prompt,
 * actually resolves "monday morning" to an instant, holds before promising, and
 * hands over instead of negotiating.
 *
 * Run: npm run live:conversation
 */
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { isAgentConfigured, runAgentTurn } from "@/lib/conversation/agent";
import { openThread, recordInbound } from "@/lib/conversation/thread";

const CUSTOMER_SAYS = [
  "hi! do you have anything free monday morning for a studio session?",
  "9am is perfect, please book that for me",
  "great. actually — any chance of a discount if I book three of them?",
];

async function main() {
  if (!isAgentConfigured()) {
    console.error("ANTHROPIC_API_KEY is not set — nothing to test.");
    process.exit(1);
  }

  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "demo-studio" } });
  const t = tenant.id;

  // Fresh thread each run so the transcript is readable.
  await adminDb.conversationMessage.deleteMany({ where: { tenantId: t } });
  await adminDb.conversation.deleteMany({ where: { tenantId: t } });
  await adminDb.bookingResource.deleteMany({ where: { tenantId: t } });
  await adminDb.booking.deleteMany({ where: { tenantId: t } });
  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });

  const thread = await withTenant(t, (db) =>
    openThread(db, {
      tenantId: t,
      channel: "whatsapp",
      externalThreadId: "+447700900999",
      identity: { phone: "+447700900999", name: "Jordan Reed" },
    }),
  );

  console.log(`\n${"─".repeat(72)}`);
  console.log(`${tenant.name} · ${tenant.timezone} · thread ${thread.conversationId.slice(-6)}`);
  console.log("─".repeat(72));

  let totalIn = 0;
  let totalOut = 0;

  for (const text of CUSTOMER_SAYS) {
    // A paused thread must never reach the agent — that is the human-takeover
    // guarantee, and it applies to this harness exactly as it does in production.
    const state = await adminDb.conversation.findUniqueOrThrow({
      where: { id: thread.conversationId },
    });
    if (state.botPaused) {
      console.log(`\n  customer  ${text}`);
      console.log(`  (bot is paused — a human owns this thread; nothing sent)`);
      break;
    }

    console.log(`\n  customer  ${text}`);

    await withTenant(t, (db) =>
      recordInbound(db, { tenantId: t, conversationId: thread.conversationId, body: text }),
    );

    const started = Date.now();
    const turn = await withTenant(
      t,
      (db) =>
        runAgentTurn(db, {
          tenantId: t,
          conversationId: thread.conversationId,
          customerId: thread.customerId,
        }),
      // The agent turn makes several model round-trips inside one transaction,
      // so it needs far longer than the default.
      { timeoutMs: 180_000 },
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    for (const c of turn.toolCalls) {
      console.log(`     tool   ${c.name}(${summarise(c.input)})`);
    }
    console.log(`     agent  ${turn.reply ?? "(no reply)"}`);
    console.log(
      `            ${elapsed}s · ${turn.usage?.input ?? 0} in / ${turn.usage?.output ?? 0} out` +
        (turn.escalated ? ` · ESCALATED (${turn.escalationReasons.join(", ")})` : ""),
    );
    totalIn += turn.usage?.input ?? 0;
    totalOut += turn.usage?.output ?? 0;
  }

  // ── What actually landed in the database ────────────────────────────
  console.log(`\n${"─".repeat(72)}`);
  const bookings = await adminDb.booking.findMany({
    where: { tenantId: t },
    include: { service: true, location: true, resources: { include: { resource: true } } },
  });
  console.log(`bookings created: ${bookings.length}`);
  for (const b of bookings) {
    console.log(
      `  ${b.status.padEnd(10)} ${b.startsAt.toISOString()}  ${b.service.name}` +
        `  @ ${b.location.name}  with ${b.resources.map((r) => r.resource.name).join(" + ")}`,
    );
  }

  const convo = await adminDb.conversation.findUniqueOrThrow({
    where: { id: thread.conversationId },
  });
  console.log(`bot paused:       ${convo.botPaused}`);

  const audited = await adminDb.conversationMessage.count({
    where: { conversationId: thread.conversationId, direction: "outbound", snapshotAt: { not: null } },
  });
  console.log(`replies with snapshot provenance recorded: ${audited}`);
  console.log(`tokens: ${totalIn} in / ${totalOut} out`);
  console.log("─".repeat(72));
}

function summarise(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 28 ? `${s.slice(0, 28)}…` : s}`;
    })
    .join(", ");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
