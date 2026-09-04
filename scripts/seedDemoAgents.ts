/**
 * Seeds the three businesses behind the "try it" section on the public page.
 *
 * These are real tenants. They hold real resources with real recurring
 * schedules, real services with real prices in three different currencies, and
 * an approved knowledge corpus — so when a visitor asks the Dubai agency what
 * is free on Thursday, the answer comes out of `getAvailability` reading rows,
 * not out of a script. That is the only kind of demo worth putting on a page
 * whose whole argument is that the thing was built rather than mocked up.
 *
 * Two properties this script is responsible for, both asserted by
 * scripts/proveDemo.ts:
 *
 *   · **No capability that writes.** A demo tenant gets `DEMO_CAPABILITIES` and
 *     nothing else, so the agent is handed no `hold_slot` and no
 *     `confirm_booking`. An anonymous visitor cannot put a row in a shared
 *     calendar, which is what makes the endpoint safe to leave unauthenticated.
 *
 *   · **Every article approved.** Not because the demo is exempt from the
 *     approval gate but because it is the demo *of* the approval gate: what the
 *     assistant will say is exactly the five articles seeded here, and what it
 *     refuses is everything else.
 *
 * Idempotent — deletes by slug and rebuilds, so it is safe to re-run whenever
 * the copy in lib/demo/personas.ts changes.
 *
 * Run: npm run seed:demo:agents
 */
import { adminDb } from "@/lib/prisma";
import {
  DEMO_CAPABILITIES,
  DEMO_PERSONAS,
  DEMO_SLUG_PREFIX,
  type DemoPersona,
} from "@/lib/demo/personas";

/**
 * The exception vocabulary each demo business gets.
 *
 * Deliberately thin. The demo is not trying to show off Layer 2 — it exists so
 * the availability the visitor is quoted has somewhere to come from — but
 * "Closed" is system-locked everywhere in the product and a tenant without it
 * is not a shape the engine ever sees in production.
 */
const EXCEPTION_TYPES = [
  {
    code: "closed",
    label: "Closed",
    effect: "subtract" as const,
    priority: 100,
    publicVisible: true,
    publicReason: "We're closed that day.",
    systemLocked: true,
  },
  { code: "leave", label: "Leave", effect: "subtract" as const, priority: 50 },
  { code: "extra", label: "Extra session", effect: "add" as const, priority: 200 },
];

async function seed(persona: DemoPersona) {
  const tenant = await adminDb.tenant.create({
    data: {
      slug: persona.slug,
      name: persona.businessName,
      timezone: persona.timezone,
      currency: persona.currency,
      // Prompt material, all of it. This is the only reason one agent can be a
      // London physiotherapist and a Mumbai insurance adviser without a line of
      // code knowing either trade exists.
      descriptor: persona.descriptor,
      toneNote: persona.toneNote,
      escalationTopics: persona.escalationTopics,
    },
  });

  await adminDb.tenantCapability.createMany({
    data: DEMO_CAPABILITIES.map((capability) => ({
      tenantId: tenant.id,
      capability,
      mode: "hosted" as const,
    })),
  });

  // One site each, carrying its own IANA zone. The tenant's zone is a fallback;
  // availability resolves against this one, and the agent quotes the label the
  // engine renders from it.
  const location = await adminDb.location.create({
    data: {
      tenantId: tenant.id,
      name: persona.locationName,
      timezone: persona.timezone,
    },
  });

  await adminDb.exceptionType.createMany({
    data: EXCEPTION_TYPES.map((t) => ({
      tenantId: tenant.id,
      code: t.code,
      label: t.label,
      effect: t.effect,
      defaultPriority: t.priority,
      publicVisible: t.publicVisible ?? false,
      defaultPublicReason: t.publicReason ?? null,
      systemLocked: t.systemLocked ?? false,
    })),
  });

  const resources = await Promise.all(
    persona.resources.map((r) =>
      adminDb.resource.create({
        data: { tenantId: tenant.id, name: r.name, kind: r.kind, tags: r.tags },
      }),
    ),
  );

  await adminDb.resourceLocation.createMany({
    data: resources.map((r) => ({
      tenantId: tenant.id,
      resourceId: r.id,
      locationId: location.id,
    })),
  });

  for (const service of persona.services) {
    await adminDb.service.create({
      data: {
        tenantId: tenant.id,
        name: service.name,
        category: service.category,
        durationMinutes: service.durationMinutes,
        priceMinor: service.priceMinor,
        requirements: {
          create: [
            {
              tenantId: tenant.id,
              tags: service.requires,
              kind: "person" as const,
              quantity: 1,
            },
          ],
        },
      },
    });
  }

  // Layer 1: the recurring pattern, as local wall-clock strings. Every resource
  // works the business's hours — a demo does not need per-person rotas, and one
  // shared pattern makes "who's free Thursday" answerable rather than sparse.
  await adminDb.scheduleRule.createMany({
    data: persona.hours.flatMap((block) =>
      block.weekdays.flatMap((weekday) =>
        resources.map((resource) => ({
          tenantId: tenant.id,
          resourceId: resource.id,
          locationId: location.id,
          weekday,
          startTime: block.startTime,
          endTime: block.endTime,
          slotMinutes: persona.slotMinutes,
        })),
      ),
    ),
  });

  // Approved, with a timestamp — `loadApproved` filters on status, and the
  // conversation layer will read nothing else.
  const approvedAt = new Date();
  for (const article of persona.articles) {
    await adminDb.knowledgeDoc.create({
      data: {
        tenantId: tenant.id,
        title: article.title,
        body: article.body,
        tags: article.tags,
        status: "approved",
        approvedAt,
      },
    });
  }

  return { tenant, resources: resources.length };
}

async function main() {
  // Rebuild rather than upsert. The rows below hang off the tenant by cascade,
  // so deleting the tenant is the only way to guarantee that removing an
  // article or a service from personas.ts actually removes it from the demo.
  const { count } = await adminDb.tenant.deleteMany({
    where: { slug: { startsWith: DEMO_SLUG_PREFIX } },
  });
  if (count > 0) console.log(`Removed ${count} existing demo tenant(s).`);

  for (const persona of DEMO_PERSONAS) {
    const { tenant, resources } = await seed(persona);
    console.log(`\n${persona.tab} — ${tenant.name}`);
    console.log(`  slug      : ${tenant.slug}`);
    console.log(`  tenantId  : ${tenant.id}`);
    console.log(`  zone      : ${tenant.timezone}   currency: ${tenant.currency}`);
    console.log(`  resources : ${resources}`);
    console.log(`  services  : ${persona.services.map((s) => s.name).join(", ")}`);
    console.log(`  articles  : ${persona.articles.length} (approved)`);
    console.log(`  caps      : ${DEMO_CAPABILITIES.join(", ")}  ← no booking_write`);
  }

  console.log("\nDone. The 'try it' section on / is now live.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
