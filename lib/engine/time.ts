import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { addDays } from "date-fns";

/**
 * The boundary between two representations of time, kept deliberately narrow.
 *
 *   INSTANTS  — everything stored and compared. Always UTC, always Date.
 *   WALL CLOCK — what a business actually means. "Mondays 10:00" is a local
 *                fact about a location; it is NOT an instant until you know the
 *                location's timezone and the specific date.
 *
 * Every conversion between the two goes through this file. Nothing else in the
 * engine is allowed to construct a Date from a date-and-time string, because
 * that silently uses the *server's* timezone — which is how a schedule works
 * perfectly in Mumbai and shifts by an hour when the app is deployed elsewhere.
 */

/** A calendar date in a specific zone, as "yyyy-MM-dd". */
export type LocalDate = string;
/** A wall-clock time of day, as "HH:mm". */
export type LocalTime = string;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidLocalTime(value: string): value is LocalTime {
  return TIME_RE.test(value);
}

export function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timezone: ${tz}`);
  }
}

/** The calendar date an instant falls on, in `tz`. */
export function localDateIn(instant: Date, tz: string): LocalDate {
  return formatInTimeZone(instant, tz, "yyyy-MM-dd");
}

/** The wall-clock time an instant falls on, in `tz`. */
export function localTimeIn(instant: Date, tz: string): LocalTime {
  return formatInTimeZone(instant, tz, "HH:mm");
}

/** Day of week for a local date in `tz`: 0 = Sunday .. 6 = Saturday. */
export function weekdayOf(date: LocalDate, tz: string): number {
  // Midday avoids the DST edges entirely — no timezone shifts the clock far
  // enough for noon to land on a different calendar day.
  const noon = fromZonedTime(`${date}T12:00:00`, tz);
  return Number(formatInTimeZone(noon, tz, "i")) % 7; // date-fns "i" is 1=Mon..7=Sun
}

/**
 * Converts a local wall-clock date+time in `tz` to a UTC instant.
 *
 * Returns null when that wall-clock time DOES NOT EXIST — the hour skipped by a
 * spring-forward DST transition. Callers must treat null as "no slot here"
 * rather than substituting a nearby time: offering an appointment at a time the
 * clock never reaches is worse than offering nothing.
 *
 * Ambiguous times (the hour repeated at fall-back) resolve to the first
 * occurrence, which is the conventional and earlier-is-safer choice.
 */
export function localToInstant(
  date: LocalDate,
  time: LocalTime,
  tz: string,
): Date | null {
  const instant = fromZonedTime(`${date}T${time}:00`, tz);
  if (Number.isNaN(instant.getTime())) return null;

  // Round-trip check: if converting back does not reproduce the wall-clock time
  // we asked for, that time was skipped by a DST transition.
  const roundTrip = formatInTimeZone(instant, tz, "yyyy-MM-dd HH:mm");
  return roundTrip === `${date} ${time}` ? instant : null;
}

/**
 * Every local calendar date touched by the interval [from, to), in `tz`.
 * Inclusive of the date `to` falls on when `to` is not exactly midnight, because
 * a query ending at 09:00 still needs that morning's slots.
 */
export function localDatesBetween(from: Date, to: Date, tz: string): LocalDate[] {
  if (to < from) return [];
  const dates: LocalDate[] = [];
  const last = localDateIn(to, tz);

  // Walk in the target zone rather than in UTC, so a range that starts late in
  // the evening UTC does not skip the local day it belongs to.
  let cursor = toZonedTime(from, tz);
  let current = formatInTimeZone(fromZonedTime(cursor, tz), tz, "yyyy-MM-dd");

  // A hard bound so a bad timezone or a pathological range cannot spin forever.
  for (let guard = 0; guard < 800; guard++) {
    dates.push(current);
    if (current >= last) break;
    cursor = addDays(cursor, 1);
    current = formatInTimeZone(fromZonedTime(cursor, tz), tz, "yyyy-MM-dd");
  }
  return dates;
}

/** Minutes added to an instant, as a new instant. */
export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/** Half-open overlap test: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Formats an instant for a human in `tz`, e.g. "Thu 4 Sep, 3:00 pm". */
export function describeInstant(instant: Date, tz: string): string {
  return formatInTimeZone(instant, tz, "EEE d MMM, h:mm a");
}
