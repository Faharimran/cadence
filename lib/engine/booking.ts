import type { TenantDb } from "@/lib/prisma";
import { CadenceError, isCadenceError, translateDatabaseError } from "@/lib/api/errors";
import { getAvailability, type Slot } from "@/lib/engine/availability";
import { addMinutes, describeInstant } from "@/lib/engine/time";
import { recordEvent } from "@/lib/events";

/**
 * Holds and bookings.
 *
 * The shape of this module is dictated by one fact: between an agent saying
 * "3pm is free" and the customer replying "yes please", minutes pass. On
 * WhatsApp, sometimes hours. Anything that reads availability and then writes a
 * booking without a lock in between will eventually promise the same slot to two
 * people, and it will do it in front of real customers.
 *
 * So the flow is deliberately three-legged:
 *
 *   getAvailability()  →  hold()  →  confirm()
 *      advisory           binding      final
 *
 * `hold` is the only step that must run against live data, and its correctness
 * does not depend on the re-check it performs. The re-check produces a good
 * error message; the EXCLUSION CONSTRAINT in the database produces the
 * guarantee. If the two ever disagree, the database is right.
 */

const DEFAULT_HOLD_SECONDS = 600; // 10 min — long enough for a WhatsApp reply
const MAX_HOLD_SECONDS = 3_600;

export type HoldRequest = {
  tenantId: string;
  customerId: string;
  serviceId: string;
  locationId: string;
  /** Appointment start, as returned by getAvailability(). */
  startsAt: Date;
  /** Optional: pin specific resources. Otherwise re-matched from availability. */
  resourceIds?: string[];
  ttlSeconds?: number;
  source?: string;
};

export type HeldBooking = {
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
  locationName: string;
  timezone: string;
  resourceNames: string[];
  label: string;
};

/**
 * Reserves a slot for a short window. Returns a booking in `held` status.
 *
 * Races are resolved by Postgres, not here: two concurrent holds for the same
 * resource-interval both pass their re-checks, both attempt the insert, and
 * exactly one survives. The loser gets `slot_unavailable`, which is recoverable
 * and carries alternatives so the caller can immediately offer another time.
 */
export async function holdSlot(db: TenantDb, req: HoldRequest): Promise<HeldBooking> {
  const ttl = Math.min(req.ttlSeconds ?? DEFAULT_HOLD_SECONDS, MAX_HOLD_SECONDS);

  const customer = await db.customer.findFirst({
    where: { id: req.customerId, tenantId: req.tenantId },
    select: { id: true, optedOut: true },
  });
  if (!customer) throw new CadenceError("not_found", "Unknown customer.");

  const expiresAt = new Date(Date.now() + ttl * 1000);

  try {
    // Re-derive the slot from live data rather than trusting the caller's idea
    // of what is free. A snapshot may be minutes old; this must not be.
    const slot = await resolveSlot(db, req);

    const booking = await db.booking.create({
      data: {
        tenantId: req.tenantId,
        customerId: req.customerId,
        serviceId: req.serviceId,
        locationId: req.locationId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: "held",
        holdExpiresAt: expiresAt,
        source: req.source ?? "api",
        resources: {
          // Sorted, and this is load-bearing rather than tidiness.
          //
          // A service occupying several resources inserts one row per resource,
          // each taking a lock the exclusion constraint enforces. If two
          // concurrent bookings acquire those locks in OPPOSITE orders — A takes
          // the stylist and waits for the suite, B takes the suite and waits for
          // the stylist — Postgres detects a deadlock and kills one at random
          // (SQLSTATE 40P01). Ordering every writer identically makes that
          // cycle impossible to form.
          //
          // The failure is timing-dependent, so it passes tests and appears in
          // production. Do not remove this sort.
          create: [...slot.resourceIds].sort().map((resourceId) => ({
            tenantId: req.tenantId,
            resourceId,
            // The buffered interval — this is what the exclusion constraint
            // compares, so turnover time is enforced by the same mechanism that
            // prevents double-booking.
            startsAt: slot.occupancyStart,
            endsAt: slot.occupancyEnd,
            active: true,
          })),
        },
      },
    });

    await recordEvent(db, req.tenantId, "booking.created", {
      bookingId: booking.id,
      customerId: req.customerId,
      serviceId: req.serviceId,
      locationId: req.locationId,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      status: "held",
      expiresAt: expiresAt.toISOString(),
      resourceIds: slot.resourceIds,
      source: req.source ?? "api",
    });

    return {
      bookingId: booking.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      expiresAt,
      locationName: slot.locationName,
      timezone: slot.timezone,
      resourceNames: slot.resourceNames,
      label: slot.label,
    };
  } catch (err) {
    // Every "you can't have that slot" leaving this function carries options.
    // Not being able to book is a conversational event, not a dead end — an
    // agent that receives a bare 409 can only apologise, whereas one that
    // receives alternatives can say "that just went, Friday 11am instead?".
    //
    // Two paths converge here: the pre-flight re-check found the slot gone, and
    // the database's exclusion constraint rejected the insert. Enriching in one
    // place means neither can silently regress to a bare error.
    const translated = translateDatabaseError(err);
    if (translated) {
      throw new CadenceError("slot_unavailable", translated.message, {
        alternatives: await nearbyAlternatives(db, req),
      });
    }
    if (isCadenceError(err) && err.recoverable) {
      const details = (err.details ?? {}) as { alternatives?: unknown[] };
      if (!details.alternatives?.length) {
        throw new CadenceError(err.code, err.message, {
          ...details,
          alternatives: await nearbyAlternatives(db, req),
        });
      }
    }
    throw err;
  }
}

/** Promotes a live hold to a real booking. */
export async function confirmHold(
  db: TenantDb,
  args: { tenantId: string; bookingId: string },
) {
  const booking = await db.booking.findFirst({
    where: { id: args.bookingId, tenantId: args.tenantId },
  });
  if (!booking) throw new CadenceError("not_found", "Unknown booking.");

  if (booking.status === "scheduled" || booking.status === "confirmed") {
    return booking; // idempotent: confirming twice is not an error
  }
  if (booking.status !== "held") {
    throw new CadenceError("validation_failed", `Cannot confirm a ${booking.status} booking.`);
  }
  // The sweeper may not have run yet, so expiry is checked on read as well as
  // on the schedule. Never rely on a background job for correctness.
  if (booking.holdExpiresAt && booking.holdExpiresAt < new Date()) {
    throw new CadenceError("hold_expired", "That hold has expired — please pick a time again.");
  }

  const confirmed = await db.booking.update({
    where: { id: booking.id },
    data: { status: "scheduled", holdExpiresAt: null },
  });

  await recordEvent(db, args.tenantId, "booking.confirmed", {
    bookingId: confirmed.id,
    customerId: confirmed.customerId,
    serviceId: confirmed.serviceId,
    locationId: confirmed.locationId,
    startsAt: confirmed.startsAt.toISOString(),
    endsAt: confirmed.endsAt.toISOString(),
    status: confirmed.status,
  });

  return confirmed;
}

/**
 * Cancels a booking and frees its resources.
 *
 * `active: false` rather than a delete: the exclusion constraint is filtered on
 * `active`, so the slot reopens immediately while the audit trail survives.
 */
export async function cancelBooking(
  db: TenantDb,
  args: { tenantId: string; bookingId: string; reason?: string; status?: "cancelled" | "no_show" | "needs_rebooking" },
) {
  const booking = await db.booking.findFirst({
    where: { id: args.bookingId, tenantId: args.tenantId },
  });
  if (!booking) throw new CadenceError("not_found", "Unknown booking.");

  const status = args.status ?? "cancelled";
  if (booking.status === status) return booking;

  const [updated] = await Promise.all([
    db.booking.update({
      where: { id: booking.id },
      data: {
        status,
        cancelReason: args.reason ?? null,
        cancelledAt: new Date(),
        holdExpiresAt: null,
      },
    }),
    db.bookingResource.updateMany({
      where: { bookingId: booking.id },
      data: { active: false },
    }),
  ]);

  await recordEvent(
    db,
    args.tenantId,
    status === "needs_rebooking" ? "booking.needs_rebooking" : "booking.cancelled",
    {
      bookingId: updated.id,
      customerId: updated.customerId,
      serviceId: updated.serviceId,
      locationId: updated.locationId,
      startsAt: updated.startsAt.toISOString(),
      status: updated.status,
      reason: args.reason ?? null,
    },
  );

  return updated;
}

/**
 * Releases holds whose TTL has passed. Driven by the worker on a short interval.
 *
 * This is housekeeping, not correctness — `confirmHold` independently refuses an
 * expired hold. If the worker stops, slots free up late rather than being
 * double-sold.
 */
export async function expireStaleHolds(db: TenantDb, tenantId: string): Promise<number> {
  const stale = await db.booking.findMany({
    where: { tenantId, status: "held", holdExpiresAt: { lt: new Date() } },
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  const ids = stale.map((b) => b.id);
  await Promise.all([
    db.booking.updateMany({
      where: { id: { in: ids } },
      data: { status: "cancelled", cancelReason: "hold_expired", cancelledAt: new Date(), holdExpiresAt: null },
    }),
    db.bookingResource.updateMany({
      where: { bookingId: { in: ids } },
      data: { active: false },
    }),
  ]);
  return ids.length;
}

// ══════════════════════════════════════════════════════════════════════
//  Internals
// ══════════════════════════════════════════════════════════════════════

/** Finds the live slot matching the requested start, or explains why it is gone. */
async function resolveSlot(db: TenantDb, req: HoldRequest): Promise<Slot> {
  const service = await db.service.findFirst({
    where: { id: req.serviceId, tenantId: req.tenantId },
    select: { durationMinutes: true, bufferBeforeMinutes: true },
  });
  if (!service) throw new CadenceError("not_found", "Unknown service.");

  // Query a window that starts before the requested time by the leading buffer,
  // so the occupancy interval containing it is generated.
  const from = addMinutes(req.startsAt, -service.bufferBeforeMinutes - 1);
  const to = addMinutes(req.startsAt, service.durationMinutes + 60);

  const result = await getAvailability(db, {
    tenantId: req.tenantId,
    serviceId: req.serviceId,
    locationId: req.locationId,
    from,
    to,
  });

  if (!result.available) {
    throw new CadenceError(
      result.reason === "closed" ? "closed" : "slot_unavailable",
      result.reason === "closed"
        ? (result.publicNote ?? "We are closed at that time.")
        : "That time is not available.",
      { reason: result.reason, nextOpenAt: result.nextOpenAt },
    );
  }

  const target = req.startsAt.getTime();
  const candidates = result.slots.filter((s) => s.startsAt.getTime() === target);
  if (candidates.length === 0) {
    const alternatives = result.slots.slice(0, 3).map(describeSlot);
    throw new CadenceError("slot_unavailable", "That time is no longer available.", {
      alternatives,
    });
  }

  // Honour a caller's resource preference when it is still satisfiable.
  if (req.resourceIds?.length) {
    const wanted = new Set(req.resourceIds);
    const preferred = candidates.find((s) => s.resourceIds.every((id) => wanted.has(id)));
    if (preferred) return preferred;
    throw new CadenceError(
      "slot_unavailable",
      "That time is free, but not with the requested people.",
      { alternatives: candidates.slice(0, 3).map(describeSlot) },
    );
  }

  return candidates[0];
}

/** A few nearby options to offer after losing a race. Best-effort. */
async function nearbyAlternatives(db: TenantDb, req: HoldRequest) {
  try {
    const result = await getAvailability(db, {
      tenantId: req.tenantId,
      serviceId: req.serviceId,
      locationId: req.locationId,
      from: req.startsAt,
      to: addMinutes(req.startsAt, 7 * 24 * 60),
      limit: 3,
    });
    return result.available ? result.slots.map(describeSlot) : [];
  } catch {
    // Never let the consolation lookup mask the original failure.
    return [];
  }
}

function describeSlot(slot: Slot) {
  return {
    startsAt: slot.startsAt.toISOString(),
    label: describeInstant(slot.startsAt, slot.timezone),
    locationName: slot.locationName,
    resourceNames: slot.resourceNames,
  };
}
