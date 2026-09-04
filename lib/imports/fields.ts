/**
 * What a column can become, and how to read what is actually in it.
 *
 * The mapping step decides *which* column is the price. This file decides what
 * "₹1,500.00" means — and that half is where imports really go wrong, because
 * every one of these values was typed by a person into a box with no validation
 * over several years.
 *
 * Every parser returns a reason rather than throwing. One unreadable cell in row
 * 40 must not abandon rows 41 to 300; it must import them and tell the owner
 * which cell to look at.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; why: string };

export type FieldSpec = {
  key: string;
  label: string;
  /** Shown to the model when it maps, and to the owner when they correct it. */
  hint: string;
  required?: boolean;
  parse: (raw: string, ctx: { currency: string }) => Parsed<unknown>;
};

// ── Value readers ─────────────────────────────────────────────────────

const BLANK = new Set(["", "-", "—", "n/a", "na", "none", "null", "tbd"]);

export function isBlank(raw: string): boolean {
  return BLANK.has(raw.trim().toLowerCase());
}

/**
 * Currencies with no minor unit.
 *
 * Multiplying by 100 for these turns ¥500 into ¥50,000. The list is short and
 * the failure is silent and total, so it is worth carrying rather than assuming
 * two decimal places everywhere.
 */
const ZERO_DECIMAL = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "UGX", "RWF", "XAF", "XOF", "XPF", "KMF",
  "DJF", "GNF", "PYG", "BIF", "MGA", "VUV",
]);

export function minorUnitFactor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

/**
 * Money, as typed by a human.
 *
 * Handles a currency symbol or code either side, thousands separators, and
 * parentheses. Refuses rather than guesses on anything ambiguous — a
 * misread price is quoted to a customer as fact.
 */
export function parseMoney(raw: string, currency: string): Parsed<number | null> {
  const t = raw.trim();
  if (isBlank(t)) return { ok: true, value: null };

  // "on request", "POA", "call us" — a real and deliberate answer in several
  // trades, and precisely what priceMinor = null already means.
  if (/^(price\s*)?(on\s*request|poa|call|ask|varies|quote)/i.test(t)) {
    return { ok: true, value: null };
  }

  // Strip currency symbols, codes and spaces; keep digits, separators, sign.
  let s = t
    .replace(/[\p{Sc}]/gu, "")
    .replace(/\b[A-Z]{3}\b/g, "")
    .replace(/\s| /g, "")
    .trim();

  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()]/g, "").replace(/^-/, "");

  // Decide which separator is decimal. "1,500" is fifteen hundred; "1,50" is
  // one-fifty in half of Europe. The rule that works: whichever separator is
  // last, if it is followed by exactly two digits, is the decimal point.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalAt = -1;
  if (lastComma > lastDot && /,\d{1,2}$/.test(s)) decimalAt = lastComma;
  else if (lastDot > lastComma && /\.\d{1,2}$/.test(s)) decimalAt = lastDot;

  let whole: string;
  let frac = "";
  if (decimalAt >= 0) {
    whole = s.slice(0, decimalAt).replace(/[.,]/g, "");
    frac = s.slice(decimalAt + 1);
  } else {
    whole = s.replace(/[.,]/g, "");
  }

  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac) || (whole === "" && frac === "")) {
    return { ok: false, why: `“${t}” is not a price we can read.` };
  }

  const factor = minorUnitFactor(currency);
  const minor =
    factor === 1
      ? Number(whole || "0")
      : Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));

  if (!Number.isFinite(minor)) return { ok: false, why: `“${t}” is not a price we can read.` };
  if (negative) return { ok: false, why: `“${t}” is negative.` };
  if (minor > 1_000_000_000) return { ok: false, why: `“${t}” is implausibly large.` };

  return { ok: true, value: Math.round(minor) };
}

/**
 * Duration, as typed by a human.
 *
 * "45", "45 min", "1h", "1 hr 30", "1:30", "1.5 hours" all appear in real price
 * lists, often several of them in the same column.
 */
export function parseDuration(raw: string): Parsed<number> {
  const t = raw.trim().toLowerCase();
  if (isBlank(t)) return { ok: false, why: "No duration given." };

  // 1:30
  const clock = t.match(/^(\d+):([0-5]\d)$/);
  if (clock) return finishDuration(Number(clock[1]) * 60 + Number(clock[2]), raw);

  // 1h 30m / 1 hr 30 min / 2 hours
  const hm = t.match(/^(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours)\s*(\d+)?\s*(?:m|min|mins|minute|minutes)?$/);
  if (hm) {
    const hours = Number(hm[1].replace(",", "."));
    const mins = hm[2] ? Number(hm[2]) : 0;
    return finishDuration(Math.round(hours * 60) + mins, raw);
  }

  // 45m / 45 min / 45 minutes
  const m = t.match(/^(\d+)\s*(?:m|min|mins|minute|minutes)$/);
  if (m) return finishDuration(Number(m[1]), raw);

  // A bare number is minutes. This is the common case and the one worth being
  // most careful about: "1.5" bare almost certainly means an hour and a half,
  // not ninety seconds of nothing, but guessing between the two is exactly the
  // kind of silent wrongness that ends up in a booking.
  if (/^\d+$/.test(t)) return finishDuration(Number(t), raw);
  if (/^\d+[.,]\d+$/.test(t)) {
    return { ok: false, why: `“${raw}” could be minutes or hours — write it as “90 min” or “1h 30”.` };
  }

  return { ok: false, why: `“${raw}” is not a length of time we can read.` };
}

function finishDuration(minutes: number, raw: string): Parsed<number> {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, why: `“${raw}” is not a length of time we can read.` };
  }
  // A day. Longer is a data error every time — usually a price in the duration
  // column, which is exactly the mix-up this catches.
  if (minutes > 1440) return { ok: false, why: `“${raw}” is longer than a day.` };
  return { ok: true, value: Math.round(minutes) };
}

const TRUE = new Set(["yes", "y", "true", "1", "active", "on", "enabled", "available", "✓", "x"]);
const FALSE = new Set(["no", "n", "false", "0", "inactive", "off", "disabled", "discontinued"]);

export function parseBoolean(raw: string, whenBlank: boolean): Parsed<boolean> {
  const t = raw.trim().toLowerCase();
  if (isBlank(t)) return { ok: true, value: whenBlank };
  if (TRUE.has(t)) return { ok: true, value: true };
  if (FALSE.has(t)) return { ok: true, value: false };
  return { ok: false, why: `“${raw}” is not a yes or a no.` };
}

/**
 * A phone number, kept as typed apart from obvious noise.
 *
 * Deliberately NOT normalised to E.164 here. The codebase already normalises on
 * write against the tenant's region (see the Customer model), and doing it twice
 * in two places is how the two disagree.
 */
export function parsePhone(raw: string): Parsed<string | null> {
  const t = raw.trim();
  if (isBlank(t)) return { ok: true, value: null };
  const digits = t.replace(/[^\d]/g, "");
  if (digits.length < 6) return { ok: false, why: `“${raw}” is too short to be a phone number.` };
  if (digits.length > 15) return { ok: false, why: `“${raw}” has too many digits for a phone number.` };
  return { ok: true, value: t };
}

export function parseEmail(raw: string): Parsed<string | null> {
  const t = raw.trim();
  if (isBlank(t)) return { ok: true, value: null };
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(t)) {
    return { ok: false, why: `“${raw}” is not an email address.` };
  }
  return { ok: true, value: t.toLowerCase() };
}

function text(max: number, required = false) {
  return (raw: string): Parsed<string | null> => {
    const t = raw.trim();
    if (isBlank(t)) {
      return required ? { ok: false, why: "This cannot be empty." } : { ok: true, value: null };
    }
    return { ok: true, value: t.slice(0, max) };
  };
}

// ── What each kind of sheet can contain ───────────────────────────────

export const SERVICE_FIELDS: FieldSpec[] = [
  {
    key: "name",
    label: "Service name",
    hint: "What the business calls it — “Ladies cut and finish”, “PRP session”, “Full service”.",
    required: true,
    parse: (raw) => text(200, true)(raw),
  },
  {
    key: "category",
    label: "Category",
    hint: "A grouping the business uses — “Hair”, “Colour”, “Consultation”. Optional.",
    parse: (raw) => text(80)(raw),
  },
  {
    key: "description",
    label: "Description",
    hint: "A sentence about what it involves. Optional.",
    parse: (raw) => text(2000)(raw),
  },
  {
    key: "durationMinutes",
    label: "How long it takes",
    hint: "In minutes, or written as “1h 30”. Required — a service with no length cannot be booked.",
    required: true,
    parse: (raw) => parseDuration(raw),
  },
  {
    key: "priceMinor",
    label: "Price",
    hint: "The amount customers pay. Blank, or “on request”, means the price is not quoted.",
    parse: (raw, ctx) => parseMoney(raw, ctx.currency),
  },
  {
    key: "bufferAfterMinutes",
    label: "Turnaround after",
    hint: "Cleanup or notes time that also blocks the room. Minutes. Optional.",
    parse: (raw) => (isBlank(raw) ? { ok: true, value: 0 } : parseDuration(raw)),
  },
  {
    key: "active",
    label: "Still offered",
    hint: "Yes or no. Blank counts as yes.",
    parse: (raw) => parseBoolean(raw, true),
  },
  {
    key: "externalId",
    label: "Their own reference",
    hint: "A code or id from the old system. Used to match rows on later syncs.",
    parse: (raw) => text(120)(raw),
  },
];

/**
 * A time of day, as written on a rota.
 *
 * "9", "9am", "09:00", "9.30", "5pm" and "17:00" all appear, frequently in the
 * same column of the same sheet.
 */
function parseTimeOfDay(raw: string): { minutes: number; explicitMeridiem: boolean } | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/);
  if (!m) return null;

  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];

  if (min > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 24) return null;

  const minutes = hour * 60 + min;
  if (minutes > 24 * 60) return null;
  return { minutes, explicitMeridiem: Boolean(meridiem) };
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const CLOSED = new Set(["off", "closed", "x", "-", "—", "rest", "holiday", "leave", "none", "no"]);

export type Shift = { startTime: string; endTime: string };

/**
 * One cell of a weekly rota: "9-5", "10:00-18:00", "off", or a split shift.
 *
 * Split shifts — "9-1, 2-6" — are normal wherever the business closes for lunch,
 * and reading one as a single 9-to-6 block would offer appointments during the
 * hour nobody is there. They become two rules.
 *
 * The 12-hour inference is the load-bearing bit. "9-5" is universally understood
 * to mean nine in the morning to five in the afternoon, and read literally it is
 * an eight-hour day ending before it starts. So an end earlier than its start,
 * with no am/pm written, gains twelve hours. Anything still inverted after that
 * is refused rather than guessed — an overnight shift is real but rare here, and
 * silently inventing one would open a business at three in the morning.
 */
export function parseShifts(raw: string): Parsed<Shift[]> {
  const t = raw.trim();
  if (isBlank(t) || CLOSED.has(t.toLowerCase())) return { ok: true, value: [] };

  const shifts: Shift[] = [];

  // How far through the day we have already got. A cell is read left to right
  // as one day moving forwards, which is what makes "9-1, 2-6" work: read alone,
  // "2-6" is two in the MORNING, and only the 9-to-1 before it says otherwise.
  // Getting this wrong opened the salon at two in the morning and closed it
  // before anybody arrived.
  let cursor = 0;

  // Split on commas, semicolons, "&" and the word "and".
  for (const piece of t.split(/\s*(?:,|;|&|\band\b)\s*/i)) {
    if (!piece.trim()) continue;

    // Accept -, –, —, "to" as the separator.
    const parts = piece.split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean);
    if (parts.length !== 2) {
      return { ok: false, why: `“${raw}” is not a pair of times — write it like “9-5” or “off”.` };
    }

    const from = parseTimeOfDay(parts[0]);
    const to = parseTimeOfDay(parts[1]);
    if (!from || !to) {
      return { ok: false, why: `“${raw}” is not a pair of times — write it like “9-5” or “off”.` };
    }

    let start = from.minutes;
    if (start < cursor && !from.explicitMeridiem && start + 12 * 60 <= 24 * 60) {
      start += 12 * 60;
    }

    let end = to.minutes;
    if (end <= start && !to.explicitMeridiem && end + 12 * 60 <= 24 * 60) {
      end += 12 * 60;
    }
    if (end <= start) {
      return {
        ok: false,
        why: `“${raw}” finishes before it starts. Overnight shifts are not supported yet.`,
      };
    }

    shifts.push({ startTime: hhmm(start), endTime: hhmm(end) });
    cursor = end;
  }

  // Overlapping halves of a split shift would generate two rules covering the
  // same hour, which doubles nothing useful and confuses the availability grid.
  const sorted = [...shifts].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) {
      return { ok: false, why: `“${raw}” has two shifts that overlap.` };
    }
  }

  return { ok: true, value: shifts };
}

/** A comma-separated list, used for the open vocabulary of resource tags. */
export function parseTags(raw: string): Parsed<string[]> {
  const t = raw.trim();
  if (isBlank(t)) return { ok: true, value: [] };
  const tags = t
    .split(/\s*[,;/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  return { ok: true, value: tags };
}

const WEEKDAYS = [
  ["hoursSun", "Sunday", 0],
  ["hoursMon", "Monday", 1],
  ["hoursTue", "Tuesday", 2],
  ["hoursWed", "Wednesday", 3],
  ["hoursThu", "Thursday", 4],
  ["hoursFri", "Friday", 5],
  ["hoursSat", "Saturday", 6],
] as const;

/** field key → weekday number, for the seven rota columns. */
export const WEEKDAY_OF_FIELD = new Map<string, number>(
  WEEKDAYS.map(([key, , n]) => [key, n as number]),
);

/**
 * Staff and rooms, with their week.
 *
 * Modelled as one row per person and one column per day, because that is how a
 * rota is actually written on the sheet taped to the back office wall. The
 * alternative — a row per person per weekday — is tidier and nobody keeps it
 * that way.
 */
export const STAFF_FIELDS: FieldSpec[] = [
  {
    key: "name",
    label: "Name",
    hint: "The person or room — “Priya”, “Chair 2”, “Treatment room”.",
    required: true,
    parse: (raw) => text(200, true)(raw),
  },
  {
    key: "tags",
    label: "What they can do",
    hint: "Comma-separated skills or types that match your services — “Hair, Colour”. Optional.",
    parse: (raw) => parseTags(raw),
  },
  {
    key: "locationName",
    label: "Which location",
    hint: "The branch name, matched to your locations. Leave unmapped if you have only one.",
    parse: (raw) => text(120)(raw),
  },
  ...WEEKDAYS.map(([key, day]) => ({
    key,
    label: `${day} hours`,
    hint: `Working hours on ${day} — “9-5”, “10:00-18:00”, “9-1, 2-6” for a lunch break, or “off”.`,
    parse: (raw: string) => parseShifts(raw),
  })),
  {
    key: "slotMinutes",
    label: "Appointment grid",
    hint: "How often an appointment can start, in minutes. Defaults to 30.",
    parse: (raw) => (isBlank(raw) ? { ok: true, value: null } : parseDuration(raw)),
  },
  {
    key: "active",
    label: "Still working here",
    hint: "Yes or no. Blank counts as yes.",
    parse: (raw) => parseBoolean(raw, true),
  },
  {
    key: "externalId",
    label: "Their own reference",
    hint: "A staff id from the old system. Used to match rows on later syncs.",
    parse: (raw) => text(120)(raw),
  },
];

export const CUSTOMER_FIELDS: FieldSpec[] = [
  {
    key: "name",
    label: "Name",
    hint: "The customer's name as the business writes it.",
    parse: (raw) => text(200)(raw),
  },
  {
    key: "phone",
    label: "Phone",
    hint: "Any format. Required unless there is an email.",
    parse: (raw) => parsePhone(raw),
  },
  {
    key: "email",
    label: "Email",
    hint: "Required unless there is a phone.",
    parse: (raw) => parseEmail(raw),
  },
  {
    key: "externalId",
    label: "Their own reference",
    hint: "A customer number from the old system. Used to match rows on later syncs.",
    parse: (raw) => text(120)(raw),
  },
];

export const KINDS = {
  services: {
    label: "Services and prices",
    blurb: "What you offer, how long each takes, and what it costs.",
    fields: SERVICE_FIELDS,
  },
  staff: {
    label: "Staff, rooms and their hours",
    blurb: "Who works when — one row per person, one column per day.",
    fields: STAFF_FIELDS,
  },
  customers: {
    label: "Customers",
    blurb: "Names and contact details of people who have been in before.",
    fields: CUSTOMER_FIELDS,
  },
} as const;

export type ImportKind = keyof typeof KINDS;

export function fieldsFor(kind: string): FieldSpec[] {
  const k = KINDS[kind as ImportKind];
  if (!k) throw new Error(`Unknown import kind: ${kind}`);
  return [...k.fields];
}
