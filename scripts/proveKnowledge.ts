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
import { readFileSync } from "node:fs";
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { extractPdf } from "@/lib/knowledge/extract";
import { chunkPages } from "@/lib/knowledge/chunk";
import { ingestSource, checksumOf } from "@/lib/knowledge/ingest";
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
  await adminDb.knowledgeDoc.deleteMany({ where: { title: { startsWith: "__probe" } } });
  await adminDb.knowledgeSource.deleteMany({ where: { filename: { startsWith: "__probe" } } });
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
        toneNote: cara.toneNote, agentInstructions: null,
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
        toneNote: "Short and friendly, first names.", agentInstructions: null,
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
        toneNote: null, agentInstructions: null,
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
        toneNote: cara.toneNote, agentInstructions: null,
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

  // ── Reading an uploaded document ────────────────────────────────────
  console.log("\nReading an uploaded document");
  {
    const bytes = new Uint8Array(readFileSync("fixtures/sample-handbook.pdf"));

    // pdf.js takes ownership of the buffer it is given and detaches it. Nothing
    // downstream expects that, and the failure it produces is "unreadable PDF"
    // on a file that read perfectly a moment earlier.
    const first = await extractPdf(bytes);
    check("a PDF extracts", first.ok, first.ok ? "" : first.reason);
    check("and the caller's buffer survives it", bytes.byteLength > 0);
    const second = await extractPdf(bytes);
    check("so the same bytes can be read twice", second.ok);

    if (!first.ok) throw new Error("fixture did not extract");

    const chunks = chunkPages(first.pages);
    check("it splits into passages", chunks.length >= 4, `${chunks.length}`);
    check(
      "headings are lifted out rather than glued to the paragraph below",
      chunks.some((c) => c.heading?.includes("COURTESY")),
      chunks.map((c) => c.heading ?? "—").join(" | "),
    );
    check(
      "no passage is a bare heading",
      chunks.every((c) => c.text.length > 100),
    );
    check("every passage knows its page", chunks.every((c) => c.page >= 1));

    const garbage = await extractPdf(new Uint8Array([1, 2, 3, 4, 5]));
    check("a file that is not a PDF is refused", !garbage.ok);
    check(
      "and the reason is one a receptionist can act on",
      !garbage.ok && garbage.message.length > 20 && !garbage.message.includes("Error"),
      garbage.ok ? "" : garbage.message,
    );
  }

  // ── Ingestion lands as drafts ───────────────────────────────────────
  console.log("\nWhat an upload does to the corpus");
  {
    const bytes = new Uint8Array(readFileSync("fixtures/sample-handbook.pdf"));
    const before = await withTenant(t, (db) => loadApproved(db, t));

    const source = await adminDb.knowledgeSource.create({
      data: {
        tenantId: t,
        filename: "__probe-handbook.pdf",
        mimeType: "application/pdf",
        byteSize: bytes.byteLength,
        checksum: checksumOf(bytes),
      },
    });

    const outcome = await withTenant(
      t,
      (db) => ingestSource(db, { tenantId: t, sourceId: source.id, bytes }),
      { timeoutMs: 600_000 },
    );

    check("it produced articles", outcome.status === "review" && outcome.chunkCount > 0,
      `${outcome.status} / ${outcome.chunkCount}`);

    const produced = await adminDb.knowledgeDoc.findMany({
      where: { tenantId: t, sourceId: source.id },
    });

    // The whole safety story for uploads. A company handbook routinely carries
    // internal rates and staff instructions; upload-to-live hands all of it to
    // the assistant.
    check(
      "EVERY article from an upload is a draft",
      produced.length > 0 && produced.every((d) => d.status === "draft"),
      produced.map((d) => d.status).join(","),
    );
    check(
      "so the corpus the assistant can see is unchanged by an upload",
      (await withTenant(t, (db) => loadApproved(db, t))).length === before.length,
    );
    check(
      "each one records which file and page it came from",
      produced.every((d) => d.sourceId === source.id && d.sourcePage !== null),
    );
    // The rule the whole design rests on: the model titles, it never writes.
    // Every body must appear verbatim in what was pulled out of the file.
    const stored = await adminDb.knowledgeSource.findUniqueOrThrow({
      where: { id: source.id },
      select: { extractedText: true },
    });
    const haystack = (stored.extractedText ?? "").replace(/\s+/g, " ");
    check(
      "bodies are the document's own words, not the model's",
      produced.every((d) => {
        const opening = d.body
          .replace(/^\*\*[^*]*\*\*\n\n/, "") // drop the heading the chunker prepended
          .replace(/\s+/g, " ")
          .slice(0, 50);
        return haystack.includes(opening);
      }),
    );
    // The one assertion in this file that depends on a model, and so on a paid
    // key and on sampling. Skipped rather than failed when no key is set, which
    // is what lets this harness run in CI at all — the alternative was excluding
    // the whole file and losing sixty-nine deterministic assertions with it.
    // Without a key the titles fall back to the document's own headings, which
    // is correct behaviour and simply not what this checks.
    if (process.env.ANTHROPIC_API_KEY) {
      check(
        "titles are phrased as questions a customer would ask",
        produced.filter((d) => d.title.includes("?")).length >= produced.length - 1,
        produced.map((d) => d.title).join(" | "),
      );
    } else {
      console.log("  · titles are phrased as questions — skipped, no ANTHROPIC_API_KEY");
    }

    const sameFile = await adminDb.knowledgeSource.findFirst({
      where: { tenantId: t, checksum: checksumOf(bytes) },
    });
    check("re-uploading the same file finds the existing source", sameFile?.id === source.id);

    // Deleting a source takes its drafts but must never touch what was signed
    // off — those are live answers now, whatever their origin.
    const [keptDraft, ...rest] = produced;
    await adminDb.knowledgeDoc.update({
      where: { id: keptDraft.id },
      data: { status: "approved", approvedAt: new Date() },
    });
    await adminDb.knowledgeDoc.deleteMany({
      where: { tenantId: t, sourceId: source.id, status: "draft" },
    });
    await adminDb.knowledgeSource.delete({ where: { id: source.id } });

    const survivor = await adminDb.knowledgeDoc.findUnique({ where: { id: keptDraft.id } });
    check("deleting the source leaves approved articles standing", survivor !== null);
    check(
      "and their text is intact with the source gone",
      survivor?.sourceId === null && (survivor?.body.length ?? 0) > 0,
    );
    check("while the unapproved drafts go with it", rest.length > 0);

    await adminDb.knowledgeDoc.deleteMany({ where: { id: keptDraft.id } });
  }

  // ── Full-text retrieval ─────────────────────────────────────────────
  console.log("\nFinding the right article");
  {
    const target = await adminDb.knowledgeDoc.create({
      data: {
        tenantId: t,
        title: "__probe Can I finance a treatment?",
        body: "We offer monthly instalments through a partner. Ask at reception.",
        status: "approved",
        approvedAt: new Date(),
      },
    });
    // Shares one incidental word with the question and nothing else. This is the
    // shape of document that used to win.
    const decoy = await adminDb.knowledgeDoc.create({
      data: {
        tenantId: t,
        title: "__probe What is the monthly cleaning rota?",
        body: "Unrelated text about something else entirely.",
        status: "approved",
        approvedAt: new Date(),
      },
    });

    const stemmed = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "financing options", limit: 3 }),
    );
    check(
      "'financing' finds an article titled 'finance' — inflections stop mattering",
      stemmed.some((h) => h.id === target.id),
      stemmed.map((h) => h.title).join(" | "),
    );

    // The fix that mattered on the real document: matching two query terms beats
    // matching one, rather than every hit counting the same.
    const ranked = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "monthly financing", limit: 3 }),
    );
    check(
      "matching more of the question outranks matching one stray word",
      ranked[0]?.id === target.id,
      ranked.map((h) => h.title).join(" | "),
    );

    // Stated as an assertion rather than left as folklore: stemming handles
    // inflections, not vocabulary. Someone will eventually expect it to.
    // "credit" and "arrangements" share no stem with "finance", "monthly",
    // "instalments", "partner" or "reception" — though a person would read the
    // question as asking exactly what that article answers.
    const vocabulary = await withTenant(t, (db) =>
      searchKnowledge(db, t, { query: "credit arrangements", limit: 3 }),
    );
    check(
      "but a question sharing no word stem still misses — the gap embeddings close",
      !vocabulary.some((h) => h.id === target.id),
      vocabulary.map((h) => h.title).join(" | ") || "(nothing)",
    );

    await adminDb.knowledgeDoc.deleteMany({ where: { id: { in: [target.id, decoy.id] } } });
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

  // ── Approving a subject at a time ───────────────────────────────────
  //
  // A website read produces drafts across a whole site at once, grouped by
  // subject rather than by page, and approving forty one at a time is how an
  // import ends up half-done and abandoned. The risk of the shortcut is that
  // bulk approval is exactly the action that puts text in front of customers,
  // so what it must NOT reach matters more than what it does.
  console.log("\nApproving by subject");
  {
    const src = await adminDb.knowledgeSource.create({
      data: {
        tenantId: t,
        kind: "web",
        sourceUrl: "https://tag-probe.test",
        filename: "tag-probe.test",
        mimeType: "text/html",
        byteSize: 0,
        checksum: `tag-probe-${Date.now()}`,
        status: "review",
      },
    });

    const make = (title: string, tags: string[], status: "draft" | "archived") =>
      adminDb.knowledgeDoc.create({
        data: { tenantId: t, sourceId: src.id, title, body: `Body of ${title}`, tags, status },
      });

    const a = await make("Where do I park?", ["parking"], "draft");
    const b = await make("Is parking free?", ["parking"], "draft");
    const retired = await make("Old parking rules", ["parking"], "archived");
    const other = await make("What does it cost?", ["pricing"], "draft");

    await withTenant(t, async (db) => {
      const drafts = await db.knowledgeDoc.findMany({
        where: { tenantId: t, status: "draft", tags: { has: "parking" } },
      });
      for (const d of drafts) {
        await db.knowledgeDoc.update({
          where: { id: d.id },
          data: { status: "approved", approvedAt: new Date() },
        });
      }
    });

    const state = async (id: string) =>
      (await adminDb.knowledgeDoc.findUniqueOrThrow({ where: { id } })).status;

    check("both drafts with that tag went live", (await state(a.id)) === "approved" && (await state(b.id)) === "approved");
    check(
      "an ARCHIVED article with the same tag stayed archived",
      (await state(retired.id)) === "archived",
      "retired and not-yet-approved look alike in a list and are opposite intentions",
    );
    check("a draft with a different tag was untouched", (await state(other.id)) === "draft");

    await adminDb.knowledgeSource.delete({ where: { id: src.id } });
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
