import type { ExtractedPage } from "./extract";

/**
 * Splitting a document into pieces a customer's question can match.
 *
 * The unit is a **passage that answers something**, not a fixed token count.
 * Fixed-size windows are simpler and are what most pipelines do, but they cut
 * sentences in half, and a chunk beginning "…and that includes the first
 * service" is worse than useless when a model quotes it at a customer.
 *
 * So: paragraphs are the atom, they are packed up to a target size, and a
 * paragraph is only ever split when it alone exceeds the maximum — at which
 * point it is split on sentence boundaries.
 *
 * Chunks do NOT overlap. Overlap exists to stop a fixed-size window losing the
 * sentence that straddles its boundary; packing whole paragraphs has no such
 * boundary to lose, and duplicated text in a reviewed corpus means a person
 * approves the same sentence twice and sees it quoted back doubled.
 */

export type Chunk = {
  /** 1-based, in document order. */
  index: number;
  page: number;
  text: string;
  /** A heading found immediately above this passage, when there was one. */
  heading: string | null;
};

/** Target size in characters. ~250 tokens: big enough to answer, small enough to be read. */
const TARGET_CHARS = 1_000;
const MAX_CHARS = 1_800;
/** Below this a passage is a caption, a page number or a stray label. */
const MIN_CHARS = 120;

/**
 * Rebuilds paragraphs from extracted lines.
 *
 * A PDF gives no paragraph markup — only line breaks, most of which are the
 * layout engine wrapping text and some of which are real structure. The rule
 * used here: a line break is structural if either side of it is a heading, or if
 * the line before it ended a sentence AND the next line starts one. Everything
 * else is a wrap and gets joined with a space.
 *
 * Blank lines, where the extractor produced them, are always structural.
 */
function paragraphsFrom(text: string): string[] {
  const blocks = text.split(/\n{2,}/);
  const paragraphs: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    let current: string[] = [];

    const flush = () => {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    };

    for (const line of lines) {
      if (looksLikeHeading(line)) {
        // A heading stands alone on both sides — it belongs to neither the
        // paragraph above nor the one below.
        flush();
        paragraphs.push(line);
        continue;
      }
      const previous = current[current.length - 1];
      if (previous && /[.!?:]$/.test(previous) && /^[A-Z"'“]/.test(line)) flush();
      current.push(line);
    }
    flush();
  }

  return paragraphs.map((p) => p.trim()).filter(Boolean);
}

export function chunkPages(pages: ExtractedPage[]): Chunk[] {
  const chunks: Chunk[] = [];

  for (const page of pages) {
    const paragraphs = paragraphsFrom(page.text);

    let buffer: string[] = [];
    let heading: string | null = null;
    let bufferHeading: string | null = null;

    const flush = () => {
      if (buffer.length === 0) return;
      const text = buffer.join("\n\n").trim();
      buffer = [];
      if (text.length < MIN_CHARS) return; // too small to answer anything
      chunks.push({ index: chunks.length + 1, page: page.page, text, heading: bufferHeading });
    };

    for (const paragraph of paragraphs) {
      // A heading is not content — it is the label for what follows, so it is
      // carried onto the next chunk rather than becoming one.
      if (looksLikeHeading(paragraph)) {
        flush();
        heading = paragraph.replace(/[:.]\s*$/, "");
        continue;
      }

      if (buffer.length === 0) bufferHeading = heading;

      const projected = buffer.join("\n\n").length + paragraph.length;

      if (paragraph.length > MAX_CHARS) {
        // One enormous paragraph — the only case where a sentence-level split
        // is the lesser evil.
        flush();
        for (const piece of splitSentences(paragraph)) {
          bufferHeading = heading;
          buffer = [piece];
          flush();
        }
        continue;
      }

      if (projected > TARGET_CHARS && buffer.length > 0) flush();
      if (buffer.length === 0) bufferHeading = heading;
      buffer.push(paragraph);
    }

    flush();
  }

  return chunks.map((c, i) => ({ ...c, index: i + 1 }));
}

/**
 * Headings in extracted PDF text have no markup, so this is heuristic and
 * deliberately conservative: a false negative costs a slightly less useful
 * title, whereas a false positive silently deletes a line of real content.
 */
function looksLikeHeading(text: string): boolean {
  if (text.length > 90) return false;
  if (text.includes("\n")) return false;
  // Ends like a sentence → it is a sentence.
  if (/[.!?]$/.test(text)) return false;
  // ALL CAPS, or Title Case With Several Capitalised Words, or a numbered
  // section like "3.1 Financing options".
  if (/^[A-Z0-9][A-Z0-9\s&/,'’()-]{3,}$/.test(text)) return true;
  if (/^\d+(\.\d+)*\s+\S/.test(text)) return true;
  const words = text.split(/\s+/);
  if (words.length <= 8 && words.filter((w) => /^[A-Z]/.test(w)).length >= words.length - 1) {
    return true;
  }
  return false;
}

/** Packs sentences up to the target rather than cutting at an arbitrary offset. */
function splitSentences(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > TARGET_CHARS && current) {
      out.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
