/**
 * Creates a demo tenant exercising the parts of the model that are easy to get
 * wrong: two locations in DIFFERENT timezones, a service that needs two
 * resources at once, buffers, and a full set of exception types.
 *
 * Deliberately not a clinic. The engine must not acquire a vertical by osmosis
 * through its own seed data — if the demo tenant were a hair clinic, clinic
 * assumptions would quietly creep into the tests and then into the code.
 *
 * Run: npm run seed:demo
 */
import { adminDb } from "@/lib/prisma";
import { randomBytes, createHash } from "node:crypto";
import { env } from "@/lib/env";

const SLUG = "demo-studio";

async function main() {
  // Idempotent: wipe and rebuild so the script is safe to re-run while iterating.
  await adminDb.tenant.deleteMany({ where: { slug: SLUG } });

  const tenant = await adminDb.tenant.create({
    data: {
      slug: SLUG,
      name: "Demo Studio",
      timezone: "Europe/London",
      currency: "GBP",
      taxLabel: "VAT",
      taxRate: 20,
      taxInclusive: true,
    },
  });

  // Every capability hosted — the "customer has no CRM" onboarding path.
  await adminDb.tenantCapability.createMany({
    data: (
      [
        ["customers", 300],
        ["catalog", 21_600],
        ["availability", 60],
        ["booking_read", 60],
        ["booking_write", 60],
        ["promotions", 900],
      ] as const
    ).map(([capability, ttl]) => ({
      tenantId: tenant.id,
      capability,
      mode: "hosted" as const,
      snapshotTtlSeconds: ttl,
    })),
  });

  // Two zones on purpose: London observes DST, Dubai does not. Any code that
  // assumes a single offset breaks against this pair.
  const london = await adminDb.location.create({
    data: {
      tenantId: tenant.id,
      name: "London Studio",
      code: "LDN",
      timezone: "Europe/London",
    },
  });
  const dubai = await adminDb.location.create({
    data: {
      tenantId: tenant.id,
      name: "Dubai Studio",
      code: "DXB",
      timezone: "Asia/Dubai",
    },
  });

  const alex = await adminDb.resource.create({
    data: { tenantId: tenant.id, name: "Alex", kind: "person", tags: ["Senior", "Cut"] },
  });
  const sam = await adminDb.resource.create({
    data: { tenantId: tenant.id, name: "Sam", kind: "person", tags: ["Junior", "Cut"] },
  });
  const suite = await adminDb.resource.create({
    data: { tenantId: tenant.id, name: "Suite 1", kind: "room", tags: ["Suite"] },
  });

  await adminDb.resourceLocation.createMany({
    data: [
      { tenantId: tenant.id, resourceId: alex.id, locationId: london.id },
      { tenantId: tenant.id, resourceId: sam.id, locationId: london.id },
      { tenantId: tenant.id, resourceId: suite.id, locationId: london.id },
      { tenantId: tenant.id, resourceId: alex.id, locationId: dubai.id },
    ],
  });

  // A simple service: one person tagged "Cut".
  const consult = await adminDb.service.create({
    data: {
      tenantId: tenant.id,
      name: "Consultation",
      category: "consult",
      durationMinutes: 30,
      priceMinor: 4000,
      requirements: {
        create: [{ tenantId: tenant.id, tags: ["Cut"], kind: "person", quantity: 1 }],
      },
    },
  });

  // A compound service: a senior person AND the suite, for two hours, with
  // 15 minutes of turnover afterwards. This is the case a single-resource model
  // cannot express.
  const session = await adminDb.service.create({
    data: {
      tenantId: tenant.id,
      name: "Studio Session",
      category: "session",
      durationMinutes: 120,
      bufferAfterMinutes: 15,
      priceMinor: 25000,
      requirements: {
        create: [
          { tenantId: tenant.id, tags: ["Senior"], kind: "person", quantity: 1 },
          { tenantId: tenant.id, tags: ["Suite"], kind: "room", quantity: 1 },
        ],
      },
    },
  });

  // Weekdays 09:00-17:00 in each location's own local time.
  const rules = [];
  for (const weekday of [1, 2, 3, 4, 5]) {
    for (const [resource, location] of [
      [alex, london],
      [sam, london],
      [suite, london],
      [alex, dubai],
    ] as const) {
      rules.push({
        tenantId: tenant.id,
        resourceId: resource.id,
        locationId: location.id,
        weekday,
        startTime: "09:00",
        endTime: "17:00",
        slotMinutes: 30,
      });
    }
  }
  await adminDb.scheduleRule.createMany({ data: rules });

  // The exception vocabulary. `code` values here are the tenant's, not the
  // engine's — only `effect` is fixed.
  const types = await Promise.all(
    (
      [
        { code: "closure", label: "Closed", effect: "subtract", priority: 100, publicVisible: true, defaultPublicReason: "We're closed that day.", systemLocked: true },
        { code: "leave", label: "Leave", effect: "subtract", priority: 50 },
        { code: "blocked", label: "Blocked out", effect: "subtract", priority: 50 },
        { code: "extra", label: "Extra session", effect: "add", priority: 10 },
        { code: "special_opening", label: "Special opening", effect: "add", priority: 200 },
      ] as const
    ).map((t) =>
      adminDb.exceptionType.create({
        data: {
          tenantId: tenant.id,
          code: t.code,
          label: t.label,
          effect: t.effect,
          defaultPriority: t.priority,
          publicVisible: "publicVisible" in t ? t.publicVisible : false,
          defaultPublicReason: "defaultPublicReason" in t ? t.defaultPublicReason : null,
          systemLocked: "systemLocked" in t ? t.systemLocked : false,
        },
      }),
    ),
  );

  const customer = await adminDb.customer.create({
    data: { tenantId: tenant.id, name: "Jordan Reed", phone: "+447700900123", locale: "en-GB" },
  });

  // API key — printed once, exactly as a real one would be.
  const secret = randomBytes(24).toString("base64url");
  const prefix = `cdn_test_${randomBytes(4).toString("hex")}`;
  await adminDb.apiKey.create({
    data: {
      tenantId: tenant.id,
      name: "Demo key",
      prefix,
      hash: createHash("sha256").update(`${secret}${env.CADENCE_SECRET}`).digest("hex"),
    },
  });

  console.log("Seeded tenant:", tenant.slug, tenant.id);
  console.log("  locations :", london.name, "(Europe/London),", dubai.name, "(Asia/Dubai)");
  console.log("  services  :", consult.name, "|", session.name);
  console.log("  types     :", types.map((t) => t.code).join(", "));
  console.log("  customer  :", customer.id);
  console.log("");
  console.log("  API key   :", `${prefix}.${secret}`);
  console.log("  (shown once — the database stores only its hash)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
