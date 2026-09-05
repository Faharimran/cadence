/**
 * What one conversation actually costs, measured rather than estimated.
 *
 * Builds the real system prompt and the real toolset for a real tenant, asks
 * the API to count the tokens, and prices a turn under every model and effort
 * we offer. No sampling, no guessing at prompt size — the thing being counted is
 * the thing that gets sent.
 *
 * Prices below are per million tokens, from the published table. Cache reads are
 * a tenth of the input price and cache writes are 1.25×, which is the whole
 * reason the system prompt is split the way it is: get that split wrong and the
 * largest part of the prompt is re-billed at full price on every message.
 *
 * Run: npm run cost
 *      railway ssh --service cadence-worker 'npx tsx scripts/costReport.ts'
 */
import Anthropic from "@anthropic-ai/sdk";
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { env } from "@/lib/env";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { getSnapshot } from "@/lib/conversation/snapshot";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import { systemPrompt } from "@/lib/conversation/agent";
import { buildKnowledgeContext } from "@/lib/knowledge";
import { MODELS } from "@/lib/conversation/models";

/** USD per million tokens. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const CACHE_READ = 0.1; // ×input
const WRITE_5MIN = 1.25; // ×input
const WRITE_1HOUR = 2.0; // ×input

/**
 * How long a customer takes to reply.
 *
 * This is the number that decides whether the cache TTL matters, and leaving it
 * out is how the first version of this report managed to make a real saving look
 * like a loss: it charged one cache write under both TTLs, which prices the
 * one-hour entry at its higher rate while crediting it for none of the rewrites
 * it exists to avoid.
 *
 * Four minutes is being kind to the five-minute default. People read a reply,
 * think, ask whoever they are booking for, and answer — on WhatsApp that is
 * minutes, not seconds, which is exactly the window the default TTL falls
 * inside.
 */
const MINUTES_BETWEEN_MESSAGES = 4;

/** How many times the cacheable block gets written, at a given TTL. */
function cacheWrites(ttlMinutes: number): number {
  const spanMinutes = (TURNS_PER_CONVERSATION - 1) * MINUTES_BETWEEN_MESSAGES;
  // The first message always writes; after that, one more write per expiry.
  return 1 + Math.floor(spanMinutes / ttlMinutes);
}

const SLUG = process.env.CADENCE_TENANT ?? "cara-clinic";

/**
 * What a conversation looks like, so the arithmetic is about something.
 *
 * Six inbound messages is a booking that went smoothly: greeting, what do you
 * do, how much, when can I come, yes to a time, thanks. Round trips are what
 * actually costs money — a turn that calls two tools is three requests, each
 * re-sending the entire prompt.
 */
const TURNS_PER_CONVERSATION = 6;
/**
 * Was 2.5, when the catalogue had to be fetched with `list_services` before the
 * assistant could say what anything cost. It is now in the cached prompt, so the
 * commonest question in the whole product — "what do you do and how much" —
 * costs one call rather than two.
 */
const ROUNDTRIPS_PER_TURN = 1.6;
const OUTPUT_TOKENS_PER_ROUNDTRIP = 180;

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: SLUG } });

  const { system, tools, transcriptSample } = await withTenant(tenant.id, async (db) => {
    const caps = await resolveCapabilities(db, tenant.id);
    const conversation = await db.conversation.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { updatedAt: "desc" },
    });
    if (!conversation) throw new Error("No conversation on this tenant to measure against.");

    const snapshot = await getSnapshot(db, caps, {
      tenantId: tenant.id,
      conversationId: conversation.id,
      customerId: conversation.customerId!,
    });
    const knowledge = caps.has("knowledge")
      ? await buildKnowledgeContext(db, tenant.id)
      : ({ mode: "empty" } as const);

    const ctx: ToolContext = {
      db,
      caps,
      snapshot,
      knowledge,
      outcome: { escalated: false, escalationReasons: [], bookingIds: [], sources: [] },
      tenantId: tenant.id,
      conversationId: conversation.id,
      customerId: conversation.customerId!,
    };

    return {
      system: systemPrompt(tenant, caps.list(), knowledge, snapshot),
      tools: buildTools(ctx),
      transcriptSample: [
        { role: "user" as const, content: "hi, do you do PRP? and how much is it" },
      ],
    };
  });

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY!,
    ...(env.ANTHROPIC_WORKSPACE_ID
      ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
      : {}),
  });

  // Counted three ways, because the interesting number is not the total — it is
  // how much of the total is the CACHEABLE part.
  const countWith = async (opts: { withTools: boolean; withSystem: boolean }) => {
    const res = await client.messages.countTokens({
      model: "claude-opus-5",
      ...(opts.withSystem ? { system } : {}),
      ...(opts.withTools ? { tools: tools as never } : {}),
      messages: transcriptSample,
    });
    return res.input_tokens;
  };

  const bare = await countWith({ withTools: false, withSystem: false });
  const withSystem = await countWith({ withTools: false, withSystem: true });
  const full = await countWith({ withTools: true, withSystem: true });

  const systemTokens = withSystem - bare;
  const toolTokens = full - withSystem;

  // Block 1 is the cached one: identity, capabilities, knowledge, the rules.
  // Block 2 is the clock and the degraded flag, which change every turn.
  const stableChars = system[0]?.text.length ?? 0;
  const volatileChars = system[1]?.text.length ?? 0;
  const cachedShare = stableChars / Math.max(1, stableChars + volatileChars);
  const cachedTokens = Math.round((systemTokens + toolTokens) * cachedShare);
  const uncachedTokens = systemTokens + toolTokens - cachedTokens;

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${tenant.name} — what a conversation costs`);
  console.log("═".repeat(72));

  // Where the prompt actually goes, section by section.
  //
  // Without this, trimming is guesswork, and guesswork here removes the rules
  // that stop a price being invented rather than the paragraph nobody reads.
  // Sections are split on the markdown headings the prompt is written with.
  const sections: { name: string; chars: number }[] = [];
  for (const block of system) {
    const parts = block.text.split(/\n(?=## )/);
    for (const part of parts) {
      const name = part.startsWith("## ")
        ? part.slice(3, part.indexOf("\n") === -1 ? undefined : part.indexOf("\n")).trim()
        : "(opening)";
      sections.push({ name, chars: part.length });
    }
  }
  sections.sort((a, b) => b.chars - a.chars);

  const totalChars = sections.reduce((n, s) => n + s.chars, 0);
  console.log(`\nWhere the system prompt goes (${totalChars.toLocaleString()} chars):`);
  for (const s of sections) {
    const share = Math.round((s.chars / totalChars) * 100);
    const bar = "█".repeat(Math.max(1, Math.round(share / 2)));
    console.log(
      `  ${s.name.slice(0, 34).padEnd(35)} ${String(s.chars).padStart(6)}  ${String(share).padStart(2)}%  ${bar}`,
    );
  }

  // Tool schemas are re-read on every round trip too, and are easy to forget
  // because nobody writes them as prose.
  console.log(`\nTool schemas, largest first:`);
  const toolSizes = (tools as { name: string; description?: string; input_schema?: unknown }[])
    .map((t) => ({
      name: t.name,
      chars: JSON.stringify(t).length,
      desc: (t.description ?? "").length,
    }))
    .sort((a, b) => b.chars - a.chars);
  for (const t of toolSizes) {
    console.log(
      `  ${t.name.padEnd(24)} ${String(t.chars).padStart(6)} chars  (description ${t.desc})`,
    );
  }

  console.log(`\nPrompt, measured:`);
  console.log(`  system prompt          ${systemTokens.toLocaleString().padStart(8)} tokens`);
  console.log(`    · cacheable block     ${stableChars.toLocaleString().padStart(8)} chars`);
  console.log(`    · per-turn block      ${volatileChars.toLocaleString().padStart(8)} chars`);
  console.log(`  tool definitions       ${toolTokens.toLocaleString().padStart(8)} tokens  (${tools.length} tools)`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  sent every round trip  ${(systemTokens + toolTokens).toLocaleString().padStart(8)} tokens`);
  console.log(`    of which cacheable   ${cachedTokens.toLocaleString().padStart(8)} tokens (${Math.round(cachedShare * 100)}%)`);

  const roundTripsPerConversation = TURNS_PER_CONVERSATION * ROUNDTRIPS_PER_TURN;
  console.log(
    `\nAssumed shape: ${TURNS_PER_CONVERSATION} customer messages × ${ROUNDTRIPS_PER_TURN} round trips = ${roundTripsPerConversation} API calls`,
  );

  console.log(`\n${"─".repeat(72)}`);
  console.log(
    "  model            effort   per conv    per 20k conv    vs Zinq (₹30k)",
  );
  console.log("─".repeat(72));

  for (const m of MODELS) {
    const price = PRICING[m.id];
    if (!price) continue;

    for (const effort of m.supportsEffort ? ["low", "medium", "high"] : ["—"]) {
      // Effort changes how much the model thinks, which is output tokens.
      const outputMultiplier = effort === "low" ? 0.6 : effort === "high" ? 2.2 : 1;
      const outTokens = OUTPUT_TOKENS_PER_ROUNDTRIP * outputMultiplier;

      const writes = cacheWrites(60);
      const writeCost = ((cachedTokens * writes) / 1e6) * price.input * WRITE_1HOUR;
      const readCost =
        ((cachedTokens * (roundTripsPerConversation - writes)) / 1e6) * price.input * CACHE_READ;
      const freshCost = ((uncachedTokens * roundTripsPerConversation) / 1e6) * price.input;
      const outCost = ((outTokens * roundTripsPerConversation) / 1e6) * price.output;

      const perConversation = writeCost + readCost + freshCost + outCost;
      const per20k = perConversation * 20_000;
      // ₹30,000 at roughly ₹88 to the dollar.
      const zinq = 30_000 / 88;
      const ratio = zinq / per20k;

      console.log(
        `  ${m.id.padEnd(18)} ${effort.padEnd(7)} ${usd(perConversation).padStart(9)}` +
          `  ${("$" + Math.round(per20k).toLocaleString()).padStart(12)}` +
          `    ${ratio >= 1 ? `${ratio.toFixed(1)}× cheaper` : `${(1 / ratio).toFixed(1)}× DEARER`}`,
      );
    }
  }

  console.log("─".repeat(72));
  console.log(`  Zinq.ai reference: ₹30,000 ≈ $${Math.round(30_000 / 88)} for 20,000 conversations`);
  console.log(`  (that is $${(30_000 / 88 / 20_000).toFixed(4)} per conversation)`);
  console.log("═".repeat(72));

  // The two levers, priced against each other rather than asserted.
  const opus = PRICING["claude-opus-5"];
  const inputCost = (writes: number, writeRate: number) =>
    ((cachedTokens * writes) / 1e6) * opus.input * writeRate +
    ((cachedTokens * (roundTripsPerConversation - writes)) / 1e6) * opus.input * CACHE_READ +
    ((uncachedTokens * roundTripsPerConversation) / 1e6) * opus.input;

  const noCache = ((cachedTokens + uncachedTokens) / 1e6) * opus.input * roundTripsPerConversation;
  const fiveMin = inputCost(cacheWrites(5), WRITE_5MIN);
  const oneHour = inputCost(cacheWrites(60), WRITE_1HOUR);

  console.log(
    `\nInput cost per conversation on Opus, at ${MINUTES_BETWEEN_MESSAGES} minutes between messages:`,
  );
  console.log(`  no caching at all           ${usd(noCache)}`);
  console.log(
    `  5-minute cache (default)    ${usd(fiveMin)}   ${cacheWrites(5)} writes — it expires mid-conversation`,
  );
  console.log(
    `  1-hour cache (now)          ${usd(oneHour)}   ${cacheWrites(60)} write, survives the whole thing`,
  );
  console.log(
    `\n  → the TTL change alone saves ${usd(fiveMin - oneHour)} per conversation` +
      ` (${Math.round((1 - oneHour / fiveMin) * 100)}% of input cost)\n`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
