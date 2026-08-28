/**
 * Proves the admin UI's authentication and tenant scoping.
 *
 * Two halves: the crypto primitives, tested directly, and the rendered pages,
 * tested over HTTP with a genuine minted cookie. The second half matters —
 * verifying only the primitives leaves you confident about code that a
 * misconfigured route never actually calls.
 *
 * Requires: npm run dev   Run: npm run prove:auth
 */
import { adminDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { hashPassword, verifyPassword, passwordProblem } from "@/lib/auth/password";
import { encrypt, decrypt, isEncrypted } from "@/lib/crypto";
import { mintToken, readTokenValue, SESSION_COOKIE } from "@/lib/auth/session";

const BASE = process.env.CADENCE_TEST_URL ?? "http://localhost:3111";

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

async function get(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function main() {
  // ── 1. Passwords ────────────────────────────────────────────────────
  console.log("\n1. Passwords");
  const hash = await hashPassword("correct-horse-battery");
  check("hash is salted scrypt, not a bare digest", hash.startsWith("scrypt$"));
  check("the plaintext never appears in the hash", !hash.includes("correct-horse"));
  check("the right password verifies", await verifyPassword("correct-horse-battery", hash));
  check("a wrong password does not", !(await verifyPassword("wrong", hash)));

  const second = await hashPassword("correct-horse-battery");
  check("the same password hashes differently each time (per-user salt)", hash !== second);
  check("a short password is refused", passwordProblem("short") !== null);
  check("garbage in the stored field fails closed", !(await verifyPassword("x", "nonsense")));

  // ── 1b. Secrets at rest ─────────────────────────────────────────────
  console.log("\n1b. Stored credentials");
  const token = "EAAG-a-real-looking-whatsapp-token";
  const sealed = encrypt(token);
  check("ciphertext is versioned", sealed.startsWith("v1."));
  check("the plaintext is not in it", !sealed.includes("a-real-looking"));
  check("it round-trips", decrypt(sealed) === token);
  check("encrypting twice gives different ciphertext", encrypt(token) !== sealed);
  check("both still decrypt to the same thing", decrypt(encrypt(token)) === token);
  check("plaintext is recognised as unencrypted", !isEncrypted(token));

  // Authenticated encryption: a flipped byte must fail loudly rather than
  // silently yielding garbage that then gets sent to Meta as a token.
  const [v, iv, tag, ct] = sealed.split(".");
  let tamperCaught = false;
  try {
    decrypt(`${v}.${iv}.${tag}.${ct.slice(0, -2)}AA`);
  } catch {
    tamperCaught = true;
  }
  check("a tampered ciphertext throws rather than returning garbage", tamperCaught);

  // The migration affordance: a not-yet-encrypted value still reads.
  check("legacy plaintext passes through during migration", decrypt(token) === token);

  const stillClear = await adminDb.channelAccount.count();
  const clearRows = await adminDb.channelAccount.findMany({
    select: { accessToken: true, appSecret: true, verifyToken: true },
  });
  const anyClear = clearRows.some((r) =>
    [r.accessToken, r.appSecret, r.verifyToken].some((v) => v && !isEncrypted(v)),
  );
  check(
    `no stored credential is in the clear (${stillClear} account row(s))`,
    !anyClear,
    "run npm run db:encrypt -- --apply",
  );

  // ── 2. Session tokens ───────────────────────────────────────────────
  console.log("\n2. Session tokens");
  const sessionToken = mintToken("user_1", "tenant_1");
  const claims = readTokenValue(sessionToken);
  check("a minted token decodes", claims?.userId === "user_1" && claims?.tenantId === "tenant_1");

  const [payload, signature] = sessionToken.split(".");
  const swapped = Buffer.from(
    JSON.stringify({ userId: "user_1", tenantId: "SOMEONE_ELSE", iat: 0, exp: 9e9 }),
    "utf8",
  ).toString("base64url");
  check(
    "a tampered payload is rejected even with the original signature",
    readTokenValue(`${swapped}.${signature}`) === null,
  );
  check("a tampered signature is rejected", readTokenValue(`${payload}.AAAA`) === null);
  check("nonsense is rejected", readTokenValue("not-a-token") === null);
  check("an expired token is rejected", readTokenValue(mintToken("u", "t", -60)) === null);

  // ── 3. Route gating ─────────────────────────────────────────────────
  console.log("\n3. Route gating");
  const anon = await get("/admin");
  check("/admin redirects a signed-out visitor", anon.status === 307);
  check("and remembers where they were going", anon.location?.includes("next=%2Fadmin") === true);

  const forged = await get("/admin", `${swapped}.${signature}`);
  check("a forged cookie does not get in", forged.status === 307, String(forged.status));

  const root = await get("/");
  check("/ no longer lists tenants — it just forwards", root.status === 307);

  // ── 4. A real session ───────────────────────────────────────────────
  console.log("\n4. A real session");
  const user = await adminDb.user.findUnique({
    where: { email: "owner@demo.studio" },
    include: { tenant: true },
  });
  if (!user) {
    check("seed user exists (npm run user -- demo-studio …)", false);
  } else {
    const good = mintToken(user.id, user.tenantId);

    const dash = await get("/admin", good);
    check("the dashboard renders", dash.status === 200, String(dash.status));
    check("and shows the tenant", dash.body.includes(user.tenant.name));

    // The setup checklist is what turns nine screens into a guided experience,
    // so it needs to actually reach the page — not merely compute correctly.
    check(
      "the dashboard shows outstanding setup steps in plain language",
      dash.body.includes("Connect WhatsApp"),
      "checklist missing from the rendered page",
    );
    check(
      "and does not use schema words for them",
      !dash.body.includes("ScheduleRule") && !dash.body.includes("ChannelAccount"),
    );

    const exceptions = await get("/admin/exceptions", good);
    check("leave & closures renders", exceptions.status === 200, String(exceptions.status));
    check(
      "with the tenant's own exception types",
      exceptions.body.includes("Special opening") || exceptions.body.includes("Closed"),
    );

    // A cookie signed for the right user but claiming a different tenant must
    // not be usable — this is the check that stops a swapped id from crossing
    // the boundary.
    const mismatched = mintToken(user.id, "some_other_tenant");
    const crossed = await get("/admin", mismatched);
    check("a user/tenant mismatch is refused", crossed.status === 307, String(crossed.status));

    // Deactivation must bite immediately, not when the cookie expires.
    await adminDb.user.update({ where: { id: user.id }, data: { active: false } });
    const deactivated = await get("/admin", good);
    check(
      "deactivating a user takes effect on their EXISTING session",
      deactivated.status === 307,
      String(deactivated.status),
    );
    await adminDb.user.update({ where: { id: user.id }, data: { active: true } });

    // ── 5. Every screen renders ───────────────────────────────────────
    // A page that typechecks can still throw at request time — a bad Prisma
    // include, a null nobody guarded. Rendering each one is the only proof.
    console.log("\n5. Every screen renders");
    const screens = [
      "/admin",
      "/admin/exceptions",
      "/admin/schedules",
      "/admin/resources",
      "/admin/services",
      "/admin/bookings",
      "/admin/bookings?past=1",
      "/admin/conversations",
      "/admin/integration",
      "/admin/settings",
    ];
    for (const path of screens) {
      const res = await get(path, good);
      check(path, res.status === 200, `HTTP ${res.status}`);
    }

    // And a detail page, which needs a real id. Created here rather than skipped
    // when absent — a conditional check silently stops covering the thing it was
    // written for the moment the fixture goes away.
    const convo =
      (await adminDb.conversation.findFirst({ where: { tenantId: user.tenantId } })) ??
      (await (async () => {
        const customer = await adminDb.customer.create({
          data: { tenantId: user.tenantId, name: "Render probe", phone: "+440000000000" },
        });
        return adminDb.conversation.create({
          data: {
            tenantId: user.tenantId,
            customerId: customer.id,
            channel: "whatsapp",
            externalThreadId: "440000000000",
            messages: {
              create: {
                tenantId: user.tenantId,
                direction: "inbound",
                author: "customer",
                body: "probe",
              },
            },
          },
        });
      })());

    {
      const res = await get(`/admin/conversations/${convo.id}`, good);
      check("/admin/conversations/[id]", res.status === 200, `HTTP ${res.status}`);

      // A conversation belonging to nobody must 404 rather than 500 or, worse,
      // render someone else's thread.
      const missing = await get("/admin/conversations/does-not-exist", good);
      check("an unknown conversation 404s", missing.status === 404, `HTTP ${missing.status}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
