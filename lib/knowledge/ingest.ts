import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { TenantDb } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { extractPdf, type ExtractedPage } from "./extract";
import { chunkPages, type Chunk } from "./chunk";
import { crawlSite, normaliseSiteUrl, WebSourceError, type CrawlResult } from "./web";

/**
 * Turning an uploaded document into articles a person can approve.
 *
 * The rule that shapes everything here: **the model titles, it never writes.**
 * Every article body is the document's own words, byte for byte. Claude decides
 * what question a passage answers and whether it is worth keeping at all — both
 * judgements a reviewer can check at a glance against the text sitting next to
 * them — but it cannot paraphrase, summarise or improve. A business that uploads
 * a price list and gets back subtly different numbers has been failed in a way
 * that surfaces months later, in front of a customer.
 *
 * And everything lands as a DRAFT. An uploaded company deck routinely carries
 * dealer cost, margin bands, staff notes and pricing that was never meant to
 * leave the building. Upload-to-live would hand all of it to the assistant.
 */

const MODEL = "claude-opus-5";

/** Passages per titling call. Large enough to amortise, small enough to stay reliable. */
const BATCH_SIZE = 12;

/**
 * What the model returns per passage.
 *
 * `keep: false` is what makes this usable on a real brochure, which is mostly
 * not answers: contents pages, legal footers, image captions, "Page 4 of 32",
 * the mission statement rendered across a photograph. Without it a reviewer
 * wades through sixty drafts to find eleven worth having.
 */
const Titled = z.object({
  passages: z.array(
    z.object({
      index: z.number().int().describe("The passage number given to you."),
      keep: z
        .boolean()
        .describe(
          "False for anything that answers no customer question: contents pages, " +
            "headers, footers, legal boilerplate, page furniture, stray captions.",
        ),
      title: z
        .string()
        .describe(
          "The question a customer would ask to which this passage is the answer. " +
            "Their words, not the industry's. Empty when keep is false.",
        ),
      tags: z.array(z.string()).describe("Up to three lowercase topic tags."),
    }),
  ),
});

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_WORKSPACE_ID
      ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
      : {}),
  });
  return client;
}

export function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Where the file lives between the upload and the worker.
 *
 * Redis with a TTL, not a column and not a bucket. The bytes are needed for
 * exactly one operation — extraction — and keeping them past that is keeping a
 * document full of internal pricing on the offchance. A TTL means that is true
 * even when the worker crashes: the copy expires whether or not anything
 * remembers to delete it.
 *
 * Deliberately short. If ingestion has not run within the hour, something is
 * wrong enough that re-uploading is the right recovery.
 */
const STASH_TTL_SECONDS = 3_600;
const stashKey = (sourceId: string) => `cadence:upload:${sourceId}`;

export async function stashUpload(sourceId: string, bytes: Uint8Array): Promise<void> {
  await redis.set(stashKey(sourceId), Buffer.from(bytes).toString("base64"), "EX", STASH_TTL_SECONDS);
}

/** Reads and immediately drops it — the bytes are wanted once. */
export async function takeUpload(sourceId: string): Promise<Uint8Array | null> {
  const key = stashKey(sourceId);
  const encoded = await redis.get(key);
  if (!encoded) return null;
  await redis.del(key).catch(() => {});
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

export type IngestOutcome = {
  status: "review" | "failed";
  chunkCount: number;
  failureNote?: string;
};

/**
 * Reads a banked source through to a set of drafts.
 *
 * Assumes the KnowledgeSource row already exists — the upload creates it inside
 * the request so a duplicate file is rejected while someone is still looking at
 * the screen, and this runs later in a worker.
 */
export async function ingestSource(
  db: TenantDb,
  args: { tenantId: string; sourceId: string; bytes: Uint8Array },
): Promise<IngestOutcome> {
  const source = await db.knowledgeSource.findFirstOrThrow({
    where: { id: args.sourceId, tenantId: args.tenantId },
  });

  const extracted = await extractPdf(args.bytes);
  if (!extracted.ok) {
    await db.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "failed", failureNote: extracted.message },
    });
    return { status: "failed", chunkCount: 0, failureNote: extracted.message };
  }

  return ingestPages(db, {
    tenantId: args.tenantId,
    source,
    pages: extracted.pages,
    pageCount: extracted.pageCount,
    label: source.filename,
    pageLabel: (n) => `page ${n}`,
  });
}

/**
 * Reads a business's own website into drafts.
 *
 * Shares everything after the fetch with the PDF path — chunking, titling, the
 * draft state, the approval gate — because the difference between a brochure and
 * a website is where the words came from, not what happens to them.
 */
export async function ingestWebSource(
  db: TenantDb,
  args: { tenantId: string; sourceId: string },
): Promise<IngestOutcome> {
  const source = await db.knowledgeSource.findFirstOrThrow({
    where: { id: args.sourceId, tenantId: args.tenantId },
  });

  if (!source.sourceUrl) {
    const note = "That source has no website address saved.";
    await db.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "failed", failureNote: note },
    });
    return { status: "failed", chunkCount: 0, failureNote: note };
  }

  let crawl: CrawlResult;
  try {
    crawl = await crawlSite(normaliseSiteUrl(source.sourceUrl));
  } catch (err) {
    const note =
      err instanceof WebSourceError
        ? `${err.message} ${err.remedy}`
        : "Something went wrong reading that website.";
    if (!(err instanceof WebSourceError)) {
      logger.error("web knowledge crawl failed", {
        sourceId: source.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    await db.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "failed", failureNote: note },
    });
    return { status: "failed", chunkCount: 0, failureNote: note };
  }

  // Re-reading a site replaces what it produced last time — but only the drafts.
  //
  // A website is expected to be read again; without this, every re-read would
  // add a second near-identical copy of every page. Approved articles are left
  // alone deliberately: somebody read those and signed them off, they are live
  // answers now, and a re-read is not a reason to withdraw them.
  await db.knowledgeDoc.deleteMany({
    where: { tenantId: args.tenantId, sourceId: source.id, status: "draft" },
  });

  return ingestPages(db, {
    tenantId: args.tenantId,
    source,
    pages: crawl.pages,
    pageCount: crawl.pages.length,
    label: crawl.siteTitle || source.sourceUrl,
    // The reviewer sees the address a passage came from, not "page 3".
    pageLabel: (n) => crawl.urls[n - 1] ?? `page ${n}`,
  });
}

/** Everything both sources do once they have pages of text. */
async function ingestPages(
  db: TenantDb,
  args: {
    tenantId: string;
    source: { id: string; filename: string; uploadedById: string | null };
    pages: ExtractedPage[];
    pageCount: number;
    label: string;
    pageLabel: (page: number) => string;
  },
): Promise<IngestOutcome> {
  const source = args.source;
  const chunks = chunkPages(args.pages);

  // Stored before titling. If the model call fails, the reviewer can still see
  // what was read rather than an empty failure.
  await db.knowledgeSource.update({
    where: { id: source.id },
    data: {
      pageCount: args.pageCount,
      extractedText: args.pages
        .map((p) => `--- ${args.pageLabel(p.page)} ---\n${p.text}`)
        .join("\n\n"),
    },
  });

  if (chunks.length === 0) {
    const note =
      "There's text in that file, but nothing long enough to answer a question — " +
      "it may be a slide deck or a form. Try a document with written paragraphs.";
    await db.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "failed", failureNote: note },
    });
    return { status: "failed", chunkCount: 0, failureNote: note };
  }

  const titled = await titleChunks(chunks, source.filename);

  let created = 0;
  for (const item of titled) {
    const chunk = chunks[item.index - 1];
    if (!chunk) continue;

    const title = await uniqueTitle(db, args.tenantId, item.title);

    await db.knowledgeDoc.create({
      data: {
        tenantId: args.tenantId,
        sourceId: source.id,
        sourcePage: chunk.page,
        title,
        // Verbatim. The heading is prepended only when the chunker found one
        // sitting above the passage in the document.
        body: chunk.heading ? `**${chunk.heading}**\n\n${chunk.text}` : chunk.text,
        tags: item.tags.slice(0, 3).map((t) => t.toLowerCase().trim()).filter(Boolean),
        status: "draft",
        authorId: source.uploadedById,
      },
    });
    created++;
  }

  await db.knowledgeSource.update({
    where: { id: source.id },
    data: { status: "review", chunkCount: created },
  });

  logger.info("knowledge source ingested", {
    tenantId: args.tenantId,
    filename: source.filename,
    passages: chunks.length,
    kept: created,
  });

  return { status: "review", chunkCount: created };
}

/**
 * Asks the model what question each passage answers.
 *
 * Batched, and each batch is independent: one malformed response costs twelve
 * passages their titles rather than the whole document. A batch that fails falls
 * back to a title taken from the passage's own heading or first line, so the
 * text still reaches a reviewer — a document that silently loses half its
 * content is far worse than one with some clumsy titles.
 */
async function titleChunks(
  chunks: Chunk[],
  filename: string,
): Promise<{ index: number; title: string; tags: string[] }[]> {
  if (!env.ANTHROPIC_API_KEY) return chunks.map(fallbackTitle);

  const out: { index: number; title: string; tags: string[] }[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    try {
      const response = await anthropic().messages.parse({
        model: MODEL,
        max_tokens: 4_000,
        output_config: { format: zodOutputFormat(Titled), effort: "low" },
        messages: [
          {
            role: "user",
            content:
              `These passages were extracted from "${filename}", a document belonging to a ` +
              `business. They will become articles their customer-facing assistant can quote.\n\n` +
              `For each passage give the question a customer would ask that this passage answers, ` +
              `phrased in a customer's words rather than the industry's. Do not rewrite, ` +
              `summarise or correct the passage itself — you are only labelling it.\n\n` +
              `Set keep to false for anything that answers no question at all: contents pages, ` +
              `page headers and footers, legal boilerplate, stray captions, marketing slogans ` +
              `with no substance.\n\n` +
              batch
                .map((c) => `## Passage ${c.index}${c.heading ? ` (under "${c.heading}")` : ""}\n${c.text}`)
                .join("\n\n"),
          },
        ],
      });

      const parsed = response.parsed_output;
      if (!parsed) throw new Error("no parsed output");

      for (const p of parsed.passages) {
        if (!p.keep || !p.title.trim()) continue;
        // Guard against a returned index that is not in this batch.
        if (!batch.some((c) => c.index === p.index)) continue;
        out.push({ index: p.index, title: p.title.trim().slice(0, 200), tags: p.tags });
      }
    } catch (err) {
      logger.warn("knowledge titling failed for a batch — falling back", {
        err: err instanceof Error ? err.message : String(err),
        from: batch[0]?.index,
      });
      out.push(...batch.map(fallbackTitle));
    }
  }

  return out;
}

function fallbackTitle(chunk: Chunk): { index: number; title: string; tags: string[] } {
  const firstLine = chunk.text.split("\n")[0] ?? "";
  const raw = chunk.heading ?? firstLine;
  const title = raw.length > 90 ? `${raw.slice(0, 87).trimEnd()}…` : raw;
  return { index: chunk.index, title: title || `Passage from page ${chunk.page}`, tags: [] };
}

/**
 * Titles are unique per tenant, and two passages in one brochure can genuinely
 * answer the same question. Suffixing keeps both rather than dropping the
 * second — the reviewer is the right person to decide which to discard.
 */
async function uniqueTitle(db: TenantDb, tenantId: string, wanted: string): Promise<string> {
  const base = wanted.slice(0, 190);
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base} (${n + 1})`;
    const taken = await db.knowledgeDoc.findFirst({
      where: { tenantId, title: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${base} (${Date.now().toString(36)})`;
}
