/**
 * Executable proof that the public demo is safe to leave unauthenticated.
 *
 * The demo is the only surface in enori that anybody on the internet can make
 * spend money and write rows. Three claims are made for it on the page and in
 * the code comments, and all three are the kind a reasonable person should
 * refuse to take on trust:
 *
 *   · **A visitor cannot write into a demo calendar.** Not "is discouraged
 *     from" — the agent is never handed a tool that writes, so there is no
 *     prompt that produces a booking.
 *   · **The assistant only repeats approved text.** Same gate as a paying
 *     tenant; the demo is not the place it gets relaxed.
 *   · **One agent, three businesses.** The insurance prompt must not carry the
 *     clinic's vocabulary, or the "engine owns no vertical" claim is decoration.
 *
 * Plus the one that bounds the bill: the rate limiter must actually refuse.
 *
 * Runs against the database, Redis and the pure prompt builders. No model
 * calls, so it is free, deterministic and safe for CI.
 *
 * Run: npm run prove:demo
 */
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { getAvailability } from "@/lib/engine/availability";
import { systemPrompt } from "@/lib/conversation/agent";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import { buildKnowledgeContext } from "@/lib/knowledge";
import {
  DEMO_CAPABILITIES,
  DEMO_PERSONAS,
  DEMO_SLUG_PREFIX,
  findDemoPersona,
} from "@/lib/demo/personas";
import {
  LIMITS,
  consumeDemoBudget,
  isValidSessionId,
  newSessionId,
  readCookie,
} from "@/lib/demo/session";
import { INDUSTRIES } from "@/lib/marketing/industries";
import { findPreset } from "@/lib/presets";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

/** Tools that create or change a row. None of these may exist on a demo tenant. */
const WRITE_TOOLS = ["hold_slot", "confirm_booking", "cancel_booking"];

async function main() {
  console.log("\nThe three demo businesses\n");

  const tenants = await adminDb.tenant.findMany({
    where: { slug: { startsWith: DEMO_SLUG_PREFIX } },
    select: { id: true, slug: true, name: true, status: true, timezone: true, currency: true },
  });

  check(
    `all ${DEMO_PERSONAS.length} demo tenants are seeded`,
    tenants.length === DEMO_PERSONAS.length,
    `found ${tenants.length} — run 'npm run seed:demo:agents'`,
  );

  if (tenants.length === 0) {
    console.log("\nNothing to prove against. Seed first.\n");
    process.exit(1);
  }

  // Three currencies and three zones is the whole "no default anywhere" claim,
  // stated as data. If a future edit collapses them to one, the demo stops
  // demonstrating the thing the page says it demonstrates.
  check(
    "they run in three different timezones",
    new Set(tenants.map((t) => t.timezone)).size === tenants.length,
    tenants.map((t) => t.timezone).join(", "),
  );
  check(
    "and three different currencies",
    new Set(tenants.map((t) => t.currency)).size === tenants.length,
    tenants.map((t) => t.currency).join(", "),
  );

  console.log("\nNo visitor can write into a demo calendar\n");

  for (const persona of DEMO_PERSONAS) {
    const tenant = tenants.find((t) => t.slug === persona.slug);
    if (!tenant) {
      check(`${persona.id}: seeded`, false, "missing");
      continue;
    }

    await withTenant(tenant.id, async (db) => {
      const caps = await resolveCapabilities(db, tenant.id);

      check(
        `${persona.id}: has no booking_write capability`,
        !caps.has("booking_write"),
        "an anonymous visitor could book",
      );
      check(
        `${persona.id}: capabilities are exactly the read-only set`,
        caps.list().join(",") === [...DEMO_CAPABILITIES].sort().join(","),
        caps.list().join(", "),
      );

      // The capability check above is the cause; this is the effect, and it is
      // the one that matters. Assert on the toolset the model is actually
      // handed rather than on the row that decides it.
      const knowledge = await buildKnowledgeContext(db, tenant.id);
      const ctx = {
        db,
        caps,
        tenantId: tenant.id,
        conversationId: "prove",
        customerId: "prove",
        snapshot: { conversationId: "prove", tenantId: tenant.id, degraded: false },
        knowledge,
        outcome: { escalated: false, escalationReasons: [], bookingIds: [], sources: [] },
      } as unknown as ToolContext;

      const names = buildTools(ctx).map((t) => t.name);
      const writable = names.filter((n) => WRITE_TOOLS.includes(n));
      check(
        `${persona.id}: the model is handed no tool that writes`,
        writable.length === 0,
        writable.join(", "),
      );
      check(
        `${persona.id}: it can still check live availability`,
        names.includes("check_availability"),
        names.join(", "),
      );
      check(
        `${persona.id}: it can always hand over`,
        names.includes("escalate_to_human"),
        names.join(", "),
      );
    });
  }

  console.log("\nEverything it can say was approved first\n");

  for (const persona of DEMO_PERSONAS) {
    const tenant = tenants.find((t) => t.slug === persona.slug);
    if (!tenant) continue;

    const docs = await adminDb.knowledgeDoc.findMany({
      where: { tenantId: tenant.id },
      select: { title: true, status: true },
    });

    check(
      `${persona.id}: has ${persona.articles.length} articles`,
      docs.length === persona.articles.length,
      `found ${docs.length}`,
    );
    check(
      `${persona.id}: every one of them is approved`,
      docs.length > 0 && docs.every((d) => d.status === "approved"),
      docs.filter((d) => d.status !== "approved").map((d) => d.title).join(", "),
    );
  }

  console.log("\nOne agent, three businesses — no vertical in the code\n");

  const prompts = new Map<string, string>();
  for (const persona of DEMO_PERSONAS) {
    const tenant = tenants.find((t) => t.slug === persona.slug);
    if (!tenant) continue;

    const built = await withTenant(tenant.id, async (db) => {
      const caps = await resolveCapabilities(db, tenant.id);
      const knowledge = await buildKnowledgeContext(db, tenant.id);
      const row = await db.tenant.findFirstOrThrow({ where: { id: tenant.id } });
      return systemPrompt(row, caps.list(), knowledge, { degraded: false })
        .map((b) => b.text)
        .join("\n");
    });
    prompts.set(persona.id, built.toLowerCase());
  }

  // The same test proveKnowledge runs on a barber, applied across the demo: a
  // business's prompt must carry ITS OWN vocabulary and nobody else's. A word
  // leaking between these three means it came from agent.ts rather than from a
  // tenant row.
  const foreign: [string, string][] = [
    ["insurance", "physiotherap"],
    ["insurance", "clinical"],
    ["property", "clinical"],
    ["clinic", "premium"],
    ["clinic", "tenancy"],
    ["property", "insurer"],
  ];
  for (const [personaId, word] of foreign) {
    const prompt = prompts.get(personaId);
    if (!prompt) continue;
    check(
      `${personaId}: prompt never mentions "${word}"`,
      !prompt.includes(word),
      "another vertical's vocabulary reached this prompt",
    );
  }

  for (const persona of DEMO_PERSONAS) {
    const prompt = prompts.get(persona.id);
    if (!prompt) continue;
    check(
      `${persona.id}: prompt carries its own hand-over list`,
      persona.escalationTopics.every((topic) => prompt.includes(topic.toLowerCase().slice(0, 40))),
    );
  }

  console.log("\nThe availability it quotes is computed, not seeded\n");

  for (const persona of DEMO_PERSONAS) {
    const tenant = tenants.find((t) => t.slug === persona.slug);
    if (!tenant) continue;

    await withTenant(tenant.id, async (db) => {
      const service = await db.service.findFirst({
        where: { tenantId: tenant.id, active: true },
        orderBy: { name: "asc" },
      });
      if (!service) {
        check(`${persona.id}: has a bookable service`, false);
        return;
      }

      const from = new Date();
      const to = new Date(from.getTime() + 14 * 24 * 3600 * 1000);
      const result = await getAvailability(db, {
        tenantId: tenant.id,
        serviceId: service.id,
        from,
        to,
        limit: 5,
      });

      // A demo whose calendar is empty answers every question with "nothing
      // free", which reads as a broken product rather than a busy one.
      check(
        `${persona.id}: "${service.name}" has real slots in the next fortnight`,
        result.available && result.slots.length > 0,
        result.available ? "no slots" : result.reason,
      );
    });
  }

  console.log("\nThe endpoint's allowlist\n");

  check("a known persona resolves", Boolean(findDemoPersona("clinic")));
  check("an unknown one does not", findDemoPersona("does-not-exist") === undefined);
  check(
    "a path-shaped id does not",
    findDemoPersona("../../etc/passwd") === undefined,
    "persona ids are looked up, never interpolated",
  );
  check(
    "every persona id is unique",
    new Set(DEMO_PERSONAS.map((p) => p.id)).size === DEMO_PERSONAS.length,
  );
  check(
    "every demo slug carries the prefix",
    DEMO_PERSONAS.every((p) => p.slug.startsWith(DEMO_SLUG_PREFIX)),
    "the seed and this script find them by prefix",
  );

  check("a well-formed session id is accepted", isValidSessionId(newSessionId()));
  check("a short one is not", !isValidSessionId("abc"));
  check("one with punctuation is not", !isValidSessionId(`${newSessionId()}; drop`));
  check(
    "cookies are parsed by name, not by prefix",
    readCookie("not_cadence_demo=x; cadence_demo=y", "cadence_demo") === "y",
  );

  console.log("\nThe industries section promises nothing unbuilt\n");

  check(
    "every industry id is unique",
    new Set(INDUSTRIES.map((i) => i.id)).size === INDUSTRIES.length,
  );
  for (const industry of INDUSTRIES) {
    check(
      `${industry.id}: “${industry.presetId}” is a real preset`,
      Boolean(findPreset(industry.presetId)),
      "the page tells a visitor which setup to start from",
    );
  }
  for (const industry of INDUSTRIES.filter((i) => i.demo)) {
    check(
      `${industry.id}: its “try this one” link names a live persona`,
      Boolean(findDemoPersona(industry.demo!)),
      `no demo tenant called '${industry.demo}'`,
    );
  }

  /**
   * The three capabilities this page would most plausibly grow a claim about,
   * and the reason each one may not be written yet:
   *
   *   · reminders / notifications — `notifications` is a member of the
   *     Capability enum that no code reads. There is no scheduler, no template
   *     and no send path.
   *   · CRM integrations — `CapabilityMode.brokered` exists in the schema, but
   *     lib/connectors/ has no adapter in it. Nothing is brokered anywhere.
   *   · channels other than WhatsApp — lib/channels/ holds whatsapp.ts, and the
   *     demo's own web transport. Instagram and SMS appear in a schema comment
   *     as future values, not as code.
   *
   * When one of them ships, delete its line here and write the copy. Until
   * then this fails the build rather than letting the page get ahead of the
   * product — which is the specific way a page like this goes bad.
   */
  const UNBUILT = ["reminder", "integrat", "crm", "instagram", " sms", "sync with"];
  for (const industry of INDUSTRIES) {
    const copy = [
      industry.headline,
      industry.lede,
      industry.neverDoes,
      ...industry.handles,
      ...industry.cards.flatMap((c) => [c.label, c.note]),
    ]
      .join(" ")
      .toLowerCase();

    const claimed = UNBUILT.filter((word) => copy.includes(word));
    check(
      `${industry.id}: claims nothing this repo has not built`,
      claimed.length === 0,
      `mentions ${claimed.join(", ")}`,
    );
  }

  console.log("\nThe spending limit actually refuses\n");

  const sessionId = newSessionId();
  const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
  const day = new Date().toISOString().slice(0, 10);

  let refusedAt = 0;
  for (let n = 1; n <= LIMITS.session.limit + 1; n++) {
    const result = await consumeDemoBudget({ sessionId, ip });
    if (!result.ok) {
      refusedAt = n;
      check(
        `refused at turn ${n}, on the session limit`,
        result.scope === "session",
        `refused on '${result.scope}'`,
      );
      break;
    }
  }
  check(
    `a session is cut off after ${LIMITS.session.limit} turns`,
    refusedAt === LIMITS.session.limit + 1,
    refusedAt === 0 ? "never refused" : `refused at ${refusedAt}`,
  );

  // Give back what the probe took. The global counter is the real daily budget
  // for actual visitors, and a prove run that quietly spent 21 of it would make
  // the limit mean something different on days CI ran.
  await redis.del(`cadence:demo:s:${sessionId}`, `cadence:demo:ip:${ip}`);
  await redis.decrby(`cadence:demo:all:${day}`, refusedAt || LIMITS.session.limit);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
