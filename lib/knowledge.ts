import type { TenantDb } from "@/lib/prisma";

/**
 * Reading what the business has written down.
 *
 * Two ways the assistant gets at it, and which one applies is decided by size
 * rather than by configuration:
 *
 *   · **inline** — the whole approved corpus fits in the prompt, so it goes in
 *     the prompt. No retrieval step means no retrieval failure: the model cannot
 *     fail to find a paragraph that is already in front of it. This is the right
 *     answer for almost every small business and it is the default.
 *
 *   · **index** — the corpus outgrew the budget, so the prompt carries the
 *     TITLES ONLY and a `search_knowledge` tool fetches bodies on demand. The
 *     titles matter enormously: the classic retrieval failure is a model that
 *     does not know something is knowable and so never searches. It cannot make
 *     that mistake while looking at a list of what exists.
 *
 * The switch is automatic and one-way per turn. A business writing its tenth
 * article does not have to know any of this happened.
 */

/** Roughly the character budget for inlined knowledge. ~4 chars/token. */
const INLINE_BUDGET_CHARS = 48_000;

/** A single fetched body is capped so one enormous doc cannot eat a turn. */
const MAX_BODY_CHARS = 8_000;

export type KnowledgeEntry = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  version: number;
};

export type KnowledgeContext =
  | { mode: "empty" }
  | { mode: "inline"; entries: KnowledgeEntry[]; rendered: string }
  | { mode: "index"; titles: { title: string; tags: string[] }[]; rendered: string };

/**
 * Everything approved, newest-signed-off first.
 *
 * `status: approved` is the whole safety story. A draft is not ranked lower or
 * flagged — it is not returned, so no amount of prompting can surface an
 * unreviewed paragraph to a customer.
 */
export async function loadApproved(db: TenantDb, tenantId: string): Promise<KnowledgeEntry[]> {
  const docs = await db.knowledgeDoc.findMany({
    where: { tenantId, status: "approved" },
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true, title: true, body: true, tags: true, version: true },
  });
  return docs.map((d) => ({ ...d, body: clamp(d.body) }));
}

/**
 * Builds the block that goes into the system prompt.
 *
 * Note what is NOT here: any instruction about how to use it. That lives in the
 * prompt itself, next to the other rules, so all the model's constraints read as
 * one set rather than being scattered across whatever assembled them.
 */
export async function buildKnowledgeContext(
  db: TenantDb,
  tenantId: string,
): Promise<KnowledgeContext> {
  const entries = await loadApproved(db, tenantId);
  if (entries.length === 0) return { mode: "empty" };

  const total = entries.reduce((n, e) => n + e.title.length + e.body.length, 0);

  if (total <= INLINE_BUDGET_CHARS) {
    const rendered = entries
      .map((e) => `### ${e.title}${e.tags.length ? `  [${e.tags.join(", ")}]` : ""}\n${e.body}`)
      .join("\n\n");
    return { mode: "inline", entries, rendered };
  }

  const titles = entries.map((e) => ({ title: e.title, tags: e.tags }));
  const rendered = titles
    .map((t) => `- ${t.title}${t.tags.length ? `  [${t.tags.join(", ")}]` : ""}`)
    .join("\n");
  return { mode: "index", titles, rendered };
}

/**
 * Keyword search over the approved corpus.
 *
 * Scored in JavaScript over a plain fetch rather than in Postgres. That is a
 * deliberate trade for this stage: it is exact, it is trivially testable, and it
 * needs no tsvector column to drift out of sync with the text. It reads every
 * approved doc, which is fine into the hundreds and wrong in the thousands — at
 * which point this function is where embeddings go, and nothing that calls it
 * has to change.
 */
export async function searchKnowledge(
  db: TenantDb,
  tenantId: string,
  args: { query: string; tags?: string[]; limit?: number },
): Promise<KnowledgeEntry[]> {
  const docs = await db.knowledgeDoc.findMany({
    where: {
      tenantId,
      status: "approved",
      ...(args.tags?.length ? { tags: { hasSome: args.tags } } : {}),
    },
    select: { id: true, title: true, body: true, tags: true, version: true },
  });

  const terms = tokenise(args.query);
  if (terms.length === 0) return docs.slice(0, args.limit ?? 3).map((d) => ({ ...d, body: clamp(d.body) }));

  const scored = docs
    .map((doc) => {
      const title = tokenise(doc.title);
      const tags = tokenise(doc.tags.join(" "));
      const body = tokenise(doc.body);

      let score = 0;
      for (const term of terms) {
        // A title is the business's own phrasing of the question being asked,
        // so a hit there is worth far more than the same word buried in prose.
        if (title.includes(term)) score += 6;
        if (tags.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      return { doc, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, args.limit ?? 3);

  return scored.map(({ doc }) => ({ ...doc, body: clamp(doc.body) }));
}

/**
 * Stop words are dropped so that "do you do walk ins" does not match every
 * document containing the word "do". Kept short on purpose — an aggressive list
 * throws away terms that carry meaning in a short question.
 */
const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "have",
  "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "to", "was",
  "what", "when", "where", "which", "will", "with", "you", "your",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function clamp(body: string): string {
  return body.length <= MAX_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_BODY_CHARS)}\n\n[…truncated — ask a colleague for the rest]`;
}
