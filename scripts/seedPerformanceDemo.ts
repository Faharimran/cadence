/**
 * Gives a tenant enough trading history to see the performance page working.
 *
 * The page it exists for — /admin/performance — needs a year of completed
 * bookings, a couple of years of conversations and a token ledger before it
 * shows anything at all, and a fresh database has none of those. Reading a
 * dashboard's code tells you whether it compiles; only data tells you whether
 * the arithmetic, the timezone bucketing and the empty states are right.
 *
 * ## Why this has to be re-runnable
 *
 * `proveEngine` and `proveConversation` both open with a blanket
 * `booking.deleteMany({ where: { tenantId } })` on demo-studio, and the second
 * clears its conversations too. That is reasonable for a test that wants a known
 * slate, and it means any demo data living in that tenant does not survive
 * `npm run check`. So this is idempotent and cheap to re-run rather than
 * something you set up once.
 *
 * Everything it writes is tagged — bookings by `notes`, conversations by an
 * `externalThreadId` prefix — so a re-run replaces its own rows and never
 * touches a real one.
 *
 * **The numbers are invented.** A rising trend, a fixed share of cancellations
 * and a round-robin over booking sources. Useful for looking at the page, no
 * use whatsoever for deciding anything about a business.
 *
 * Run: npm run seed:perf            (demo-studio)
 *      npm run seed:perf -- <slug>
 */
import { adminDb } from "@/lib/prisma";

const TAG = "perf-demo";
const THREAD_PREFIX = "perf-demo-";
/** Priced models, so the own-key cost estimate has something to work with. */
const MODELS = ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"];
const SOURCES = ["agent", "admin", "api", "connector"];

async function main() {
  const slug = process.argv[2] ?? "demo-studio";
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug } });

  const [location] = await adminDb.location.findMany({ where: { tenantId: tenant.id }, take: 1 });
  const services = await adminDb.service.findMany({ where: { tenantId: tenant.id } });
  const customers = await adminDb.customer.findMany({ where: { tenantId: tenant.id } });

  if (!location || services.length === 0 || customers.length === 0) {
    console.error(
      `${slug} needs at least one location, service and customer first ` +
        `(has ${location ? 1 : 0}/${services.length}/${customers.length}). ` +
        `Run npm run seed:demo, or pass a tenant that is already set up.`,
    );
    process.exit(1);
  }

  // Ours only. Tagged on the way in precisely so this line can be narrow.
  await adminDb.booking.deleteMany({ where: { tenantId: tenant.id, notes: TAG } });
  await adminDb.conversation.deleteMany({
    where: { tenantId: tenant.id, externalThreadId: { startsWith: THREAD_PREFIX } },
  });
  await adminDb.modelUsage.deleteMany({ where: { tenantId: tenant.id } });

  const now = new Date();
  let bookings = 0;
  let conversations = 0;
  let ledger = 0;

  // ── A year of completed work ────────────────────────────────────────
  for (let back = 12; back >= 0; back--) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const count = 6 + Math.round((12 - back) * 1.1) + (back % 3);

    for (let i = 0; i < count; i++) {
      const startsAt = new Date(
        Date.UTC(
          month.getUTCFullYear(),
          month.getUTCMonth(),
          1 + ((i * 7 + back * 3) % 26),
          9 + (i % 8),
          0,
        ),
      );
      if (startsAt > now) continue;

      const service = services[i % services.length];
      // One in nine is quote-on-request, so the "not counted above" path is
      // exercised rather than assumed; one in eleven cancels, one in thirteen
      // fails to turn up.
      const unpriced = i % 9 === 0;
      const status = i % 11 === 0 ? "cancelled" : i % 13 === 0 ? "no_show" : "completed";
      const discount = i % 5 === 0 ? 500 : 0;

      await adminDb.booking.create({
        data: {
          tenantId: tenant.id,
          customerId: customers[(i * 3 + back) % customers.length].id,
          serviceId: service.id,
          locationId: location.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + (service.durationMinutes ?? 60) * 60_000),
          status: status as "completed" | "cancelled" | "no_show",
          source: SOURCES[i % SOURCES.length],
          priceMinor: unpriced ? null : (service.priceMinor ?? 4500) + (i % 4) * 500 - discount,
          discountMinor: discount || null,
          // No BookingResource rows: the no-overlap exclusion constraint lives on
          // those, and none of this arithmetic reads them. Seeding a year of
          // realistic non-conflicting resource assignments would be a scheduling
          // problem, not a fixture.
          notes: TAG,
        },
      });
      bookings++;
    }
  }

  // ── Still to come, for the pipeline panel ───────────────────────────
  for (let i = 1; i <= 7; i++) {
    const startsAt = new Date(now.getTime() + i * 36 * 3600_000);
    const service = services[i % services.length];
    await adminDb.booking.create({
      data: {
        tenantId: tenant.id,
        customerId: customers[i % customers.length].id,
        serviceId: service.id,
        locationId: location.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + (service.durationMinutes ?? 60) * 60_000),
        status: i % 2 === 0 ? "confirmed" : "scheduled",
        source: i % 3 === 0 ? "agent" : "admin",
        priceMinor: service.priceMinor ?? 4500,
        notes: TAG,
      },
    });
    bookings++;
  }

  // ── Two calendar years of conversations ─────────────────────────────
  // Two, because a year-on-year comparison needs a pair — and the ledger covers
  // only the last thirteen months, which is what makes the page say so.
  for (const year of [now.getUTCFullYear() - 1, now.getUTCFullYear()]) {
    for (let m = 0; m < 12; m++) {
      if (new Date(Date.UTC(year, m, 1)) > now) continue;
      const count = 3 + m + (year === now.getUTCFullYear() ? 6 : 0);

      for (let i = 0; i < count; i++) {
        const createdAt = new Date(Date.UTC(year, m, 1 + (i % 27), 9 + (i % 9), 0));
        if (createdAt > now) continue;

        const conversation = await adminDb.conversation.create({
          data: {
            tenantId: tenant.id,
            customerId: customers[i % customers.length].id,
            channel: "whatsapp",
            externalThreadId: `${THREAD_PREFIX}${year}-${m}-${i}`,
            status: "closed",
            createdAt,
          },
        });
        conversations++;

        const ageMonths = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() - m);
        if (ageMonths <= 12 && i % 2 === 0) {
          await adminDb.modelUsage.create({
            data: {
              tenantId: tenant.id,
              kind: "conversation",
              // Recorded against the tenant's own key so the cost estimate is
              // exercised. A row on the platform key would store a real price
              // and show the business nothing, which is the other branch.
              source: "tenant",
              protocol: "anthropic",
              vendor: "anthropic",
              model: MODELS[i % MODELS.length],
              inputTokens: 2_000 + i * 120,
              outputTokens: 300 + i * 20,
              // Cache reads dominate a real conversation: the system prompt is
              // re-sent every turn and served from cache at a tenth the price.
              cacheReadTokens: 8_000 + i * 400,
              cacheWriteTokens: 1_200,
              roundTrips: 2 + (i % 3),
              conversationId: conversation.id,
              createdAt,
            },
          });
          ledger++;
        }
      }
    }
  }

  console.log(
    `${tenant.name} (${tenant.currency}, ${tenant.timezone}) — ` +
      `${bookings} bookings, ${conversations} conversations, ${ledger} ledger rows.`,
  );
  console.log("Open /admin/performance. Re-run this after npm run check, which clears it.");
  await adminDb.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
