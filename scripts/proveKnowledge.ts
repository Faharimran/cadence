/**
 * Executable proof that the knowledge layer and the tenant's own voice behave.
 *
 * The claims worth proving are the ones a reasonable person would doubt:
 *
 *   · an unapproved paragraph genuinely cannot reach a customer, by ANY route
 *   · editing live text does not silently change what customers are told
 *   · the prompt stops carrying a hair clinic's rules to a barber
 *   · a business that has written nothing is told to say so, not left to
 *     improvise from what the model happens to know about the industry
 *   · one tenant's articles are invisible to another
 *
 * Runs entirely against the database and the pure prompt builders — no model
 * calls, so it is free, deterministic and safe for CI.
 *
 * Run: npx dotenv -e .env.local -- npx tsx scripts/proveKnowledge.ts
 */
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import {
  buildKnowledgeContext,
  loadApproved,
  searchKnowledge,
} from "@/lib/knowledge";
import { systemPrompt } from "@/lib/conversation/agent";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import { provisionTenant } from "@/lib/provision";
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

/**
 * Probe tenants are matched by slug PREFIX rather than an exact list, because
 * the slug is derived from the business name and the derivation strips leading
 * punctuation — "__kn probe barber" becomes "kn-probe-barber". Matching the
 * name I typed rather than the slug that results is how a probe tenant survives
 * a failed run and pollutes the next one.
 */
async function cleanup() {
  await adminDb.tenant.deleteMany({ where: { slug: { startsWith: "kn-probe" } } });
  await adminDb.user.deleteMany({ where: { email: { endsWith: "@example.test" } } });
}

async function main() {
  await cleanup();

  const cara = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "cara-clinic" } });
  const t = cara.id;

  // ── Approval is the gate ────────────────────────────────────────────
  console.log("\nApproval");
  {
    const draft = await adminDb.knowledgeDoc.create({
      data: {
        tenantId: t,
        title: "__probe Do you offer a discount for cash?",
        body: "Never say this to anyone. Internal only. Yes, 20% off for cash.",
        status: "draft",
      },
    });

    const approved = await withTenant(t, (db) => loadApproved(db, t));
    check(
      "a draft is absent from the approved corpus",
      !approved.some((d) => d.id === draft.id),
    );

    const searched = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "discount for cash" }),
    );
    check(
      "a draft cannot be reached by search, even by its own words",
      !searched.some((d) => d.id === draft.id),
      searched.map((d) => d.title).join(" | "),
    );

    const ctx = await withTenant(t, (db) => buildKnowledgeContext(db, t));
    const rendered = ctx.mode === "empty" ? "" : ctx.rendered;
    check("a draft never appears in the prompt", !rendered.includes("20% off for cash"));

    // Now approve it and confirm the same three routes open up.
    await adminDb.knowledgeDoc.update({
      where: { id: draft.id },
      data: { status: "approved", approvedAt: new Date() },
    });
    const afterApproval = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "discount for cash" }),
    );
    check(
      "approving it makes it findable",
      afterApproval.some((d) => d.id === draft.id),
    );

    // …and that archiving closes them again.
    await adminDb.knowledgeDoc.update({
      where: { id: draft.id },
      data: { status: "archived" },
    });
    const afterArchive = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "discount for cash" }),
    );
    check(
      "archiving removes it from circulation",
      !afterArchive.some((d) => d.id === draft.id),
    );

    await adminDb.knowledgeDoc.delete({ where: { id: draft.id } });
  }

  // ── Editing live text ───────────────────────────────────────────────
  console.log("\nEditing what is already live");
  {
    const doc = await adminDb.knowledgeDoc.findFirstOrThrow({
      where: { tenantId: t, title: "What happens at a first consultation?" },
    });
    check("the seeded article is live at v1", doc.status === "approved" && doc.version === 1);

    const originalRevision = await adminDb.knowledgeRevision.findFirstOrThrow({
      where: { docId: doc.id, version: 1 },
    });

    // Simulate the edit path: an approved doc goes back to draft.
    await adminDb.knowledgeDoc.update({
      where: { id: doc.id },
      data: {
        body: "EDITED — consultations are now free.",
        status: "draft",
        approvedById: null,
        approvedAt: null,
      },
    });

    const live = await withTenant(t, (db) => loadApproved(db, t));
    check(
      "editing a live article takes it out of circulation immediately",
      !live.some((d) => d.id === doc.id),
    );
    check(
      "the unapproved edit is not shown to customers",
      !live.some((d) => d.body.includes("now free")),
    );
    check(
      "the approved v1 text is still on record",
      originalRevision.body.includes("thirty minutes"),
    );

    // Put it back the way the seed left it.
    await adminDb.knowledgeDoc.update({
      where: { id: doc.id },
      data: {
        body: originalRevision.body,
        status: "approved",
        approvedAt: new Date(),
      },
    });
  }

  // ── Search behaviour ────────────────────────────────────────────────
  console.log("\nSearch");
  {
    const prp = await withTenant(t, (db) => searchKnowledge(db, t, { query: "what is PRP?" }));
    check(
      "a title match ranks first",
      prp[0]?.title.includes("PRP") === true,
      prp.map((d) => d.title).join(" | "),
    );

    const suitability = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "am I suitable for a transplant" }),
    );
    check(
      "the article whose job is to decline is findable",
      suitability.some((d) => d.title.includes("suitable")),
      suitability.map((d) => d.title).join(" | "),
    );

    const nonsense = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "zzzq nonexistent topic" }),
    );
    check("a question nobody wrote about returns nothing", nonsense.length === 0);

    const stopwordsOnly = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "do you have the a" }),
    );
    check(
      "a query of nothing but stop words does not match everything",
      stopwordsOnly.length <= 3,
      `${stopwordsOnly.length} results`,
    );

    const tagged = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "clinic", tags: ["locations"] }),
    );
    check(
      "tags narrow the search",
      tagged.every((d) => d.tags.includes("locations")),
    );
  }

  // ── Inline vs index ─────────────────────────────────────────────────
  console.log("\nHow it reaches the model");
  {
    const ctx = await withTenant(t, (db) => buildKnowledgeContext(db, t));
    check(
      "a small corpus is given to the model in full",
      ctx.mode === "inline",
      `mode was ${ctx.mode}`,
    );

    // The tool exists only when there is something to search that is not
    // already in front of the model.
    const toolNames = await withTenant(t, async (db) => {
      const capabilities = await resolveCapabilities(db, t);
      const toolCtx = {
        db,
        caps: capabilities,
        tenantId: t,
        conversationId: "probe",
        customerId: "probe",
        snapshot: { conversationId: "probe", tenantId: t, degraded: false },
        knowledge: ctx,
        outcome: { escalated: false, escalationReasons: [], bookingIds: [], sources: [] },
      } as unknown as ToolContext;
      return buildTools(toolCtx).map((tool) => tool.name);
    });
    check(
      "no search tool while everything already fits in the prompt",
      !toolNames.includes("search_knowledge"),
      toolNames.join(", "),
    );

    // Force index mode with a synthetic oversized corpus.
    const filler = "x".repeat(6_000);
    const bulkTitles: string[] = [];
    for (let i = 0; i < 10; i++) {
      const title = `__probe bulk article ${i}`;
      bulkTitles.push(title);
      await adminDb.knowledgeDoc.create({
        data: {
          tenantId: t,
          title,
          body: filler,
          status: "approved",
          approvedAt: new Date(),
        },
      });
    }

    const bigCtx = await withTenant(t, (db) => buildKnowledgeContext(db, t));
    check(
      "a corpus too large for the prompt switches to titles-plus-search",
      bigCtx.mode === "index",
      `mode was ${bigCtx.mode}`,
    );
    check(
      "the titles the model is shown are the complete list",
      bigCtx.mode === "index" && bigCtx.titles.length >= 15,
      bigCtx.mode === "index" ? `${bigCtx.titles.length} titles` : "",
    );
    check(
      "no article bodies are inlined in index mode",
      bigCtx.mode === "index" && !bigCtx.rendered.includes(filler.slice(0, 100)),
    );

    const bigToolNames = await withTenant(t, async (db) => {
      const capabilities = await resolveCapabilities(db, t);
      const toolCtx = {
        db,
        caps: capabilities,
        tenantId: t,
        conversationId: "probe",
        customerId: "probe",
        snapshot: { conversationId: "probe", tenantId: t, degraded: false },
        knowledge: bigCtx,
        outcome: { escalated: false, escalationReasons: [], bookingIds: [], sources: [] },
      } as unknown as ToolContext;
      return buildTools(toolCtx).map((tool) => tool.name);
    });
    check(
      "the search tool appears once it is needed",
      bigToolNames.includes("search_knowledge"),
      bigToolNames.join(", "),
    );

    await adminDb.knowledgeDoc.deleteMany({
      where: { tenantId: t, title: { in: bulkTitles } },
    });
  }

  // ── The prompt carries the tenant's rules, not a clinic's ───────────
  console.log("\nWhose rules the assistant follows");
  {
    const ctx = await withTenant(t, (db) => buildKnowledgeContext(db, t));

    const clinicPrompt = systemPrompt(
      {
        name: "Cara Clinic",
        timezone: "Asia/Kolkata",
        descriptor: cara.descriptor,
        toneNote: cara.toneNote,
        escalationTopics: cara.escalationTopics,
      },
      ["catalog", "availability"],
      ctx,
      { degraded: false },
    );
    const clinicText = clinicPrompt.map((b) => b.text).join("\n");

    check(
      "a clinic's prompt does carry its clinical hand-over rule",
      clinicText.includes("anything clinical"),
    );
    check(
      "and its own description of itself",
      clinicText.includes("hair and skin clinic in Mumbai"),
    );

    const barberPrompt = systemPrompt(
      {
        name: "Sharp Cuts",
        timezone: "Europe/London",
        descriptor: "A barber shop doing cuts and beard trims.",
        toneNote: "Short and friendly, first names.",
        escalationTopics: ["complaints about a previous cut"],
      },
      ["catalog", "availability"],
      { mode: "empty" },
      { degraded: false },
    );
    const barberText = barberPrompt.map((b) => b.text).join("\n");

    // This is the whole point of the change: the clinic's caution used to be a
    // string literal every tenant inherited.
    check(
      "a barber's prompt does NOT inherit the clinic's clinical rule",
      !barberText.toLowerCase().includes("clinical"),
    );
    check("a barber's prompt carries its own rule", barberText.includes("previous cut"));
    check("and its own tone", barberText.includes("first names"));
    check("and never mentions the other tenant", !barberText.includes("Cara"));
  }

  // ── The empty state is told to be empty ─────────────────────────────
  console.log("\nA business that has written nothing");
  {
    const prompt = systemPrompt(
      {
        name: "Sharp Cuts",
        timezone: "Europe/London",
        descriptor: null,
        toneNote: null,
        escalationTopics: [],
      },
      ["catalog"],
      { mode: "empty" },
      { degraded: false },
    );
    const text = prompt.map((b) => b.text).join("\n");

    check("the prompt says plainly that nothing is written down", text.includes("Nothing yet"));
    check(
      "and forbids filling the gap from general knowledge",
      text.includes("never answer from general knowledge") ||
        text.includes("Do not answer it from general knowledge"),
    );
  }

  // ── Caching ─────────────────────────────────────────────────────────
  console.log("\nPrompt caching");
  {
    const ctx = await withTenant(t, (db) => buildKnowledgeContext(db, t));
    const prompt = systemPrompt(
      {
        name: cara.name,
        timezone: cara.timezone,
        descriptor: cara.descriptor,
        toneNote: cara.toneNote,
        escalationTopics: cara.escalationTopics,
      },
      ["catalog"],
      ctx,
      { degraded: false },
    );

    check("the prompt is split into two blocks", prompt.length === 2);
    check("the first is marked cacheable", Boolean(prompt[0].cache_control));
    check("the second is not", !prompt[1].cache_control);
    check(
      "the knowledge sits in the cacheable block",
      prompt[0].text.includes("first consultation"),
    );
    check(
      "the clock sits outside it, or every message would bust the cache",
      prompt[1].text.includes("It is currently") && !prompt[0].text.includes("It is currently"),
    );
  }

  // ── Provisioning from a preset ──────────────────────────────────────
  console.log("\nSetting up a new business");
  let barberTenantId: string;
  {
    const preset = findPreset("barber")!;
    const provisioned = await provisionTenant(adminDb, {
      businessName: "__kn probe barber",
      timezone: "Europe/London",
      currency: "GBP",
      presetId: "barber",
      owner: { email: "probe-barber@example.test", password: "a-long-enough-password" },
    });
    barberTenantId = provisioned.tenantId;

    const made = await adminDb.tenant.findUniqueOrThrow({
      where: { id: provisioned.tenantId },
      include: { exceptionTypes: true, services: true, locations: true, knowledgeDocs: true },
    });

    check("the business is created with the currency it asked for", made.currency === "GBP");
    check("and the timezone it asked for", made.timezone === "Europe/London");
    check(
      "the preset's hand-over topics are seeded as tenant data",
      made.escalationTopics.length === preset.escalationTopics.length,
    );
    check(
      "its words for time off are its own",
      made.exceptionTypes.some((x) => x.code === "day_off"),
      made.exceptionTypes.map((x) => x.code).join(", "),
    );
    check("closed is locked so it cannot be deleted", made.exceptionTypes.some((x) => x.code === "closed" && x.systemLocked));
    check("a first location exists", made.locations.length === 1);
    check("starter services exist", made.services.length === preset.services.length);

    check("a starter article is provided", made.knowledgeDocs.length === 1);
    check(
      "and it is a DRAFT — nothing we wrote is ever live on day one",
      made.knowledgeDocs.every((d) => d.status === "draft"),
    );

    const newCtx = await withTenant(made.id, (db) => buildKnowledgeContext(db, made.id));
    check(
      "so a brand-new business starts with an empty corpus",
      newCtx.mode === "empty",
      `mode was ${newCtx.mode}`,
    );

    check("the vertical is recorded for provenance", made.vertical === "barber");

    // The slug must survive a name collision.
    await provisionTenant(adminDb, {
      businessName: "__kn probe dedupe",
      timezone: "UTC",
      currency: "USD",
      presetId: "other",
      owner: { email: "probe-dupe@example.test", password: "a-long-enough-password" },
    });
    let duplicateRejected = false;
    try {
      await provisionTenant(adminDb, {
        businessName: "__kn probe dedupe",
        timezone: "UTC",
        currency: "USD",
        presetId: "other",
        owner: { email: "probe-dupe@example.test", password: "a-long-enough-password" },
      });
    } catch {
      duplicateRejected = true;
    }
    check("the same email cannot own two businesses", duplicateRejected);
  }

  // ── Isolation ───────────────────────────────────────────────────────
  console.log("\nIsolation");
  {
    const caraDocs = await withTenant(t, (db) => loadApproved(db, t));
    const barberDocs = await withTenant(barberTenantId, (db) =>
      loadApproved(db, barberTenantId),
    );

    check("the clinic has approved articles", caraDocs.length > 0);
    check("the new barber has none", barberDocs.length === 0);

    // The real test: ask the barber's scope for the clinic's content by name.
    const crossTenant = await withTenant(barberTenantId, (db) =>
      searchKnowledge(db, barberTenantId, { query: "first consultation transplant PRP" }),
    );
    check("one tenant cannot search another's articles", crossTenant.length === 0);
  }

  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
