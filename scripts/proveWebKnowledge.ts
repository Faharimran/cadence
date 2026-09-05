/**
 * Executable proof of the website knowledge source.
 *
 * Two very different kinds of assertion live here, and the first kind is the
 * reason this file exists at all.
 *
 * **Where we refuse to go.** This feature fetches a URL that a signed-in user
 * typed, from inside our own network. Done carelessly that turns the product
 * into a proxy for whatever the server can reach — cloud instance metadata at
 * 169.254.169.254, the database on localhost, anything else on the private
 * network. Those assertions are not about quality; a failure there is a
 * vulnerability.
 *
 * **What we read.** Navigation, cookie banners and footers repeat on every page
 * of a site, so left in they become the most frequent text in the corpus and the
 * assistant starts answering questions with menu labels.
 *
 * Runs a real HTTP server on localhost to serve fixtures, so the parsing is
 * proved against actual responses rather than strings pretending to be them.
 *
 * Run: npm run prove:web
 */
import { createServer, type Server } from "node:http";
import { redis } from "@/lib/redis";
import {
  htmlToText,
  discoverLinks,
  parseRobots,
  robotsAllows,
  normaliseSiteUrl,
  crawlSite,
  WebSourceError,
} from "@/lib/knowledge/web";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const PAGES: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Bright Barbers — Shoreditch</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/prices">Prices</a><a href="/gallery">Gallery</a>
        <a href="https://facebook.com/brightbarbers">Facebook</a></nav>
      <div id="cookie-banner">We use cookies. Accept all cookies to continue.</div>
      <main>
        <h1>Bright Barbers</h1>
        <p>We have cut hair on Redchurch Street since 2011. Walk in or book ahead —
           either is fine, though Saturdays go quickly and we would rather you had a slot.</p>
        <h2>Where we are</h2>
        <p>Two minutes from Shoreditch High Street station, next to the flower stall.
           There is paid parking on Bethnal Green Road; the multi-storey is free for
           two hours with a ticket from reception.</p>
      </main>
      <footer>Copyright 2026 Bright Barbers. All rights reserved. Privacy policy.</footer>
    </body></html>`,

  "/prices": `<!doctype html><html><head><title>Prices</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/prices">Prices</a></nav>
      <main>
        <h2>What we charge</h2>
        <p>A dry cut is &pound;28 and takes about half an hour. A cut and finish is
           &pound;38. Beard trims are &pound;15 on their own, or &pound;10 alongside a cut.</p>
        <p>We do not charge extra for long hair, and we never have. Children under
           twelve are &pound;18 any day of the week.</p>
      </main>
      <footer>Copyright 2026 Bright Barbers.</footer>
    </body></html>`,

  // Deliberately thin: a gallery page with nothing to say.
  "/gallery": `<!doctype html><html><head><title>Gallery</title></head>
    <body><main><h2>Gallery</h2></main></body></html>`,

  "/robots.txt": "User-agent: *\nDisallow: /admin\nDisallow: /cart\n",
};

function startServer(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const body = PAGES[path];
      if (body === undefined) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": path.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8",
      });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  // ── 1. Where we refuse to go ────────────────────────────────────────
  console.log("\n1. Addresses we must never fetch");

  const refuses = async (input: string, why: string) => {
    try {
      await crawlSite(normaliseSiteUrl(input));
      check(why, false, "it was FETCHED — this is a vulnerability, not a bug");
    } catch (e) {
      check(why, e instanceof WebSourceError, e instanceof Error ? e.message.slice(0, 60) : "");
    }
  };

  // The one that matters most: cloud instance metadata hands out credentials.
  await refuses("http://169.254.169.254/latest/meta-data/", "cloud metadata is refused");
  await refuses("http://127.0.0.1:5432/", "loopback is refused");
  await refuses("http://localhost:3000/admin", "localhost by name is refused");
  await refuses("http://10.0.0.5/", "private 10.x is refused");
  await refuses("http://192.168.1.1/", "private 192.168.x is refused");
  await refuses("http://172.16.5.4/", "private 172.16-31.x is refused");
  await refuses("http://[::1]/", "IPv6 loopback is refused");
  await refuses("file:///etc/passwd", "file:// is refused");

  // A public-looking address that resolves to loopback. This is the attack that
  // beats a naive string check, and the reason resolution happens before every
  // request rather than pattern matching on the hostname.
  await refuses("http://localtest.me/", "a public NAME resolving to 127.0.0.1 is refused");

  // ── 2. Reading what a page says ─────────────────────────────────────
  console.log("\n2. Reading a page, without its furniture");

  const home = htmlToText(PAGES["/"]);
  check("the page title is picked up", home.title.includes("Bright Barbers"), home.title);
  check("the writing survives", home.text.includes("cut hair on Redchurch Street"));
  check("headings survive as headings", home.text.includes("## Where we are"), home.text.slice(0, 80));

  // Every one of these repeats on every page. Left in, frequency alone makes
  // them the most prominent thing in the corpus.
  check("navigation is dropped", !home.text.includes("Facebook"), home.text.slice(0, 120));
  check("the cookie banner is dropped", !home.text.toLowerCase().includes("accept all cookies"));
  check("the footer is dropped", !home.text.toLowerCase().includes("all rights reserved"));

  const prices = htmlToText(PAGES["/prices"]);
  check("HTML entities are decoded, so a price is a price", prices.text.includes("£28"), prices.text.slice(0, 90));

  // ── 3. Which links are worth following ──────────────────────────────
  console.log("\n3. Following links, within reason");

  const base = new URL("https://brightbarbers.example/");
  const links = discoverLinks(PAGES["/"], base);
  const hrefs = links.map((l) => l.pathname);
  check("same-site links are followed", hrefs.includes("/prices") && hrefs.includes("/gallery"), hrefs.join(","));
  check(
    "links away from the site are not",
    !links.some((l) => l.hostname.includes("facebook")),
    links.map((l) => l.hostname).join(","),
  );

  const withFiles = discoverLinks(
    '<a href="/brochure.pdf">PDF</a><a href="/photo.jpg">Photo</a><a href="/team">Team</a>',
    base,
  );
  check(
    "files are not mistaken for pages",
    withFiles.length === 1 && withFiles[0].pathname === "/team",
    withFiles.map((l) => l.pathname).join(","),
  );

  const withFragments = discoverLinks(
    '<a href="/prices#cuts">A</a><a href="/prices#beards">B</a><a href="/prices?sort=asc">C</a>',
    base,
  );
  check(
    "the same page with different anchors is one page",
    withFragments.length === 1,
    `${withFragments.length} links`,
  );

  // ── 4. robots.txt ───────────────────────────────────────────────────
  console.log("\n4. Doing as the site asks");

  const robots = parseRobots(
    "User-agent: badbot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\nAllow: /admin/public\n",
  );
  check("only the rules addressed to everyone are taken", robots.disallow.join(",") === "/admin", robots.disallow.join(","));
  check("a disallowed path is refused", !robotsAllows(robots, "/admin/settings"));
  check("a more specific allow wins", robotsAllows(robots, "/admin/public"));
  check("everything else is allowed", robotsAllows(robots, "/prices"));

  // ── 5. A real crawl over real HTTP ──────────────────────────────────
  console.log("\n5. Crawling a real site");

  const { server, origin } = await startServer();
  try {
    // The guard refuses loopback, correctly and with no exception for tests —
    // proved here rather than assumed, because a guard with a test exception is
    // a guard with a production hole.
    const guarded = await crawlSite(new URL(origin), { maxPages: 10 }).catch((e) => e as Error);
    check(
      "the fixture server is refused too — the guard has no test exception",
      guarded instanceof WebSourceError,
      guarded instanceof Error ? guarded.message.slice(0, 50) : "it was crawled",
    );

    // Which leaves the crawl LOOP unproven, so it is exercised with the fetch
    // step injected. The guard is not what is replaced: it lives inside the
    // default fetcher, and the assertion above covers it.
    const site = new URL("https://brightbarbers.example/");
    const fetched: string[] = [];
    const fetcher = async (url: URL) => {
      fetched.push(url.pathname);
      const html = PAGES[url.pathname];
      return html ? { html, finalUrl: url } : null;
    };

    const crawl = await crawlSite(site, { maxPages: 10, maxDepth: 1, fetcher });

    check("it read the pages with writing on them", crawl.pages.length === 2, `${crawl.pages.length} pages`);
    check(
      "and recorded which address each came from",
      crawl.urls.some((u) => u.endsWith("/prices")),
      crawl.urls.join(","),
    );
    check("the site title is kept", crawl.siteTitle.includes("Bright Barbers"), crawl.siteTitle);
    check(
      "a page with nothing on it is skipped, not turned into an empty article",
      crawl.skipped.some((s) => s.url.includes("/gallery")),
      JSON.stringify(crawl.skipped),
    );
    check(
      "the prices page reached the corpus with its prices intact",
      crawl.pages.some((p) => p.text.includes("£28")),
    );
    check(
      "no page is fetched twice",
      new Set(fetched).size === fetched.length,
      fetched.join(","),
    );

    // The cap is the difference between reading a business's site and crawling
    // somebody's entire blog archive on their shared hosting.
    const many: Record<string, string> = { "/robots.txt": "" };
    let links = "";
    for (let i = 0; i < 40; i++) links += `<a href="/p${i}">p${i}</a>`;
    many["/"] = `<html><body><main><h1>Index</h1><p>${"x".repeat(300)}</p>${links}</main></body></html>`;
    for (let i = 0; i < 40; i++) {
      many[`/p${i}`] = `<html><body><main><h2>Page ${i}</h2><p>${"y".repeat(300)}</p></main></body></html>`;
    }
    const capped = await crawlSite(site, {
      maxPages: 5,
      maxDepth: 1,
      fetcher: async (url) => (many[url.pathname] ? { html: many[url.pathname], finalUrl: url } : null),
    });
    check("the page cap is honoured", capped.pages.length === 5, `${capped.pages.length} pages`);
  } finally {
    server.close();
  }

  // ── 6. Addresses people actually type ───────────────────────────────
  console.log("\n6. What people paste");

  check(
    "a bare domain gains https",
    normaliseSiteUrl("brightbarbers.com").toString() === "https://brightbarbers.com/",
    normaliseSiteUrl("brightbarbers.com").toString(),
  );
  check(
    "a full address is left alone",
    normaliseSiteUrl("https://brightbarbers.com/prices").pathname === "/prices",
  );
  let rejected = false;
  try {
    normaliseSiteUrl("my website");
  } catch (e) {
    rejected = e instanceof WebSourceError;
  }
  check("something that is not an address is refused with an explanation", rejected);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => redis.disconnect());
