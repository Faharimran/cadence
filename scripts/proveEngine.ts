/**
 * Executable proof of the engine's non-obvious guarantees.
 *
 * These are the behaviours that are easy to believe you have and easy not to:
 * exception precedence, category scoping, buffer enforcement, per-location
 * timezones, DST-skipped wall-clock times, and — the one that only ever fails in
 * production — two customers racing for the last slot.
 *
 * Run: npx dotenv -e .env.local -- npx tsx scripts/proveEngine.ts
 */
import { adminDb, withTenant } from "@/lib/prisma";
import { getAvailability } from "@/lib/engine/availability";
import { holdSlot, cancelBooking, confirmHold } from "@/lib/engine/booking";
import { localToInstant, localDateIn, localTimeIn } from "@/lib/engine/time";
import { isCadenceError } from "@/lib/api/errors";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

/** The next occurrence of a given weekday, at least `minDays` out. */
function nextWeekday(weekday: number, minDays = 3): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + minDays);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: "demo-studio" } });
  const t = tenant.id;

  const [london, dubai] = await Promise.all([
    adminDb.location.findFirstOrThrow({ where: { tenantId: t, code: "LDN" } }),
    adminDb.location.findFirstOrThrow({ where: { tenantId: t, code: "DXB" } }),
  ]);
  const consult = await adminDb.service.findFirstOrThrow({
    where: { tenantId: t, name: "Consultation" },
  });
  const session = await adminDb.service.findFirstOrThrow({
    where: { tenantId: t, name: "Studio Session" },
  });
  const customer = await adminDb.customer.findFirstOrThrow({ where: { tenantId: t } });
  const types = await adminDb.exceptionType.findMany({ where: { tenantId: t } });
  const typeByCode = Object.fromEntries(types.map((x) => [x.code, x]));

  const monday = nextWeekday(1);
  const dayStart = localToInstant(monday, "00:00", "Europe/London")!;
  const dayEnd = localToInstant(monday, "23:59", "Europe/London")!;

  // Start from a clean slate for repeat runs.
  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });
  await adminDb.bookingResource.deleteMany({ where: { tenantId: t } });
  await adminDb.booking.deleteMany({ where: { tenantId: t } });

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n1. Baseline availability");
  const base = await withTenant(t, (db) =>
    getAvailability(db, {
      tenantId: t,
      serviceId: consult.id,
      locationId: london.id,
      from: dayStart,
      to: dayEnd,
    }),
  );
  check("RLS-scoped query returns data for its own tenant", base.available);
  if (base.available) {
    const first = base.slots[0];
    check(
      "first slot is 09:00 London local",
      localTimeIn(first.startsAt, "Europe/London") === "09:00",
      localTimeIn(first.startsAt, "Europe/London"),
    );
    check("slot is on the requested date", localDateIn(first.startsAt, "Europe/London") === monday);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n2. Per-location timezones");
  const dubaiAvail = await withTenant(t, (db) =>
    getAvailability(db, {
      tenantId: t,
      serviceId: consult.id,
      locationId: dubai.id,
      from: dayStart,
      to: dayEnd,
    }),
  );
  if (dubaiAvail.available && base.available) {
    const dxb = dubaiAvail.slots[0];
    check("Dubai first slot is 09:00 Dubai local", localTimeIn(dxb.startsAt, "Asia/Dubai") === "09:00");
    check(
      "Dubai 09:00 is a different instant from London 09:00",
      dxb.startsAt.getTime() !== base.slots[0].startsAt.getTime(),
    );
  } else {
    check("Dubai availability computed", false);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n3. DST — a wall-clock time that does not exist");
  // Europe/London springs forward on 2027-03-28: 01:00 -> 02:00, so 01:30 is skipped.
  check(
    "01:30 on the spring-forward date resolves to null",
    localToInstant("2027-03-28", "01:30", "Europe/London") === null,
  );
  check(
    "01:30 the day before resolves normally",
    localToInstant("2027-03-27", "01:30", "Europe/London") !== null,
  );

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n4. Compound service — two resources at once, plus buffer");
  const sessionAvail = await withTenant(t, (db) =>
    getAvailability(db, {
      tenantId: t,
      serviceId: session.id,
      locationId: london.id,
      from: dayStart,
      to: dayEnd,
    }),
  );
  check("compound service is bookable", sessionAvail.available);
  if (sessionAvail.available) {
    check(
      "slot occupies exactly two resources (senior + suite)",
      sessionAvail.slots[0].resourceIds.length === 2,
      `got ${sessionAvail.slots[0].resourceIds.length}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n5. Exception: subtract blocks, and explains itself safely");
  await adminDb.scheduleException.create({
    data: {
      tenantId: t,
      typeId: typeByCode.closure.id,
      locationId: london.id,
      startsAt: dayStart,
      endsAt: dayEnd,
      internalReason: "burst pipe, do not tell customers",
    },
  });
  const closed = await withTenant(t, (db) =>
    getAvailability(db, {
      tenantId: t,
      serviceId: consult.id,
      locationId: london.id,
      from: dayStart,
      to: dayEnd,
    }),
  );
  check("location closure removes all slots", !closed.available);
  if (!closed.available) {
    check("reason distinguishes 'closed' from 'fully booked'", closed.reason === "closed");
    check(
      "public note comes from the type's default, not the internal reason",
      closed.publicNote === "We're closed that day." &&
        !JSON.stringify(closed).includes("burst pipe"),
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n6. Exception precedence: a higher-priority `add` overrides a closure");
  await adminDb.scheduleException.create({
    data: {
      tenantId: t,
      typeId: typeByCode.special_opening.id, // priority 200 vs closure's 100
      locationId: london.id,
      resourceId: null,
      startsAt: localToInstant(monday, "10:00", "Europe/London")!,
      endsAt: localToInstant(monday, "13:00", "Europe/London")!,
    },
  });
  const overridden = await withTenant(t, (db) =>
    getAvailability(db, {
      tenantId: t,
      serviceId: consult.id,
      locationId: london.id,
      from: dayStart,
      to: dayEnd,
    }),
  );
  check("higher-priority add reopens the closed day", overridden.available);
  if (overridden.available) {
    const times = overridden.slots.map((s) => localTimeIn(s.startsAt, "Europe/London"));
    check("only within the special opening window", times[0] === "10:00");
    check(
      "and not outside it",
      !times.includes("09:00") && !times.some((x) => x >= "13:00"),
      times.join(","),
    );
  }

  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n7. Category scoping — blocks one service, not the other");
  await adminDb.scheduleException.create({
    data: {
      tenantId: t,
      typeId: typeByCode.blocked.id,
      locationId: london.id,
      startsAt: dayStart,
      endsAt: dayEnd,
      serviceCategories: ["session"], // only the Studio Session
    },
  });
  const [consultStill, sessionBlocked] = await Promise.all([
    withTenant(t, (db) =>
      getAvailability(db, { tenantId: t, serviceId: consult.id, locationId: london.id, from: dayStart, to: dayEnd }),
    ),
    withTenant(t, (db) =>
      getAvailability(db, { tenantId: t, serviceId: session.id, locationId: london.id, from: dayStart, to: dayEnd }),
    ),
  ]);
  check("category-scoped block leaves other categories bookable", consultStill.available);
  check("and does block its own category", !sessionBlocked.available);

  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n8. A booking removes its slot, and its buffer");
  const target = localToInstant(monday, "09:00", "Europe/London")!;
  const held = await withTenant(t, (db) =>
    holdSlot(db, {
      tenantId: t,
      customerId: customer.id,
      serviceId: session.id,
      locationId: london.id,
      startsAt: target,
    }),
  );
  check("hold created", Boolean(held.bookingId));

  const afterHold = await withTenant(t, (db) =>
    getAvailability(db, { tenantId: t, serviceId: session.id, locationId: london.id, from: dayStart, to: dayEnd }),
  );
  if (afterHold.available) {
    const times = afterHold.slots.map((s) => localTimeIn(s.startsAt, "Europe/London"));
    check("held 09:00 slot is gone", !times.includes("09:00"));
    // Session is 120 min + 15 min buffer, so the next start is 11:15, not 11:00.
    check("15-minute buffer is enforced after the booking", !times.includes("11:00"), times.slice(0, 4).join(","));
    check("next session slot is 11:30 on the 30-min grid", times.includes("11:30"), times.slice(0, 4).join(","));
  } else {
    check("availability after hold", false);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n9. Concurrency — five customers race for the same slot");
  const raceStart = localToInstant(monday, "14:00", "Europe/London")!;

  // Five DIFFERENT customers, which is what this section has always claimed to
  // test. It previously raced one customer against itself — which proved
  // nothing about contention, and quietly asserted that a customer may not hold
  // a slot it already holds. That turned out to be a real bug, not a rule.
  const rivals: { id: string }[] = [];
  for (let i = 0; i < 5; i++) {
    const phone = `+4479000000${10 + i}`;
    rivals.push(
      (await adminDb.customer.findFirst({ where: { tenantId: t, phone } })) ??
        (await adminDb.customer.create({
          data: { tenantId: t, phone, name: `Racer ${i + 1}` },
        })),
    );
  }

  const attempts = await Promise.allSettled(
    rivals.map((r) =>
      withTenant(t, (db) =>
        holdSlot(db, {
          tenantId: t,
          customerId: r.id,
          serviceId: session.id,
          locationId: london.id,
          startsAt: raceStart,
        }),
      ),
    ),
  );
  const won = attempts.filter((a) => a.status === "fulfilled");
  const lost = attempts.filter((a) => a.status === "rejected");
  check(`exactly one hold survives (won ${won.length}, lost ${lost.length})`, won.length === 1);
  const losers = lost.map((l) => (l as PromiseRejectedResult).reason);
  check(
    "losers get a typed, recoverable slot_unavailable",
    losers.length > 0 && losers.every((e) => isCadenceError(e) && e.code === "slot_unavailable"),
    losers.map((e) => (isCadenceError(e) ? e.code : String(e).slice(0, 60))).join(" | "),
  );

  // ─────────────────────────────────────────────────────────────────────
  //
  // A live WhatsApp booking went: assistant holds 12:30 → customer says yes →
  // assistant re-checks, finds 12:30 taken BY ITS OWN HOLD, announces the slot
  // has gone, and offers 12:00. Then repeats the whole mistake at 12:00 before
  // booking 1:00, which nobody had asked for. Two slots reported lost that were
  // never taken by anyone.
  console.log("\n9b. Holding a slot you already hold is not a collision");
  const winner9 = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof holdSlot>>>).value;
  const holder = await adminDb.booking.findUniqueOrThrow({
    where: { id: winner9.bookingId },
    select: { customerId: true },
  });

  const rehold = await withTenant(t, (db) =>
    holdSlot(db, {
      tenantId: t,
      customerId: holder.customerId,
      serviceId: session.id,
      locationId: london.id,
      startsAt: raceStart,
    }),
  );
  check(
    "the same customer gets their existing hold back, not slot_unavailable",
    rehold.bookingId === winner9.bookingId,
    `${rehold.bookingId} vs ${winner9.bookingId}`,
  );
  check(
    "and the hold window is extended, not left to lapse mid-conversation",
    rehold.expiresAt.getTime() >= winner9.expiresAt.getTime(),
  );

  const stillOne = await adminDb.booking.count({
    where: { tenantId: t, startsAt: raceStart, status: "held" },
  });
  check("re-holding created no second booking", stillOne === 1, `held rows: ${stillOne}`);

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n10. Cancelling frees the slot again");
  await withTenant(t, (db) => cancelBooking(db, { tenantId: t, bookingId: held.bookingId }));
  const afterCancel = await withTenant(t, (db) =>
    getAvailability(db, { tenantId: t, serviceId: session.id, locationId: london.id, from: dayStart, to: dayEnd }),
  );
  check(
    "09:00 is bookable again after cancellation",
    afterCancel.available &&
      afterCancel.slots.some((s) => localTimeIn(s.startsAt, "Europe/London") === "09:00"),
  );

  // ─────────────────────────────────────────────────────────────────────
  console.log("\n11. Hold lifecycle");
  if (won.length === 1) {
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof holdSlot>>>).value;
    const confirmed = await withTenant(t, (db) =>
      confirmHold(db, { tenantId: t, bookingId: winner.bookingId }),
    );
    check("hold confirms to scheduled", confirmed.status === "scheduled");
    const again = await withTenant(t, (db) =>
      confirmHold(db, { tenantId: t, bookingId: winner.bookingId }),
    );
    check("confirming twice is idempotent, not an error", again.status === "scheduled");
  }

  // Leave the tenant clean for the next run.
  await adminDb.scheduleException.deleteMany({ where: { tenantId: t } });
  await adminDb.bookingResource.deleteMany({ where: { tenantId: t } });
  await adminDb.booking.deleteMany({ where: { tenantId: t } });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
