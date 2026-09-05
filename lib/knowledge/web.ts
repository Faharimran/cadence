/**
 * Reading a business's own website.
 *
 * The output is `ExtractedPage[]` — the same shape the PDF extractor produces —
 * so everything downstream is already built: chunking, titling, the draft state,
 * and the approval gate that stops any of it reaching a customer unread.
 *
 * Two things here are load-bearing and neither is about HTML.
 *
 * **This fetches a URL a stranger typed.** That is the classic way a server
 * becomes a proxy into its own private network: `http://169.254.169.254/` is
 * cloud instance metadata, `http://localhost:5432` is our database, and
 * `http://10.0.0.5/admin` is whatever else shares the network. Every hostname is
 * resolved and checked before a request goes out, and checked again after every
 * redirect, because a public hostname is free to redirect to a private one.
 *
 * **It is somebody else's server.** robots.txt is honoured, requests are
 * sequential with a pause between them, and the crawl is bounded in both pages
 * and depth. A knowledge importer that hammers a small business's shared hosting
 * is a knowledge importer that gets the whole product blocked.
 */
import { lookup } from "node:dns/promises";
import type { ExtractedPage } from "./extract";

export class WebSourceError extends Error {
  constructor(
    message: string,
    /** What the owner should do about it, in their words. */
    readonly remedy: string,
  ) {
    super(message);
    this.name = "WebSourceError";
  }
}

const MAX_PAGES = 25;
const MAX_DEPTH = 2;
const MAX_BYTES_PER_PAGE = 2_000_000;
const PAUSE_MS = 400;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const UA =
  "cadence-knowledge/1.0 (+reads a business's own site, at their request, on their instruction)";

// ── Where we refuse to go ─────────────────────────────────────────────

/**
 * Private, loopback, link-local and other non-public address space.
 *
 * Written out rather than pulled from a library because the list is short,
 * stable, and the consequence of getting it wrong is handing anyone with a
 * signed-in account the ability to read our internal network through us.
 */
function isPrivateAddress(ip: string, family: number): boolean {
  if (family === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local
    if (v.startsWith("fe80")) return true; // link-local
    // IPv4 mapped into IPv6 — ::ffff:127.0.0.1 must not slip past the v4 rules.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    return false;
  }

  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;

  if (a === 0) return true; // this network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Refuses anything that is not a public web address.
 *
 * Resolved rather than pattern-matched, because `db.internal` and
 * `metadata.google.internal` look like ordinary hostnames and resolve to
 * addresses we must not touch.
 *
 * There is an unavoidable gap between this check and the request itself: DNS
 * could change in between. Closing it entirely means resolving here and
 * connecting to the pinned address, which fetch does not expose. The exposure
 * is small, requires an attacker who controls DNS for a domain they also
 * persuaded a signed-in owner to paste, and the redirect re-check below closes
 * the practical version of it.
 */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebSourceError(
      `${url.protocol} links cannot be read.`,
      "Give a normal website address starting with https://",
    );
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new WebSourceError(
      `We could not find ${url.hostname}.`,
      "Check the address is spelled correctly and the site is online.",
    );
  }

  // ALL of them. A hostname resolving to one public and one private address is
  // a deliberate attack, not a misconfiguration.
  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new WebSourceError(
        `${url.hostname} points inside a private network.`,
        "Only public websites can be read.",
      );
    }
  }
}

// ── Politeness ────────────────────────────────────────────────────────

/**
 * The subset of robots.txt that matters: which paths we are asked not to fetch.
 *
 * Deliberately simple, and deliberately errs toward obeying. Sitemap, crawl-delay
 * and wildcards beyond `*` and `$` are ignored; a rule we do not understand is
 * treated as a rule to respect rather than one to skip.
 */
export function parseRobots(text: string): { disallow: string[]; allow: string[] } {
  const disallow: string[] = [];
  const allow: string[] = [];
  let applies = false;

  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = field.trim().toLowerCase();

    if (key === "user-agent") {
      // A new group starts; we only care about the one addressed to everybody.
      applies = value === "*";
      continue;
    }
    if (!applies) continue;
    if (key === "disallow" && value) disallow.push(value);
    if (key === "allow" && value) allow.push(value);
  }

  return { disallow, allow };
}

function pathMatches(rule: string, path: string): boolean {
  // robots.txt wildcards: * is any run, $ anchors the end.
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$") ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return false;
  }
}

export function robotsAllows(
  robots: { disallow: string[]; allow: string[] },
  path: string,
): boolean {
  // Allow wins over Disallow when it is more specific, which is the convention.
  const longestAllow = robots.allow.filter((r) => pathMatches(r, path)).sort((a, b) => b.length - a.length)[0];
  const longestDisallow = robots.disallow
    .filter((r) => pathMatches(r, path))
    .sort((a, b) => b.length - a.length)[0];

  if (!longestDisallow) return true;
  if (longestAllow && longestAllow.length >= longestDisallow.length) return true;
  return false;
}

// ── Fetching ──────────────────────────────────────────────────────────

/**
 * One page, with every redirect re-checked.
 *
 * `redirect: "manual"` rather than "follow", because a public host is perfectly
 * free to redirect to `http://169.254.169.254/` and letting fetch follow it
 * would skip the whole guard above.
 */
async function fetchPage(url: URL): Promise<{ html: string; finalUrl: URL } | null> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      });
    } catch {
      return null; // one unreachable page must not abandon the crawl
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      current = new URL(location, current);
      continue;
    }

    if (!res.ok) return null;

    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;

    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES_PER_PAGE) return null;

    const html = await res.text();
    if (html.length > MAX_BYTES_PER_PAGE) return null;

    return { html, finalUrl: current };
  }

  return null;
}

// ── HTML → words ──────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  eacute: "é", pound: "£", euro: "€", copy: "©", reg: "®", trade: "™", deg: "°",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
    return whole;
  });
}

/**
 * The readable words on a page, without the furniture.
 *
 * Navigation, cookie banners and footers repeat on every page of a site. Left
 * in, they become the most "important" text in the corpus by sheer frequency,
 * and the assistant ends up answering questions with menu labels. So they are
 * dropped by tag, and `<main>` or `<article>` is preferred outright when the
 * site provides one.
 *
 * Headings are kept as headings because the chunker uses them to decide where
 * one idea ends and the next begins.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

  let body = html;

  // Anything that is not prose, gone first — including its contents.
  body = body.replace(
    /<(script|style|noscript|svg|canvas|iframe|template|form|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  body = body.replace(/<!--[\s\S]*?-->/g, " ");

  // If the site marks its own content, trust it — that alone removes the
  // navigation, the cookie banner and the footer without guessing.
  const main = body.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (main) body = main[1];
  else {
    body = body.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  }

  // Structure worth keeping, as markdown the chunker already understands.
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _l, inner: string) => {
    const t = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    return t ? `\n\n## ${t}\n` : "\n";
  });
  body = body.replace(/<li\b[^>]*>/gi, "\n- ");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = body.replace(/<\/(p|div|section|tr|ul|ol|table|h[1-6])>/gi, "\n\n");

  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);

  const text = body
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}

/** Same-origin links worth following, in the order they appear. */
export function discoverLinks(html: string, base: URL): URL[] {
  const found: URL[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(m[1], base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    // A fragment is the same page; a query is usually a filter, a sort, or a
    // calendar that goes on forever.
    url.hash = "";
    url.search = "";

    // Files, not pages.
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|css|js)$/i.test(url.pathname)) {
      continue;
    }

    const key = url.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(url);
  }

  return found;
}

// ── The crawl ─────────────────────────────────────────────────────────

export type CrawlResult = {
  pages: ExtractedPage[];
  /** URL per page index, so a reviewer can see where a chunk came from. */
  urls: string[];
  siteTitle: string;
  skipped: { url: string; why: string }[];
};

export function normaliseSiteUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) throw new WebSourceError("No address given.", "Paste your website address.");

  // People paste "cara.clinic" as often as they paste the full thing.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WebSourceError(
      `“${raw}” is not a web address.`,
      "It should look like https://yourbusiness.com",
    );
  }
  if (!url.hostname.includes(".")) {
    throw new WebSourceError(
      `“${raw}” is not a web address.`,
      "It should look like https://yourbusiness.com",
    );
  }

  url.hash = "";
  return url;
}

/**
 * How a page is obtained. Injectable for one reason only: the guard above
 * correctly refuses loopback, which means a test fixture server cannot be
 * crawled — and without this the queue, the depth limit, the de-duplication and
 * the thin-page rule would all go unproven.
 *
 * The guard is NOT the thing being replaced. It lives inside the default
 * fetcher, production has no way to pass anything else, and the assertions that
 * cover it call `crawlSite` with no fetcher at all.
 */
export type PageFetcher = (url: URL) => Promise<{ html: string; finalUrl: URL } | null>;

export async function crawlSite(
  start: URL,
  opts: { maxPages?: number; maxDepth?: number; fetcher?: PageFetcher } = {},
): Promise<CrawlResult> {
  const getPage = opts.fetcher ?? fetchPage;
  const maxPages = Math.min(opts.maxPages ?? MAX_PAGES, MAX_PAGES);
  const maxDepth = Math.min(opts.maxDepth ?? MAX_DEPTH, MAX_DEPTH);

  // Skipped only when a fetcher was injected, which production cannot do.
  if (!opts.fetcher) await assertPublicUrl(start);

  // robots.txt first, and a site that forbids us is not an error to argue with.
  let robots = { disallow: [] as string[], allow: [] as string[] };
  try {
    const res = await fetch(new URL("/robots.txt", start), {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) robots = parseRobots(await res.text());
  } catch {
    // No robots.txt is permission, not refusal.
  }

  if (!robotsAllows(robots, start.pathname)) {
    throw new WebSourceError(
      "That site asks automated readers not to read it.",
      "Its robots.txt disallows this page. Upload a document instead, or ask whoever runs the site.",
    );
  }

  const queue: { url: URL; depth: number }[] = [{ url: start, depth: 0 }];
  const visited = new Set<string>([start.toString().replace(/\/$/, "")]);
  const pages: ExtractedPage[] = [];
  const urls: string[] = [];
  const skipped: { url: string; why: string }[] = [];
  let siteTitle = "";

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift()!;

    if (!robotsAllows(robots, url.pathname)) {
      skipped.push({ url: url.toString(), why: "robots.txt asks us not to read this page" });
      continue;
    }

    const fetched = await getPage(url);
    // Sequential, with a pause. This is somebody's shared hosting, and a burst
    // of parallel requests is how a knowledge import becomes an outage.
    await new Promise((r) => setTimeout(r, PAUSE_MS));

    if (!fetched) {
      skipped.push({ url: url.toString(), why: "could not be read" });
      continue;
    }

    const { title, text } = htmlToText(fetched.html);
    if (!siteTitle) siteTitle = title;

    // Below this, a page is a menu, a gallery or a contact form — nothing that
    // answers a question, and every one of them costs a titling call.
    if (text.length >= 200) {
      pages.push({ page: pages.length + 1, text: title ? `## ${title}\n\n${text}` : text });
      urls.push(fetched.finalUrl.toString());
    } else {
      skipped.push({ url: url.toString(), why: "too little text to be worth reading" });
    }

    if (depth < maxDepth) {
      for (const link of discoverLinks(fetched.html, start)) {
        const key = link.toString().replace(/\/$/, "");
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  if (pages.length === 0) {
    throw new WebSourceError(
      "We could not find any readable text on that site.",
      "If the pages are built entirely in JavaScript, we cannot see them — upload a brochure or price list instead.",
    );
  }

  return { pages, urls, siteTitle, skipped };
}
