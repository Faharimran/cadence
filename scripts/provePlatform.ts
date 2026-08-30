/**
 * Proves the operator console cannot be reached by a customer, and cannot see
 * one either.
 *
 * Two claims, and both would be easy to believe without checking:
 *
 *  1. **A tenant session cannot open the console, and an operator session
 *     cannot open a tenant admin.** Separate cookies and separate HMAC domains
 *     mean neither token verifies where it does not belong — asserted rather
 *     than assumed, because this is the boundary that keeps one customer's
 *     login from reading every other customer's operations.
 *
 *  2. **The console shows no customer.** It is the one surface that reads on
 *     the owner connection, which row-level security does not constrain. So a
 *     customer is seeded with a name and number that appear nowhere else, every
 *     console page is rendered, and the run fails if either string is present.
 *
 * Requires: npm run dev   Run: npm run prove:platform
 */
import { adminDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { hashPassword } from "@/lib/auth/password";
import { mintToken, SESSION_COOKIE } from "@/lib/auth/session";
import { mintPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/session";
import { readPlatformTokenValue } from "@/lib/platform/session";
import { readTokenValue } from "@/lib/auth/session";
import { loadOverview, loadTenantDetail } from "@/lib/platform/metrics";

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

/** Distinctive enough that a substring match is meaningful. */
const PROBE_NAME = "Zylquist Verrandean";
const PROBE_PHONE = "+919812340077";
const PROBE_MESSAGE = "my qwyzzle is throbbing rather badly";

async function get(path: string, cookies: Record<string, string> = {}) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function cleanup() {
  await adminDb.platformUser.deleteMany({ where: { email: { endsWith: "@probe.test" } } });
  await adminDb.customer.deleteMany({ where: { phone: PROBE_PHONE } });
}

async function main() {
  await cleanup();

  const cara = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "cara-clinic" } });
  const tenantUser = await adminDb.user.findFirstOrThrow({ where: { tenantId: cara.id } });

  const admin = await adminDb.platformUser.create({
    data: {
      email: "admin@probe.test",
      passwordHash: await hashPassword("a-long-enough-password"),
      role: "admin",
    },
  });
  const support = await adminDb.platformUser.create({
    data: {
      email: "support@probe.test",
      passwordHash: await hashPassword("a-long-enough-password"),
      role: "support",
    },
  });

  const operatorCookie = mintPlatformToken(admin.id);
  const supportCookie = mintPlatformToken(support.id);
  const tenantCookie = mintToken(tenantUser.id, tenantUser.tenantId);

  // ── 1. The two token families cannot cross ──────────────────────────
  console.log("\n1. Tokens");
  {
    check("a platform token decodes as a platform token", readPlatformTokenValue(operatorCookie) !== null);
    check(
      "but NOT as a tenant token",
      readTokenValue(operatorCookie) === null,
      "an operator cookie verified as a tenant session",
    );
    check("a tenant token decodes as a tenant token", readTokenValue(tenantCookie) !== null);
    check(
      "but NOT as a platform token",
      readPlatformTokenValue(tenantCookie) === null,
      "a tenant cookie verified as an operator session",
    );
    check("nonsense is rejected", readPlatformTokenValue("not-a-token") === null);
    check("an expired platform token is rejected", readPlatformTokenValue(mintPlatformToken(admin.id, -60)) === null);

    // A token carrying a tenantId is a tenant token whatever else it looks
    // like, and is refused rather than having the field ignored.
    const parts = operatorCookie.split(".");
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const smuggled = Buffer.from(
      JSON.stringify({ ...claims, tenantId: cara.id }),
      "utf8",
    ).toString("base64url");
    check(
      "a platform token with a tenantId spliced in is refused",
      readPlatformTokenValue(`${smuggled}.${parts[1]}`) === null,
    );
  }

  // ── 2. Route gating ─────────────────────────────────────────────────
  console.log("\n2. Who gets in");
  {
    const anon = await get("/platform");
    check("/platform redirects a stranger", anon.status === 307, String(anon.status));
    check("to the operator sign-in", anon.location?.includes("/platform/signin") === true);

    const signin = await get("/platform/signin");
    check("/platform/signin stays reachable", signin.status === 200, String(signin.status));

    // The one that matters most: a real, valid tenant login must not open this.
    const asTenant = await get("/platform", { [SESSION_COOKIE]: tenantCookie });
    check(
      "a VALID tenant session does not open the console",
      asTenant.status === 307,
      `HTTP ${asTenant.status}`,
    );

    // And the reverse — an operator cookie is not a tenant login.
    const asOperator = await get("/admin", { [PLATFORM_COOKIE]: operatorCookie });
    check(
      "an operator session does not open a business admin",
      asOperator.status === 307,
      `HTTP ${asOperator.status}`,
    );

    const proper = await get("/platform", { [PLATFORM_COOKIE]: operatorCookie });
    check("an operator gets in", proper.status === 200, String(proper.status));
    check("and the page says which console this is", proper.body.includes("Operator console"));

    // Revocation takes effect on the existing session, not at expiry.
    await adminDb.platformUser.update({ where: { id: support.id }, data: { active: false } });
    const revoked = await get("/platform", { [PLATFORM_COOKIE]: supportCookie });
    check("deactivating an operator ends their EXISTING session", revoked.status === 307);
    await adminDb.platformUser.update({ where: { id: support.id }, data: { active: true } });
  }

  // ── 3. It cannot show a customer ────────────────────────────────────
  console.log("\n3. What it refuses to show");
  {
    // A customer, a conversation and a message, all with strings that appear
    // nowhere else in the product.
    const customer = await adminDb.customer.create({
      data: { tenantId: cara.id, name: PROBE_NAME, phone: PROBE_PHONE, locale: "en-IN" },
    });
    const conversation = await adminDb.conversation.create({
      data: {
        tenantId: cara.id,
        customerId: customer.id,
        channel: "whatsapp",
        externalThreadId: PROBE_PHONE,
      },
    });
    await adminDb.conversationMessage.create({
      data: {
        tenantId: cara.id,
        conversationId: conversation.id,
        direction: "inbound",
        author: "customer",
        body: PROBE_MESSAGE,
      },
    });

    const overview = await get("/platform", { [PLATFORM_COOKIE]: operatorCookie });
    const detail = await get(`/platform/tenants/${cara.id}`, { [PLATFORM_COOKIE]: operatorCookie });

    check("the tenant page renders", detail.status === 200, String(detail.status));
    check("and it names the business", detail.body.includes("Cara Clinic"));
    check("and counts their conversations", /Conversations/.test(detail.body));

    // Every one of these is a NEGATIVE assertion, and a negative assertion is
    // satisfied by an error page. Requiring a 200 first is what stops "the
    // console does not leak names" from staying green on a screen that never
    // rendered — which is exactly what happened on the first run of this file.
    for (const [where, page] of [["overview", overview], ["tenant page", detail]] as const) {
      const rendered = page.status === 200 && page.body.includes("cadence");
      check(`the ${where} actually rendered`, rendered, `HTTP ${page.status}`);
      check(
        `the ${where} does not show the customer's name`,
        rendered && !page.body.includes(PROBE_NAME),
      );
      check(
        `the ${where} does not show their phone number`,
        rendered && !page.body.includes(PROBE_PHONE),
      );
      check(
        `the ${where} does not show what they said`,
        rendered && !page.body.includes(PROBE_MESSAGE),
      );
    }

    // The metrics layer is the thing that would leak, so check it directly too
    // — a screen that happens not to render a field today is not a guarantee.
    const serialised = JSON.stringify([await loadOverview(), await loadTenantDetail(cara.id)]);
    check(
      "and the metrics layer never even loads a customer identity",
      !serialised.includes(PROBE_NAME) &&
        !serialised.includes(PROBE_PHONE) &&
        !serialised.includes(PROBE_MESSAGE),
    );

    // Secrets are not merely unrendered — they are not selected.
    const channel = await adminDb.channelAccount.findFirst({ where: { tenantId: cara.id } });
    if (channel?.accessToken) {
      check(
        "nor a channel access token",
        !serialised.includes(channel.accessToken),
      );
    } else {
      check("nor a channel access token (none stored to check)", true);
    }
  }

  // ── 4. Only an admin may act ────────────────────────────────────────
  console.log("\n4. Suspending a business");
  {
    const before = await adminDb.tenant.findUniqueOrThrow({ where: { id: cara.id } });
    check("the tenant starts active", before.status === "active");

    const supportView = await get(`/platform/tenants/${cara.id}`, {
      [PLATFORM_COOKIE]: supportCookie,
    });
    check(
      "support sees the page but not the suspend button",
      supportView.status === 200 && supportView.body.includes("Only a platform admin"),
    );

    const adminView = await get(`/platform/tenants/${cara.id}`, {
      [PLATFORM_COOKIE]: operatorCookie,
    });
    check("an admin does get the button", adminView.body.includes("Suspend Cara Clinic"));
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
