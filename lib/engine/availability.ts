import { RRule } from "rrule";
import type { TenantDb } from "@/lib/prisma";
import { CadenceError } from "@/lib/api/errors";
import {
  addMinutes,
  describeInstant,
  localDatesBetween,
  localToInstant,
  overlaps,
  weekdayOf,
  type LocalDate,
} from "@/lib/engine/time";

/**
 * THE availability computation. Nothing in enori stores whether a slot is
 * free; this function derives it, every time, from three layers of facts:
 *
 *   Layer 1  ScheduleRule       the recurring pattern      (generates windows)
 *   Layer 2  ScheduleException  leave / closure / camp     (subtracts and adds)
 *   Layer 3  BookingResource    what is already taken      (subtracts)
 *
 * Precedence between Layer 2 exceptions is explicit rather than emergent,
 * because "the clinic is shut for the festival" and "we are deliberately open on
 * the festival" are both legitimate and must be expressible:
 *
 *   · a `subtract` overlapping a slot blocks it
 *   · an `add` fully containing a slot allows it, even outside Layer 1
 *   · when both apply, the higher `priority` wins
 *   · on a tie, `subtract` wins — failing closed never double-books anyone
 */

export type AvailabilityQuery = {
  tenantId: string;
  serviceId: string;
  from: Date;
  to: Date;
  locationId?: string;
  /** Restrict to one resource, e.g. "I want to see the same doctor as last time". */
  resourceId?: string;
  limit?: number;
};

export type Slot = {
  /** The APPOINTMENT — what the customer is told and what Booking stores. */
  startsAt: Date;
  endsAt: Date;
  /**
   * The OCCUPANCY — the appointment plus its buffers, which is what actually
   * blocks the resource and what BookingResource stores. Kept distinct because
   * telling a customer to arrive at 14:45 when their appointment is at 15:00
   * (because cleanup needs 15 minutes beforehand) is a bug, not a detail.
   */
  occupancyStart: Date;
  occupancyEnd: Date;
  locationId: string;
  locationName: string;
  timezone: string;
  /** Exactly the resources this slot would occupy, in the order requirements were met. */
  resourceIds: string[];
  resourceNames: string[];
  /** Pre-rendered in the location's zone so callers never re-derive it wrongly. */
  label: string;
};

export type AvailabilityResult =
  | { available: true; slots: Slot[] }
  | {
      available: false;
      /**
       * Why there is nothing, distinguished on purpose. "We are closed for
       * Diwali until the 27th" and "every slot is taken" lead to completely
       * different next sentences from an agent, and collapsing both into an
       * empty array throws that away.
       */
      reason: "closed" | "no_matching_resource" | "fully_booked" | "not_bookable";
      /** Safe to say to a customer. Only ever populated from an exception type
       *  the tenant explicitly marked publicVisible. */
      publicNote?: string;
      nextOpenAt?: Date;
    };

/** One continuous window of time a single resource could be occupied. */
type Window = { start: Date; end: Date };

type ExceptionOccurrence = {
  start: Date;
  end: Date;
  effect: "add" | "subtract";
  priority: number;
  categories: string[];
  publicNote?: string;
};

const MAX_RANGE_DAYS = 92;

export async function getAvailability(
  db: TenantDb,
  q: AvailabilityQuery,
): Promise<AvailabilityResult> {
  if (q.to <= q.from) {
    throw new CadenceError("validation_failed", "`to` must be after `from`.");
  }
  const rangeDays = (q.to.getTime() - q.from.getTime()) / 86_400_000;
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new CadenceError(
      "validation_failed",
      `Range too wide: ${Math.ceil(rangeDays)} days (max ${MAX_RANGE_DAYS}).`,
    );
  }

  const service = await db.service.findFirst({
    where: { id: q.serviceId, tenantId: q.tenantId },
    include: { requirements: true },
  });
  if (!service) throw new CadenceError("not_found", "Unknown service.");
  if (!service.active) {
    return { available: false, reason: "not_bookable" };
  }

  // Buffers are part of the occupied interval, so turnover is enforced by the
  // same overlap rules as the appointment itself.
  const occupancyMinutes =
    service.bufferBeforeMinutes + service.durationMinutes + service.bufferAfterMinutes;

  const locations = await db.location.findMany({
    where: {
      tenantId: q.tenantId,
      active: true,
      ...(q.locationId ? { id: q.locationId } : {}),
    },
  });
  if (locations.length === 0) throw new CadenceError("not_found", "No active location.");

  const requirements =
    service.requirements.length > 0
      ? service.requirements
      : // A service with no explicit requirements needs exactly one resource of
        // any kind. Without this, such a service would be bookable against
        // nothing at all.
        [{ id: "implicit", tenantId: q.tenantId, serviceId: service.id, tags: [], kind: null, quantity: 1 }];

  const slots: Slot[] = [];
  let sawAnyResource = false;
  let sawAnyWindow = false;
  let closedNote: string | undefined;
  let nextOpenAt: Date | undefined;

  for (const location of locations) {
    const resources = await db.resource.findMany({
      where: {
        tenantId: q.tenantId,
        active: true,
        ...(q.resourceId ? { id: q.resourceId } : {}),
        locations: { some: { locationId: location.id } },
      },
      // Deterministic order so requirement matching picks the same resources for
      // the same query every time. Without it Postgres may return rows in any
      // order, two concurrent callers can be assigned different resources for
      // the same slot, and the resulting write order varies — see the sort in
      // holdSlot() for why that matters.
      orderBy: { id: "asc" },
    });
    if (resources.length === 0) continue;
    sawAnyResource = true;

    const resourceIds = resources.map((r) => r.id);

    const [rules, exceptionRows, bookings] = await Promise.all([
      db.scheduleRule.findMany({
        where: {
          tenantId: q.tenantId,
          locationId: location.id,
          resourceId: { in: resourceIds },
          effectiveFrom: { lte: q.to },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: q.from } }],
        },
      }),
      db.scheduleException.findMany({
        where: {
          tenantId: q.tenantId,
          status: "approved",
          // A location-wide exception has resourceId NULL; a person-wide one has
          // locationId NULL; a tenant-wide one has both NULL.
          AND: [
            { OR: [{ resourceId: null }, { resourceId: { in: resourceIds } }] },
            { OR: [{ locationId: null }, { locationId: location.id }] },
            // Recurring rows are filtered in JS after expansion, so they must
            // survive this SQL filter regardless of their first occurrence.
            {
              OR: [
                { recurrence: { not: null } },
                { AND: [{ startsAt: { lt: q.to } }, { endsAt: { gt: q.from } }] },
              ],
            },
          ],
        },
        include: { type: true },
      }),
      db.bookingResource.findMany({
        where: {
          tenantId: q.tenantId,
          resourceId: { in: resourceIds },
          active: true,
          startsAt: { lt: q.to },
          endsAt: { gt: q.from },
        },
      }),
    ]);

    // ── Layer 2, expanded and indexed by resource ──────────────────────
    const exceptionsByResource = new Map<string, ExceptionOccurrence[]>();
    const globalExceptions: ExceptionOccurrence[] = [];

    for (const row of exceptionRows) {
      if (!row.type.active) continue;
      for (const occ of expandOccurrences(row, q.from, q.to)) {
        // A category-scoped exception ("no procedures this week") leaves other
        // services untouched.
        if (
          occ.categories.length > 0 &&
          (!service.category || !occ.categories.includes(service.category))
        ) {
          continue;
        }
        if (row.resourceId) {
          const list = exceptionsByResource.get(row.resourceId) ?? [];
          list.push(occ);
          exceptionsByResource.set(row.resourceId, list);
        } else {
          globalExceptions.push(occ);
        }
      }
    }

    const bookingsByResource = new Map<string, Window[]>();
    for (const b of bookings) {
      const list = bookingsByResource.get(b.resourceId) ?? [];
      list.push({ start: b.startsAt, end: b.endsAt });
      bookingsByResource.set(b.resourceId, list);
    }

    const dates = localDatesBetween(q.from, q.to, location.timezone);

    // ── Free windows per resource ───────────────────────────────────────
    const freeByResource = new Map<string, Window[]>();
    for (const resource of resources) {
      const exceptions = [
        ...globalExceptions,
        ...(exceptionsByResource.get(resource.id) ?? []),
      ];
      const base = baseWindows(
        rules.filter((r) => r.resourceId === resource.id),
        dates,
        location.timezone,
        q.from,
        q.to,
      );
      // `add` exceptions create windows where Layer 1 has none.
      const extra = exceptions
        .filter((e) => e.effect === "add")
        .map((e) => ({ start: e.start, end: e.end }));

      const candidate = mergeWindows([...base, ...extra]);
      if (candidate.length > 0) sawAnyWindow = true;

      freeByResource.set(resource.id, candidate);
    }

    // Surface a customer-safe explanation when the whole location is shut.
    for (const occ of globalExceptions) {
      if (occ.effect === "subtract" && occ.publicNote && !closedNote) {
        closedNote = occ.publicNote;
        nextOpenAt = occ.end;
      }
    }

    // ── Slice into offerable slots ──────────────────────────────────────
    const grid = Math.min(
      ...(rules.length > 0 ? rules.map((r) => r.slotMinutes) : [30]),
    );

    const starts = candidateStarts(freeByResource, grid, q.from, q.to);

    for (const occupancyStart of starts) {
      const occupancyEnd = addMinutes(occupancyStart, occupancyMinutes);
      if (occupancyEnd > q.to) continue;

      // Availability is decided on the OCCUPANCY interval — buffers block the
      // resource exactly as the appointment does.
      const chosen = matchRequirements(
        requirements,
        resources,
        occupancyStart,
        occupancyEnd,
        freeByResource,
        bookingsByResource,
        exceptionsByResource,
        globalExceptions,
      );
      if (!chosen) continue;

      const startsAt = addMinutes(occupancyStart, service.bufferBeforeMinutes);
      const endsAt = addMinutes(startsAt, service.durationMinutes);

      slots.push({
        startsAt,
        endsAt,
        occupancyStart,
        occupancyEnd,
        locationId: location.id,
        locationName: location.name,
        timezone: location.timezone,
        resourceIds: chosen.map((r) => r.id),
        resourceNames: chosen.map((r) => r.name),
        label: describeInstant(startsAt, location.timezone),
      });

      if (q.limit && slots.length >= q.limit) break;
    }
    if (q.limit && slots.length >= q.limit) break;
  }

  if (slots.length > 0) {
    slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return { available: true, slots: q.limit ? slots.slice(0, q.limit) : slots };
  }

  if (!sawAnyResource) return { available: false, reason: "no_matching_resource" };
  if (!sawAnyWindow || closedNote) {
    return { available: false, reason: "closed", publicNote: closedNote, nextOpenAt };
  }
  return { available: false, reason: "fully_booked" };
}

// ══════════════════════════════════════════════════════════════════════
//  Internals
// ══════════════════════════════════════════════════════════════════════

type ExceptionRow = {
  startsAt: Date;
  endsAt: Date;
  priority: number;
  serviceCategories: string[];
  publicReason: string | null;
  recurrence: string | null;
  recurrenceEnd: Date | null;
  type: {
    effect: "add" | "subtract";
    defaultPriority: number;
    publicVisible: boolean;
    defaultPublicReason: string | null;
  };
};

/** Expands a possibly-recurring exception into concrete occurrences in range. */
function expandOccurrences(row: ExceptionRow, from: Date, to: Date): ExceptionOccurrence[] {
  const priority = row.priority !== 0 ? row.priority : row.type.defaultPriority;
  // An internal reason must never escape. Only a type the tenant deliberately
  // marked publicVisible may contribute customer-facing wording.
  const publicNote = row.type.publicVisible
    ? (row.publicReason ?? row.type.defaultPublicReason ?? undefined)
    : undefined;

  const base = {
    effect: row.type.effect,
    priority,
    categories: row.serviceCategories,
    publicNote,
  };

  if (!row.recurrence) {
    if (!overlaps(row.startsAt, row.endsAt, from, to)) return [];
    return [{ start: row.startsAt, end: row.endsAt, ...base }];
  }

  const durationMs = row.endsAt.getTime() - row.startsAt.getTime();
  const until = row.recurrenceEnd && row.recurrenceEnd < to ? row.recurrenceEnd : to;

  let rule: RRule;
  try {
    rule = new RRule({
      ...RRule.parseString(row.recurrence),
      dtstart: row.startsAt,
    });
  } catch {
    // A malformed RRULE must not take down an availability query. Treating it as
    // a single occurrence is the conservative reading: the exception the staff
    // member entered still applies once, rather than vanishing silently.
    return overlaps(row.startsAt, row.endsAt, from, to)
      ? [{ start: row.startsAt, end: row.endsAt, ...base }]
      : [];
  }

  return rule
    .between(new Date(from.getTime() - durationMs), until, true)
    .map((start) => ({ start, end: new Date(start.getTime() + durationMs), ...base }))
    .filter((occ) => overlaps(occ.start, occ.end, from, to));
}

/** Layer 1: turn recurring rules into concrete windows over the query range. */
function baseWindows(
  rules: {
    weekday: number;
    startTime: string;
    endTime: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }[],
  dates: LocalDate[],
  tz: string,
  from: Date,
  to: Date,
): Window[] {
  const windows: Window[] = [];
  for (const date of dates) {
    const weekday = weekdayOf(date, tz);
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;

      const start = localToInstant(date, rule.startTime, tz);
      const end = localToInstant(date, rule.endTime, tz);
      // null = this wall-clock time does not exist on this date (spring-forward).
      // Skipping is correct: never offer a time the clock never reaches.
      if (!start || !end || end <= start) continue;

      if (start < rule.effectiveFrom) continue;
      if (rule.effectiveTo && end > rule.effectiveTo) continue;
      if (!overlaps(start, end, from, to)) continue;

      // Deliberately UNCLIPPED to the query range. The slot grid is anchored to
      // the window's true start, so "Mondays from 09:00, every 30 minutes" means
      // 09:00/09:30/10:00 no matter what time the caller happens to ask from.
      // Clipping here would re-anchor the grid to the query, and a request made
      // at 13:59 would start offering 13:59, 14:29, 14:59 — times that appear on
      // no schedule anyone configured. Range filtering happens per candidate.
      windows.push({ start, end });
    }
  }
  return windows;
}

/** Union of overlapping/adjacent windows, sorted. */
function mergeWindows(windows: Window[]): Window[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Window[] = [sorted[0]];
  for (const w of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (w.start <= last.end) {
      if (w.end > last.end) last.end = w.end;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/**
 * Every instant worth testing as a slot start: each free window walked on the
 * grid. Deduplicated across resources so a slot is evaluated once, not once per
 * candidate resource.
 */
function candidateStarts(
  freeByResource: Map<string, Window[]>,
  gridMinutes: number,
  from: Date,
  to: Date,
): Date[] {
  const seen = new Set<number>();
  const stepMs = Math.max(gridMinutes, 5) * 60_000;

  for (const windows of freeByResource.values()) {
    for (const w of windows) {
      // Anchored to the window start, so a 09:00-17:00 window yields
      // 09:00, 09:30, … regardless of where the query range begins. Candidates
      // outside the range are dropped after being generated, never before.
      for (let t = w.start.getTime(); t < w.end.getTime(); t += stepMs) {
        if (t < from.getTime() || t >= to.getTime()) continue;
        seen.add(t);
      }
    }
  }
  return [...seen].sort((a, b) => a - b).map((t) => new Date(t));
}

/**
 * Can this service's requirements all be met at [start, end)?
 *
 * Returns the specific resources that would be occupied, or null. Requirements
 * are satisfied greedily in declaration order and a resource is never assigned
 * twice — a service needing two stylists genuinely needs two people.
 */
function matchRequirements(
  requirements: { tags: string[]; kind: string | null; quantity: number }[],
  resources: { id: string; name: string; kind: string; tags: string[] }[],
  start: Date,
  end: Date,
  freeByResource: Map<string, Window[]>,
  bookingsByResource: Map<string, Window[]>,
  exceptionsByResource: Map<string, ExceptionOccurrence[]>,
  globalExceptions: ExceptionOccurrence[],
): { id: string; name: string }[] | null {
  const taken = new Set<string>();
  const chosen: { id: string; name: string }[] = [];

  for (const req of requirements) {
    let found = 0;
    for (const resource of resources) {
      if (found >= req.quantity) break;
      if (taken.has(resource.id)) continue;
      if (req.kind && resource.kind !== req.kind) continue;
      if (req.tags.length > 0 && !req.tags.every((t) => resource.tags.includes(t))) continue;

      if (
        !isResourceFree(
          resource.id,
          start,
          end,
          freeByResource,
          bookingsByResource,
          exceptionsByResource,
          globalExceptions,
        )
      ) {
        continue;
      }

      taken.add(resource.id);
      chosen.push({ id: resource.id, name: resource.name });
      found++;
    }
    if (found < req.quantity) return null;
  }
  return chosen;
}

function isResourceFree(
  resourceId: string,
  start: Date,
  end: Date,
  freeByResource: Map<string, Window[]>,
  bookingsByResource: Map<string, Window[]>,
  exceptionsByResource: Map<string, ExceptionOccurrence[]>,
  globalExceptions: ExceptionOccurrence[],
): boolean {
  const exceptions = [
    ...globalExceptions,
    ...(exceptionsByResource.get(resourceId) ?? []),
  ];

  // Highest-priority `subtract` touching the slot at all…
  let blockPriority = Number.NEGATIVE_INFINITY;
  for (const e of exceptions) {
    if (e.effect !== "subtract") continue;
    if (overlaps(start, end, e.start, e.end)) {
      blockPriority = Math.max(blockPriority, e.priority);
    }
  }

  // …versus the highest-priority `add` that covers the slot ENTIRELY. Partial
  // cover is not enough: an extra session running 14:00-16:00 cannot rescue an
  // appointment that would run to 16:30.
  let allowPriority = Number.NEGATIVE_INFINITY;
  for (const e of exceptions) {
    if (e.effect !== "add") continue;
    if (e.start <= start && e.end >= end) {
      allowPriority = Math.max(allowPriority, e.priority);
    }
  }

  // Strictly greater: on a tie, `subtract` wins and we fail closed.
  const overridden = allowPriority > blockPriority;
  if (blockPriority > Number.NEGATIVE_INFINITY && !overridden) return false;

  // Must sit inside a free window (Layer 1 ∪ additive exceptions) unless an
  // `add` explicitly overrode a block above.
  if (!overridden) {
    const windows = freeByResource.get(resourceId) ?? [];
    if (!windows.some((w) => w.start <= start && w.end >= end)) return false;
  }

  // Layer 3 always wins. An existing booking is never overridden by any
  // exception priority — that would be double-booking by configuration.
  const booked = bookingsByResource.get(resourceId) ?? [];
  return !booked.some((b) => overlaps(start, end, b.start, b.end));
}
