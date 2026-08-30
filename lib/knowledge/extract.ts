import { extractText, getDocumentProxy, getMeta } from "unpdf";

/**
 * Getting the words out of an uploaded document.
 *
 * Deliberately narrow: this returns text and says honestly when it could not.
 * It does not interpret, summarise or clean up — every transformation happens
 * later, where it is visible and reviewable, because a business that uploads a
 * price list and gets back subtly different numbers has been failed silently.
 *
 * `unpdf` rather than a native binding: it is a pure-JS build of pdf.js, so it
 * runs the same in a Next route, a worker, and on a serverless host with no
 * compilation step in the deploy.
 */

export type ExtractedPage = { page: number; text: string };

export type ExtractionResult =
  | { ok: true; pages: ExtractedPage[]; pageCount: number; title: string | null }
  | { ok: false; reason: ExtractionFailure; message: string };

/**
 * The failure a business actually hits is `no_text`: a brochure exported as
 * images, or a scan. It has to be named separately from a corrupt file, because
 * the fix is completely different — one needs OCR, the other needs a new file.
 */
export type ExtractionFailure = "unreadable" | "no_text" | "empty" | "too_large";

/** Guards a worker against a 400-page catalogue turning one upload into an hour. */
const MAX_PAGES = 300;

export async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  let pdf;
  try {
    // pdf.js takes OWNERSHIP of the buffer it is handed and detaches it — after
    // this call the caller's array has byteLength 0. Nothing downstream expects
    // that, and the failure it produces ("unreadable PDF" on a file that read
    // perfectly a moment ago) points nowhere near the cause. A copy costs one
    // allocation per upload and removes the whole class of bug.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    return {
      ok: false,
      reason: "unreadable",
      message: "That file could not be opened as a PDF. It may be damaged or password-protected.",
    };
  }

  if (pdf.numPages === 0) {
    return { ok: false, reason: "empty", message: "That PDF has no pages in it." };
  }
  if (pdf.numPages > MAX_PAGES) {
    return {
      ok: false,
      reason: "too_large",
      message: `That PDF has ${pdf.numPages} pages. Split it up and upload the parts separately — ${MAX_PAGES} is the limit.`,
    };
  }

  // `mergePages: false` gives one string per page, which is what makes it
  // possible to tell a reviewer which page a paragraph came from.
  const { text } = await extractText(pdf, { mergePages: false });
  const perPage = Array.isArray(text) ? text : [text];

  const pages: ExtractedPage[] = perPage
    .map((raw, i) => ({ page: i + 1, text: tidy(raw) }))
    .filter((p) => p.text.length > 0);

  if (pages.length === 0) {
    return {
      ok: false,
      reason: "no_text",
      message:
        "There's no text in that PDF — it looks like a scan or a set of images. " +
        "Export it from the original document, or type the key points in by hand.",
    };
  }

  let title: string | null = null;
  try {
    const meta = await getMeta(pdf);
    const raw = (meta.info as { Title?: unknown } | undefined)?.Title;
    if (typeof raw === "string" && raw.trim()) title = raw.trim().slice(0, 200);
  } catch {
    // A missing or malformed title is not a reason to reject a readable file.
  }

  return { ok: true, pages, pageCount: pdf.numPages, title };
}

/**
 * Repairs the artefacts of PDF text extraction, and stops there.
 *
 * Line structure is deliberately PRESERVED. An earlier version joined every
 * single newline into a space on the theory that they are layout breaks rather
 * than paragraph breaks — which is usually true, and which silently glued every
 * heading onto the paragraph below it. "ABOUT US\nNorthgate Motors has been…"
 * became one run of prose, the chunker never saw a heading, and nine sections
 * came out as five badly-cut passages.
 *
 * Deciding which line breaks are structural needs to know what a heading looks
 * like, and that lives in chunk.ts. So this does the unambiguous repairs only.
 */
function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Rejoin a word broken across a line by hyphenation.
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
