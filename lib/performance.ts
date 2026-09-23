import type { TenantDb } from "@/lib/prisma";
import { localDateIn } from "@/lib/engine/time";
import { estimateMicros } from "@/lib/conversation/pricing";
import { findVendor } from "@/lib/conversation/providers";

/**
 * How the business is actually doing.
 *
 * Separate from `lib/readiness.ts`, which asks whether a business *can* trade.
 * This asks whether it *is* — and the two want opposite things from a number.
 * Readiness is a checklist that should end up all green and then be ignored;
 * this is a trend somebody reads every week.
 *
 * Four rules decide every figure below.
 *
 * **1. Revenue means completed.** A booking earns money when the appointment
 * happens, not when it is made. `held` may expire, `scheduled` and `confirmed`
 * may still cancel, and counting either would report a number that can go *down*
 * without anybody doing anything wrong. What is on the books is reported too —
 * as a pipeline, under its own heading, never added to revenue.
 *
 * **2. The price is the one on the booking.** `Booking.priceMinor` is a snapshot
 * taken when the booking was made, and the schema says why: a promotion that
 * ends tomorrow must not reprice yesterday. Joining `Service.priceMinor` instead
 * would rewrite history every time somebody edited a price list.
 *
 * **3. A null price is not zero.** `priceQuotable` exists because some work
 * genuinely cannot be quoted — a clinic forbidden from naming a surgical total.
 * Those bookings are counted as work done and reported separately as revenue we
 * cannot state, because folding them in at zero would make the clinic whose
 * biggest procedures are all quote-on-request look like it earns nothing.
 *
 * **4. Months are the tenant's months.** Bucketed with `localDateIn` against the
 * location's own timezone, so a 9pm appointment in Dubai on the 31st lands in
 * that month rather than the next one in UTC. There is no default timezone here
 * either.
 */

/** A month bucket, keyed `YYYY-MM` in the tenant's own timezone. */
export type MonthlyRevenue = {
  month: string;
  /** What was charged, summed from booking-time snapshots. */
  revenueMinor: number;
  /** Completed bookings that carried a price. */
  bookings: number;
  /** Completed bookings with no price to state. */
  unpriced: number;
};

export type Outcome = { status: string; count: number; valueMinor: number };

export type Breakdown = {
  key: string;
  label: string;
  count: number;
  revenueMinor: number;
  /** Completed work here that carried no price. */
  unpriced: number;
};

export type Performance = {
  currency: string;
  timezone: string;
  /** Null when the tenant shows no tax at all. */
  tax: { label: string; rate: number; inclusive: boolean } | null;

  /** Oldest month first, one entry per month even when nothing happened in it. */
  trend: MonthlyRevenue[];
  thisMonth: MonthlyRevenue;
  lastMonth: MonthlyRevenue;
  /** Percentage change month on month, or null when last month was empty. */
  changePct: number | null;

  /** Completed, over the whole window. */
  window: {
    months: number;
    revenueMinor: number;
    bookings: number;
    unpriced: number;
    averageMinor: number | null;
    discountsMinor: number;
  };

  /** Booked and still to happen. Not revenue — see rule 1. */
  pipeline: { count: number; valueMinor: number; unpriced: number };

  /** Every terminal status in the window, so the losses are visible too. */
  outcomes: Outcome[];
  /** completed / (completed + cancelled + no_show), 0–100, null when nothing ended. */
  completionRate: number | null;

  byService: Breakdown[];
  /** api | agent | admin | connector — how much the assistant earns, in money. */
  bySource: Breakdown[];
  byLocation: Breakdown[];

  customers: {
    /** Distinct customers with completed work in the window. */
    served: number;
    /** Of everyone ever served, how many came back. */
    repeat: number;
    repeatRatePct: number | null;
  };
};

/** How far back the trend looks, including the current partial month. */
const WINDOW_MONTHS = 13;

const REVENUE_STATUSES = ["completed"] as const;
const PIPELINE_STATUSES = ["scheduled", "confirmed"] as const;
const ENDED_STATUSES = ["completed", "cancelled", "no_show"] as const;

export async function loadPerformance(
  db: TenantDb,
  tenant: {
    id: string;
    currency: string;
    timezone: string;
    taxLabel: string | null;
    taxRate: number;
    taxInclusive: boolean;
  },
  now = new Date(),
): Promise<Performance> {
  const tz = tenant.timezone;
  const months = monthKeysEndingAt(now, tz, WINDOW_MONTHS);
  // The first instant that can land in the oldest bucket. Generous by a day at
  // each end rather than exact, because the filter is a coarse prefilter and
  // `localDateIn` does the authoritative bucketing below.
  const since = new Date(`${months[0]}-01T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 1);

  const [completed, pipeline, ended, perCustomer, services, locations] = await Promise.all([
    // Only the columns the arithmetic needs. A busy salon has thousands of rows
    // in thirteen months and no reason to ship notes and cancel reasons along.
    db.booking.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: [...REVENUE_STATUSES] },
        startsAt: { gte: since },
      },
      select: {
        startsAt: true,
        priceMinor: true,
        discountMinor: true,
        serviceId: true,
        locationId: true,
        source: true,
        customerId: true,
      },
    }),
    db.booking.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: [...PIPELINE_STATUSES] },
        startsAt: { gte: now },
      },
      select: { priceMinor: true },
    }),
    db.booking.groupBy({
      by: ["status"],
      where: {
        tenantId: tenant.id,
        status: { in: [...ENDED_STATUSES] },
        startsAt: { gte: since },
      },
      _count: { _all: true },
      _sum: { priceMinor: true },
    }),
    // All-time, because "did they come back" is not a question about a window.
    db.booking.groupBy({
      by: ["customerId"],
      where: { tenantId: tenant.id, status: { in: [...REVENUE_STATUSES] } },
      _count: { _all: true },
    }),
    db.service.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true } }),
    db.location.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true } }),
  ]);

  // ── Bucket by the tenant's own calendar ─────────────────────────────
  const buckets = new Map<string, MonthlyRevenue>(
    months.map((m) => [m, { month: m, revenueMinor: 0, bookings: 0, unpriced: 0 }]),
  );

  const serviceNames = new Map(services.map((s) => [s.id, s.name]));
  const locationNames = new Map(locations.map((l) => [l.id, l.name]));

  const byService = new Map<string, Breakdown>();
  const bySource = new Map<string, Breakdown>();
  const byLocation = new Map<string, Breakdown>();
  const servedCustomers = new Set<string>();

  let windowRevenue = 0;
  let windowBookings = 0;
  let windowUnpriced = 0;
  let discounts = 0;

  const add = (
    into: Map<string, Breakdown>,
    key: string,
    label: string,
    price: number | null,
  ) => {
    const row = into.get(key) ?? { key, label, count: 0, revenueMinor: 0, unpriced: 0 };
    row.count += 1;
    if (price === null) row.unpriced += 1;
    else row.revenueMinor += price;
    into.set(key, row);
  };

  for (const b of completed) {
    const month = localDateIn(b.startsAt, tz).slice(0, 7);
    const bucket = buckets.get(month);
    // Outside the window after timezone resolution — the coarse SQL filter
    // deliberately over-fetches by a day at each edge.
    if (!bucket) continue;

    servedCustomers.add(b.customerId);
    discounts += b.discountMinor ?? 0;

    if (b.priceMinor === null) {
      bucket.unpriced += 1;
      windowUnpriced += 1;
    } else {
      bucket.revenueMinor += b.priceMinor;
      bucket.bookings += 1;
      windowRevenue += b.priceMinor;
      windowBookings += 1;
    }

    add(byService, b.serviceId, serviceNames.get(b.serviceId) ?? "a deleted service", b.priceMinor);
    add(bySource, b.source, sourceLabel(b.source), b.priceMinor);
    add(
      byLocation,
      b.locationId,
      locationNames.get(b.locationId) ?? "a deleted location",
      b.priceMinor,
    );
  }

  const trend = months.map((m) => buckets.get(m)!);
  const thisMonth = trend[trend.length - 1];
  const lastMonth = trend[trend.length - 2] ?? { month: "", revenueMinor: 0, bookings: 0, unpriced: 0 };

  const outcomes: Outcome[] = ENDED_STATUSES.map((status) => {
    const row = ended.find((e) => e.status === status);
    return {
      status,
      count: row?._count._all ?? 0,
      valueMinor: row?._sum.priceMinor ?? 0,
    };
  });

  const endedTotal = outcomes.reduce((n, o) => n + o.count, 0);
  const completedCount = outcomes.find((o) => o.status === "completed")?.count ?? 0;

  const repeat = perCustomer.filter((c) => c._count._all > 1).length;
  const everServed = perCustomer.length;

  const pipelineUnpriced = pipeline.filter((p) => p.priceMinor === null).length;

  return {
    currency: tenant.currency,
    timezone: tz,
    tax: tenant.taxLabel
      ? { label: tenant.taxLabel, rate: tenant.taxRate, inclusive: tenant.taxInclusive }
      : null,
    trend,
    thisMonth,
    lastMonth,
    // Guarded rather than computed: a month that started at zero makes every
    // percentage infinite, and "up ∞%" on the first sale of a new business is
    // worse than no figure at all.
    changePct:
      lastMonth.revenueMinor > 0
        ? Math.round(
            ((thisMonth.revenueMinor - lastMonth.revenueMinor) / lastMonth.revenueMinor) * 100,
          )
        : null,
    window: {
      months: WINDOW_MONTHS,
      revenueMinor: windowRevenue,
      bookings: windowBookings,
      unpriced: windowUnpriced,
      averageMinor: windowBookings > 0 ? Math.round(windowRevenue / windowBookings) : null,
      discountsMinor: discounts,
    },
    pipeline: {
      count: pipeline.length,
      valueMinor: pipeline.reduce((n, p) => n + (p.priceMinor ?? 0), 0),
      unpriced: pipelineUnpriced,
    },
    outcomes,
    completionRate: endedTotal > 0 ? Math.round((completedCount / endedTotal) * 100) : null,
    byService: rank(byService),
    bySource: rank(bySource),
    byLocation: rank(byLocation),
    customers: {
      served: servedCustomers.size,
      repeat,
      repeatRatePct: everServed > 0 ? Math.round((repeat / everServed) * 100) : null,
    },
  };
}

/**
 * Biggest earner first, and where nothing is priced, most work first — so a list
 * of quote-on-request services still ranks by something real.
 */
function rank(rows: Map<string, Breakdown>): Breakdown[] {
  return [...rows.values()].sort(
    (a, b) => b.revenueMinor - a.revenueMinor || b.count - a.count,
  );
}

/** What `Booking.source` means to somebody who does not read the schema. */
function sourceLabel(source: string): string {
  switch (source) {
    case "agent":
      return "the assistant";
    case "admin":
      return "entered by staff";
    case "connector":
      return "your other software";
    case "api":
      return "your own integration";
    default:
      return source;
  }
}

/**
 * The last `count` month keys, oldest first, ending with the month it is now in
 * the tenant's timezone.
 *
 * Walked as calendar months rather than by subtracting 30 days, because "a month
 * ago" from the 31st is not a date and month lengths are not uniform.
 */
function monthKeysEndingAt(now: Date, tz: string, count: number): string[] {
  const [y, m] = localDateIn(now, tz).split("-").map(Number);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // Month is 1-based here; Date's UTC constructor is 0-based, which is what
    // makes the arithmetic below wrap the year correctly.
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

// ══════════════════════════════════════════════════════════════════════
//  What the assistant did, and what it cost
// ══════════════════════════════════════════════════════════════════════

/**
 * Conversations and model spend, which is a different question from revenue and
 * deliberately answered separately.
 *
 * Two rules, both of them about not stating a number we do not have.
 *
 * **Cost is shown only to a business spending its own money.** A tenant on
 * enori's key sees how much the assistant did and no dollar figure, because
 * what their traffic costs *us* is our side of the arrangement, not a line on
 * their dashboard. A tenant on their own key sees an estimate, because it is
 * their invoice they are trying to understand.
 *
 * **That estimate is list price, and says so.** `ModelUsage.costMicros` is null
 * for every tenant-key row by design — we never saw their rate card, so we never
 * wrote a number down. Rendering one means computing it now from Anthropic's
 * published table, which is right for a standard account, wrong for a negotiated
 * one, and impossible for DeepSeek or a self-hosted model. When the model is not
 * one we price, the cost is null and only tokens are shown.
 */
export type AssistantMonth = {
  month: string;
  conversations: number;
  /** Every token across every call billed in this month. */
  tokens: number;
  /** Estimated USD micros, or null when unpriceable or not ours to show. */
  costMicros: number | null;
};

export type AssistantYear = {
  year: number;
  conversations: number;
  tokens: number;
  costMicros: number | null;
  /** False for the year in progress, so a partial year is never read as a drop. */
  complete: boolean;
};

export type AssistantUsage = {
  /** Whose key answers. Decides whether any money appears at all. */
  onOwnKey: boolean;
  keyLabel: string;
  /** True when cost figures are estimates from the published rate card. */
  estimated: boolean;
  /** Tokens we could not price — an own-key model with no published rate. */
  unpricedTokens: number;
  /** When the ledger starts. Anything before this is missing, not zero. */
  ledgerStartsAt: Date | null;

  trend: AssistantMonth[];
  thisMonth: AssistantMonth;
  lastMonth: AssistantMonth;
  monthChangePct: number | null;

  /** True totals per calendar year. The year in progress is flagged, not clipped. */
  years: AssistantYear[];
  /**
   * Like for like: this year so far, against the SAME stretch of last year.
   *
   * Not `years[]` divided against each other — in September that compares nine
   * months to twelve and reports a thriving business as down a third. Cut to the
   * same month and day in both years, which is the only comparison that means
   * anything before December.
   */
  ytd: { thisYear: number; lastYear: number; throughDate: string };
  /** Change on the same stretch of last year, from `ytd`. Null without a pair. */
  yearChangePct: number | null;

  totals: { conversations: number; inbound: number; outbound: number; handedOver: number };
};

export async function loadAssistantUsage(
  db: TenantDb,
  tenant: { id: string; timezone: string },
  now = new Date(),
): Promise<AssistantUsage> {
  const tz = tenant.timezone;
  const months = monthKeysEndingAt(now, tz, WINDOW_MONTHS);

  // Reaches back to the start of LAST calendar year, not just thirteen months:
  // a year-on-year comparison in September needs all of the year before it, which
  // a rolling window does not contain.
  const thisYear = Number(localDateIn(now, tz).slice(0, 4));
  const from = new Date(`${thisYear - 1}-01-01T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);

  const [conversations, usage, messages, handedOver, provider, ledgerStart] = await Promise.all([
    db.conversation.findMany({
      where: { tenantId: tenant.id, createdAt: { gte: from } },
      select: { createdAt: true },
    }),
    db.modelUsage.findMany({
      where: { tenantId: tenant.id, createdAt: { gte: from } },
      select: {
        createdAt: true,
        source: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    }),
    db.conversationMessage.groupBy({
      by: ["direction"],
      where: { tenantId: tenant.id, createdAt: { gte: from } },
      _count: { _all: true },
    }),
    db.conversation.count({ where: { tenantId: tenant.id, botPaused: true } }),
    // No `apiKey` — see lib/platform/metrics.ts for why that is a rule and not a
    // preference. This page never needs the secret either.
    db.modelProvider.findFirst({
      where: { tenantId: tenant.id, active: true },
      select: { vendor: true },
    }),
    db.modelUsage.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  const onOwnKey = Boolean(provider);
  const keyLabel = provider
    ? `your own ${findVendor(provider.vendor)?.label ?? provider.vendor} key`
    : "enori's key";

  const empty = (month: string): AssistantMonth => ({
    month,
    conversations: 0,
    tokens: 0,
    // Null rather than 0 when we will never show money here, so the page cannot
    // accidentally render "$0.00" and imply the assistant was free.
    costMicros: onOwnKey ? 0 : null,
  });

  const buckets = new Map<string, AssistantMonth>(months.map((m) => [m, empty(m)]));
  const years = new Map<number, AssistantYear>();
  const yearOf = (d: Date) => Number(localDateIn(d, tz).slice(0, 4));

  // Whether ANY row in a bucket could be priced. Without this, a business on
  // DeepSeek — whose rates we have never seen — is shown "$0.00", which reads as
  // "the assistant is free" rather than "we cannot tell you". Zero is a real
  // amount; not knowing is not zero.
  const pricedInMonth = new Set<string>();
  const pricedInYear = new Set<number>();

  const touchYear = (year: number): AssistantYear => {
    const row =
      years.get(year) ??
      ({
        year,
        conversations: 0,
        tokens: 0,
        costMicros: onOwnKey ? 0 : null,
        complete: year < thisYear,
      } satisfies AssistantYear);
    years.set(year, row);
    return row;
  };

  for (const c of conversations) {
    const key = localDateIn(c.createdAt, tz).slice(0, 7);
    const bucket = buckets.get(key);
    if (bucket) bucket.conversations += 1;
    touchYear(yearOf(c.createdAt)).conversations += 1;
  }

  let unpricedTokens = 0;

  for (const u of usage) {
    const tokens =
      u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const cost = onOwnKey
      ? estimateMicros(u.model, {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadTokens,
          cacheWrite: u.cacheWriteTokens,
        })
      : null;

    if (onOwnKey && cost === null) unpricedTokens += tokens;

    const monthKey = localDateIn(u.createdAt, tz).slice(0, 7);
    const bucket = buckets.get(monthKey);
    if (bucket) {
      bucket.tokens += tokens;
      if (cost !== null && bucket.costMicros !== null) {
        bucket.costMicros += cost;
        pricedInMonth.add(monthKey);
      }
    }

    const y = yearOf(u.createdAt);
    const year = touchYear(y);
    year.tokens += tokens;
    if (cost !== null && year.costMicros !== null) {
      year.costMicros += cost;
      pricedInYear.add(y);
    }
  }

  // Spent tokens with nothing priceable among them → null, not zero.
  for (const [key, b] of buckets) {
    if (b.tokens > 0 && !pricedInMonth.has(key)) b.costMicros = null;
  }
  for (const [y, row] of years) {
    if (row.tokens > 0 && !pricedInYear.has(y)) row.costMicros = null;
  }

  const trend = months.map((m) => buckets.get(m)!);
  const thisMonth = trend[trend.length - 1];
  const lastMonth = trend[trend.length - 2] ?? empty("");

  const yearRows = [...years.values()].sort((a, b) => a.year - b.year);

  // `MM-DD` today, in the tenant's own calendar. A conversation from last year
  // counts toward the comparison only if it happened on or before this point of
  // that year.
  const throughDate = localDateIn(now, tz).slice(5);
  let ytdThis = 0;
  let ytdLast = 0;
  for (const c of conversations) {
    const local = localDateIn(c.createdAt, tz);
    const year = Number(local.slice(0, 4));
    if (local.slice(5) > throughDate) continue;
    if (year === thisYear) ytdThis += 1;
    else if (year === thisYear - 1) ytdLast += 1;
  }

  return {
    onOwnKey,
    keyLabel,
    estimated: onOwnKey,
    unpricedTokens,
    ledgerStartsAt: ledgerStart?.createdAt ?? null,
    trend,
    thisMonth,
    lastMonth,
    monthChangePct:
      lastMonth.conversations > 0
        ? Math.round(
            ((thisMonth.conversations - lastMonth.conversations) / lastMonth.conversations) * 100,
          )
        : null,
    years: yearRows,
    ytd: { thisYear: ytdThis, lastYear: ytdLast, throughDate },
    // Compared on conversations, not money: a rate card change would otherwise
    // show up as a change in how busy the business was.
    yearChangePct:
      ytdLast > 0 ? Math.round(((ytdThis - ytdLast) / ytdLast) * 100) : null,
    totals: {
      conversations: conversations.length,
      inbound: messages.find((m) => m.direction === "inbound")?._count._all ?? 0,
      outbound: messages.find((m) => m.direction === "outbound")?._count._all ?? 0,
      handedOver,
    },
  };
}
