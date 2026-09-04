/**
 * Getting rows out of a spreadsheet somebody else owns.
 *
 * Two jobs, both duller and more failure-prone than they look: turning whatever
 * URL a person pasted into something fetchable, and parsing CSV properly.
 *
 * On authentication — cadence reads sheets one of two ways, and neither is
 * OAuth:
 *
 *   · a sheet shared as "anyone with the link can view", which Google will
 *     serve as CSV to an unauthenticated request
 *   · a sheet shared with a Google service account, whose key we hold
 *
 * Full OAuth would mean a Google-verified app and a consent screen a salon
 * owner has to read, to obtain access we do not want: OAuth would let us read
 * every sheet in their Drive. Sharing one sheet is both easier for them and a
 * narrower grant, which is the rare case where the simpler thing is also the
 * more careful one.
 */

/** A parsed sheet: the header row, and every row as a header→value record. */
export type SheetData = {
  headers: string[];
  rows: Record<string, string>[];
};

export class SheetError extends Error {
  constructor(
    message: string,
    /** What the owner should do about it, in their words. */
    readonly remedy: string,
  ) {
    super(message);
    this.name = "SheetError";
  }
}

/**
 * Turns a pasted Google Sheets URL into its CSV export endpoint.
 *
 * Accepts the two things people actually paste — the URL from the browser bar
 * while looking at the sheet, and the one the Share dialog copies — plus an
 * already-direct CSV link, so a published-to-web sheet or a CSV hosted anywhere
 * works without special handling.
 *
 * The `gid` matters more than it appears. It identifies the TAB, and a workbook
 * with "Services" and "Staff" as separate tabs will silently export the first
 * one if it is dropped — an import that reads real data from the wrong place,
 * which is far worse than one that fails.
 */
export function resolveSheetUrl(input: string): { fetchUrl: string; gid: string | null } {
  const url = input.trim();
  if (!url) throw new SheetError("No link given.", "Paste the link to your spreadsheet.");

  const sheets = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (sheets) {
    const id = sheets[1];
    // The tab id lives in the fragment when copied from the browser bar, and in
    // the query when copied from some share links.
    const gid = url.match(/[#&?]gid=([0-9]+)/)?.[1] ?? null;
    const fetchUrl =
      `https://docs.google.com/spreadsheets/d/${id}/export?format=csv` +
      (gid ? `&gid=${gid}` : "");
    return { fetchUrl, gid };
  }

  // Any other https URL is taken at its word — a published CSV, an export from
  // Zoho or Zenoti parked somewhere fetchable, an internal endpoint. The
  // pipeline past this point does not care where rows came from.
  if (/^https?:\/\//i.test(url)) return { fetchUrl: url, gid: null };

  throw new SheetError(
    "That does not look like a link.",
    "Paste the whole address from your browser while the spreadsheet is open — it should start with https://",
  );
}

/**
 * Fetches the sheet and returns its text.
 *
 * Google answers an unshared sheet with a redirect to a sign-in page rather than
 * a 403, so a naive fetch succeeds and returns HTML. Anything that is not CSV is
 * therefore treated as "we cannot see this", with the fix stated — that single
 * case is most of the support burden this feature would otherwise create.
 */
export async function fetchSheet(
  fetchUrl: string,
  opts: { accessToken?: string } = {},
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      redirect: "follow",
      headers: opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {},
    });
  } catch {
    throw new SheetError(
      "Could not reach the spreadsheet.",
      "Check the link opens in your own browser, then try again.",
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new SheetError(
      `The spreadsheet refused us (HTTP ${res.status}).`,
      "In Google Sheets, press Share, then under General access choose “Anyone with the link” as Viewer.",
    );
  }
  if (!res.ok) {
    throw new SheetError(
      `The spreadsheet could not be read (HTTP ${res.status}).`,
      "Check the link is still correct and the sheet has not been deleted.",
    );
  }

  const text = await res.text();

  // A sign-in page, served with a 200.
  const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    throw new SheetError(
      "Google returned a sign-in page instead of the sheet, which means it is private to you.",
      "In Google Sheets, press Share, then under General access choose “Anyone with the link” as Viewer. Nobody can find the link unless you give it to them.",
    );
  }

  if (!text.trim()) {
    throw new SheetError("The sheet is empty.", "Add your rows to the sheet and sync again.");
  }

  return text;
}

/**
 * RFC 4180 CSV, parsed properly rather than by splitting on commas.
 *
 * Hand-written because the alternative is a dependency, and the cases that
 * matter are few and well-defined: quoted fields containing commas ("Cut &
 * Finish, long hair"), escaped quotes inside them, and newlines inside a quoted
 * cell — which is what a wrapped description in a spreadsheet actually is.
 * Splitting on commas gets all three wrong, and gets them wrong quietly, which
 * for a price list means a number landing in the wrong column.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  // A leading BOM is normal from Excel and would otherwise become part of the
  // first header, so "Name" never matches.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // A trailing newline would otherwise add an empty final row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      // \r\n and a lone \r both end a row.
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }

    field += c;
    i++;
  }

  // Whatever is left when the text ends is a final row, unless it is nothing.
  if (field !== "" || row.length > 0) pushRow();

  return rows;
}

/**
 * Turns the grid into headers plus records.
 *
 * Two accommodations for real spreadsheets, both learned the hard way from the
 * shape people actually keep:
 *
 *   · leading blank or decorative rows are skipped to find the real header —
 *     a title row and a blank line above the table is the normal look of a
 *     sheet a human maintains rather than one a machine wrote
 *   · a column with no header gets a positional name instead of being dropped,
 *     so it can still be mapped if it turns out to hold something
 */
export function toRecords(grid: string[][]): SheetData {
  // The header is the first row with at least two non-empty cells. One cell is
  // a title; two is a table.
  const headerIndex = grid.findIndex((r) => r.filter((c) => c.trim()).length >= 2);
  if (headerIndex === -1) {
    throw new SheetError(
      "No table found in the sheet.",
      "The first row should be your column headings — something like Name, Price, Duration.",
    );
  }

  const seen = new Map<string, number>();
  const headers = grid[headerIndex].map((h, i) => {
    const name = h.trim() || `Column ${i + 1}`;
    // Duplicate headings are common and would otherwise silently overwrite each
    // other, leaving one of two real columns unreachable.
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });

  const rows: Record<string, string>[] = [];
  for (const line of grid.slice(headerIndex + 1)) {
    if (line.every((c) => !c.trim())) continue; // blank spacer row
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = (line[i] ?? "").trim();
    });
    rows.push(record);
  }

  return { headers, rows };
}

/** The whole read, end to end. */
export async function readSheet(
  fetchUrl: string,
  opts: { accessToken?: string } = {},
): Promise<SheetData> {
  return toRecords(parseCsv(await fetchSheet(fetchUrl, opts)));
}
