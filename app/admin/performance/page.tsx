import { requireUser, asTenant } from "@/lib/auth/guard";
import {
  loadPerformance,
  loadAssistantUsage,
  type AssistantUsage,
  type Breakdown,
} from "@/lib/performance";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { formatTokens, formatUsd } from "@/lib/conversation/pricing";
import { Empty, PageHeader, Section } from "../ui";

export const dynamic = "force-dynamic";

/**
 * How the business is doing.
 *
 * Deliberately NOT on /admin, which is "Today" — what the front desk needs on
 * opening, and a screen whose own comment says it is not a place for
 * configuration. A trend somebody reads once a week does not belong on the one
 * screen that has to answer "who is coming in at ten".
 *
 * Every number here is completed work. What is merely booked appears once, under
 * its own heading, and is never added to revenue — see the rules in
 * lib/performance.ts.
 */
export default async function PerformancePage() {
  const user = await requireUser();

  const data = await asTenant(user, async (db) => {
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
      select: {
        id: true,
        currency: true,
        timezone: true,
        taxLabel: true,
        taxRate: true,
        taxInclusive: true,
      },
    });
    return {
      perf: await loadPerformance(db, tenant),
      assistant: await loadAssistantUsage(db, tenant),
    };
  });
  const { perf, assistant } = data;

  const cur = perf.currency;
  const money = (m: number) => formatMoney(m, cur);
  const nothingYet = perf.window.revenueMinor === 0 && perf.window.unpriced === 0;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="How the business is doing"
        lede={`Completed appointments only — what was actually delivered, priced as it was on the day it was booked. Months follow your own calendar in ${perf.timezone}.`}
      />

      {nothingYet ? (
        <Empty>
          Nothing has been completed yet, so there is no revenue to show. Once an appointment
          has been and gone, mark it complete and it will appear here.
        </Empty>
      ) : (
        <>
          {/* ── The headline ───────────────────────────────────────── */}
          <Section title="Revenue">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                label="This month so far"
                value={money(perf.thisMonth.revenueMinor)}
                note={
                  perf.changePct === null
                    ? "no figure for last month to compare"
                    : `${perf.changePct >= 0 ? "up" : "down"} ${Math.abs(perf.changePct)}% on last month`
                }
                tone={perf.changePct === null ? undefined : perf.changePct >= 0 ? "ok" : "warn"}
              />
              <Metric label="Last month" value={money(perf.lastMonth.revenueMinor)} />
              <Metric
                label="Average appointment"
                value={perf.window.averageMinor === null ? "—" : money(perf.window.averageMinor)}
                note={`across ${perf.window.bookings} priced appointment${perf.window.bookings === 1 ? "" : "s"}`}
              />
              <Metric
                label="Discounts given"
                value={money(perf.window.discountsMinor)}
                note="over the last year"
              />
            </div>

            <MonthlyBars
              bars={perf.trend.map((m) => ({
                month: m.month,
                value: m.revenueMinor,
                tooltip:
                  `${monthLabel(m.month)}: ${money(m.revenueMinor)} from ${m.bookings} ` +
                  `appointment${m.bookings === 1 ? "" : "s"}` +
                  (m.unpriced > 0 ? ` (plus ${m.unpriced} priced on request)` : ""),
              }))}
              format={(v) => formatMoneyCompact(v, cur)}
              summary="Revenue by month"
              caption="Revenue by month."
            >
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-rule">
                    <th className="th">Month</th>
                    <th className="th text-right">Revenue</th>
                    <th className="th text-right">Appointments</th>
                    <th className="th text-right">On request</th>
                  </tr>
                </thead>
                <tbody>
                  {[...perf.trend].reverse().map((m) => (
                    <tr key={m.month} className="border-b border-rule/60">
                      <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                      <td className="num px-3 py-1.5 text-right">{money(m.revenueMinor)}</td>
                      <td className="num px-3 py-1.5 text-right">{m.bookings}</td>
                      <td className="num px-3 py-1.5 text-right">{m.unpriced || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </MonthlyBars>

            {perf.tax && (
              <p className="text-[11px] text-ink-3">
                {perf.tax.inclusive
                  ? `Figures include ${perf.tax.label} at ${perf.tax.rate}%.`
                  : `Figures are before ${perf.tax.label} at ${perf.tax.rate}%.`}
              </p>
            )}
            {perf.window.unpriced > 0 && (
              <p className="text-[11px] text-ink-3">
                {perf.window.unpriced} completed appointment
                {perf.window.unpriced === 1 ? " is" : "s are"} not counted above, because the
                service is priced on request. The work was done; we cannot state what it earned.
              </p>
            )}
          </Section>

          {/* ── Still to come ──────────────────────────────────────── */}
          <Section title="Already booked">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="Appointments ahead"
                value={String(perf.pipeline.count)}
                note="scheduled or confirmed, not yet happened"
              />
              <Metric label="Worth" value={money(perf.pipeline.valueMinor)} />
              <Metric
                label="Turned up"
                value={perf.completionRate === null ? "—" : `${perf.completionRate}%`}
                note="of appointments that have ended"
                tone={
                  perf.completionRate === null
                    ? undefined
                    : perf.completionRate >= 85
                      ? "ok"
                      : "warn"
                }
              />
            </div>
            <p className="text-[11px] text-ink-3">
              Deliberately kept out of revenue above: an appointment earns nothing until it
              happens, and a figure that counts it can fall without anyone doing anything wrong.
            </p>
          </Section>

          {/* ── Where the work comes from ──────────────────────────── */}
          <Section title="Where the bookings came from">
            <Ranked rows={perf.bySource} currency={cur} />
            <p className="text-[11px] text-ink-3">
              What your assistant booked, against what your staff entered by hand.
            </p>
          </Section>

          <Section title="Busiest services">
            <Ranked rows={perf.byService} currency={cur} limit={8} />
          </Section>

          {perf.byLocation.length > 1 && (
            <Section title="By location">
              <Ranked rows={perf.byLocation} currency={cur} />
            </Section>
          )}

          {/* ── What went wrong ───────────────────────────────────── */}
          <Section title="Cancellations and no-shows">
            <div className="grid gap-3 sm:grid-cols-3">
              {perf.outcomes.map((o) => (
                <Metric
                  key={o.status}
                  label={outcomeLabel(o.status)}
                  value={String(o.count)}
                  note={o.valueMinor > 0 ? money(o.valueMinor) : undefined}
                  tone={o.status === "completed" ? "ok" : o.count > 0 ? "warn" : undefined}
                />
              ))}
            </div>
            <p className="text-[11px] text-ink-3">
              The value beside a cancellation is what the slot would have earned, not money lost —
              the time may well have been resold.
            </p>
          </Section>

          <Section title="Customers">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="Served this year"
                value={String(perf.customers.served)}
                note="different people with completed work"
              />
              <Metric label="Came back" value={String(perf.customers.repeat)} note="more than once, ever" />
              <Metric
                label="Repeat rate"
                value={
                  perf.customers.repeatRatePct === null ? "—" : `${perf.customers.repeatRatePct}%`
                }
                note="of everyone you have ever served"
              />
            </div>
          </Section>
        </>
      )}

      {/* ── The assistant ─────────────────────────────────────────── */}
      <AssistantSection usage={assistant} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  The chart
// ══════════════════════════════════════════════════════════════════════

const CHART_W = 728;
const PLOT_H = 132;
const LABEL_H = 22;
const SLOT = CHART_W / 13;
const BAR_W = 30;

type Bar = {
  month: string;
  value: number;
  /** The sentence a hover shows, and the bar's accessible name. */
  tooltip: string;
};

/**
 * Thirteen months of one measure, as bars.
 *
 * One series, so there is no legend and no palette to validate — the section
 * heading carries identity, magnitude is the only thing encoded, and a single
 * accent token carries it in both themes because the token itself swaps.
 *
 * Inline SVG with no client JavaScript: this is a server component and a bar
 * chart needs no runtime. Every bar carries a `<title>`, which is both a native
 * hover tooltip and an accessible name, and the same figures appear as text in
 * the table beneath — so nothing here is conveyed by the picture alone.
 */
function MonthlyBars({
  bars,
  format,
  caption,
  summary,
  children,
}: {
  bars: Bar[];
  /** For the two selective value labels. Compact, because space is 30px wide. */
  format: (value: number) => string;
  caption: string;
  /** Opening words of the aria-label, e.g. "Revenue by month". */
  summary: string;
  /** The table view. Required, not decorative. */
  children: React.ReactNode;
}) {
  const peak = Math.max(...bars.map((b) => b.value));
  if (peak === 0) return null;

  // The LAST month matching the peak, not the first: when two months tie, the
  // recent one is the useful one to point at — "your best month" reading as a
  // year ago when you matched it last month is just wrong.
  const peakIndex = bars.reduce((best, b, i) => (b.value === peak ? i : best), 0);
  const lastIndex = bars.length - 1;

  return (
    <figure className="flex flex-col gap-2">
      {/* Scrolls rather than squashing: thirteen labelled months do not fit a
          phone, and a chart whose labels collide is worse than one you scroll. */}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${CHART_W} ${PLOT_H + LABEL_H}`}
          className="h-[160px] w-full min-w-[42rem]"
          role="img"
          aria-label={`${summary} for the last ${bars.length} months. Highest was ${format(peak)} in ${monthLabel(bars[peakIndex].month)}.`}
        >
          {/* Baseline only. A grid behind thirteen bars earns nothing. */}
          <line x1="0" y1={PLOT_H} x2={CHART_W} y2={PLOT_H} stroke="var(--rule)" strokeWidth="1" />

          {bars.map((b, i) => {
            const h = Math.round((b.value / peak) * (PLOT_H - 14));
            const x = i * SLOT + (SLOT - BAR_W) / 2;
            const y = PLOT_H - h;
            const isLast = i === lastIndex;

            return (
              <g key={b.month}>
                {h > 0 && (
                  <path
                    d={roundedTopBar(x, y, BAR_W, h)}
                    // The current month is still filling up, so it is drawn
                    // lighter — otherwise a month three days old reads as a
                    // collapse in trade.
                    fill={isLast ? "var(--accent-light)" : "var(--accent)"}
                  >
                    <title>{b.tooltip}</title>
                  </path>
                )}

                {/* Labelled selectively: the peak and the current month. A number
                    over every bar is noise at this density. */}
                {(i === peakIndex || isLast) && h > 0 && (
                  <text
                    x={x + BAR_W / 2}
                    y={y - 5}
                    textAnchor="middle"
                    className="num"
                    fontSize="10"
                    fill="var(--ink-muted)"
                  >
                    {format(b.value)}
                  </text>
                )}

                <text
                  x={x + BAR_W / 2}
                  y={PLOT_H + 14}
                  textAnchor="middle"
                  fontSize="9.5"
                  fill="var(--ink-muted)"
                >
                  {shortMonth(b.month)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="text-[11px] text-ink-3">
        {caption} The lighter bar is the month in progress.
      </figcaption>

      <details className="text-[11px] text-ink-3">
        <summary className="cursor-pointer">See the figures</summary>
        <div className="mt-2 overflow-x-auto">{children}</div>
      </details>
    </figure>
  );
}

/**
 * A bar with its top corners rounded and its base square on the axis.
 *
 * `rx` on a rect rounds all four corners, which lifts the bar off its own
 * baseline and makes short bars look like floating pills. The radius is also
 * clamped to the bar's height so a two-pixel month does not curl into itself.
 */
function roundedTopBar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return [
    `M${x},${y + h}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

// ══════════════════════════════════════════════════════════════════════
//  Pieces
// ══════════════════════════════════════════════════════════════════════

function Ranked({
  rows,
  currency,
  limit,
}: {
  rows: Breakdown[];
  currency: string;
  limit?: number;
}) {
  if (rows.length === 0) return <Empty>Nothing completed yet.</Empty>;

  const shown = limit ? rows.slice(0, limit) : rows;
  const top = Math.max(...shown.map((r) => r.revenueMinor), 1);

  return (
    <ul className="flex flex-col gap-1.5">
      {shown.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-ink">{r.label}</span>
            <span className="num shrink-0 text-xs text-ink-2">
              {formatMoney(r.revenueMinor, currency)}
              <span className="text-ink-3">
                {" · "}
                {r.count} appointment{r.count === 1 ? "" : "s"}
                {r.unpriced > 0 ? `, ${r.unpriced} on request` : ""}
              </span>
            </span>
          </div>
          {/* A proportion bar rather than a second chart. Same encoding as the
              figure beside it, so it can be ignored without losing anything. */}
          <div className="h-1 overflow-hidden rounded-full bg-rule">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max((r.revenueMinor / top) * 100, r.revenueMinor > 0 ? 2 : 0)}%` }}
            />
          </div>
        </li>
      ))}
      {limit && rows.length > limit && (
        <li className="text-[11px] text-ink-3">and {rows.length - limit} more</li>
      )}
    </ul>
  );
}

function Metric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-lg border border-rule bg-surface p-4">
      <p className="eyebrow">{label}</p>
      <p className="num mt-2 text-[22px] font-semibold text-ink">{value}</p>
      {note && (
        <p
          className={`mt-1 text-[11px] ${tone === "ok" ? "txt-good" : tone === "warn" ? "txt-warn" : "text-ink-3"}`}
        >
          {note}
        </p>
      )}
    </div>
  );
}

function outcomeLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "no_show":
      return "Didn't turn up";
    default:
      return status;
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function shortMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  // The year is shown only where it changes, so a thirteen-month axis does not
  // repeat "2026" thirteen times.
  return m === 1 ? `Jan ${String(y).slice(2)}` : MONTHS[m - 1].slice(0, 3);
}

// ══════════════════════════════════════════════════════════════════════
//  The assistant
// ══════════════════════════════════════════════════════════════════════

/**
 * How much the assistant handled, and — only when it is their own money — what
 * that came to.
 *
 * Rendered outside the revenue block on purpose: a business that has not yet
 * completed a booking may still be answering conversations every day, and
 * hiding this behind "no revenue yet" would tell them the assistant was idle.
 */
function AssistantSection({ usage }: { usage: AssistantUsage }) {
  const hasAny = usage.totals.conversations > 0 || usage.trend.some((m) => m.tokens > 0);

  return (
    <Section title="Your assistant">
      {!hasAny ? (
        <Empty>
          No conversations yet. Once customers start messaging, what the assistant handled —
          and on {usage.keyLabel}, what it cost — appears here.
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Conversations this month"
              value={String(usage.thisMonth.conversations)}
              note={
                usage.monthChangePct === null
                  ? "nothing last month to compare"
                  : `${usage.monthChangePct >= 0 ? "up" : "down"} ${Math.abs(usage.monthChangePct)}% on last month`
              }
            />
            <Metric
              label="Last month"
              value={String(usage.lastMonth.conversations)}
              note={`${formatTokens(usage.lastMonth.tokens)} tokens`}
            />
            {usage.onOwnKey ? (
              <Metric
                label="Cost this month"
                value={
                  usage.thisMonth.costMicros === null
                    ? "not priced"
                    : formatUsd(usage.thisMonth.costMicros)
                }
                note={
                  usage.thisMonth.costMicros === null
                    ? "no published rate for your model"
                    : "estimated at list price"
                }
              />
            ) : (
              <Metric
                label="Model cost"
                // Deliberately not a number. What their traffic costs us is our
                // side of the arrangement, not a line on their dashboard.
                value="on enori's key"
                note="nothing for you to pay"
              />
            )}
            <Metric
              label="Handed to a person"
              value={String(usage.totals.handedOver)}
              note="threads a colleague took over"
              tone={usage.totals.handedOver > 0 ? "warn" : undefined}
            />
          </div>

          <MonthlyBars
            bars={usage.trend.map((m) => ({
              month: m.month,
              value: m.conversations,
              tooltip:
                `${monthLabel(m.month)}: ${m.conversations} conversation${m.conversations === 1 ? "" : "s"}` +
                (m.tokens > 0 ? `, ${formatTokens(m.tokens)} tokens` : "") +
                (usage.onOwnKey && m.costMicros ? `, about ${formatUsd(m.costMicros)}` : ""),
            }))}
            format={(v) => String(v)}
            summary="Conversations by month"
            caption="Conversations by month."
          >
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  <th className="th">Month</th>
                  <th className="th text-right">Conversations</th>
                  <th className="th text-right">Tokens</th>
                  {usage.onOwnKey && <th className="th text-right">Est. cost</th>}
                </tr>
              </thead>
              <tbody>
                {[...usage.trend].reverse().map((m) => (
                  <tr key={m.month} className="border-b border-rule/60">
                    <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                    <td className="num px-3 py-1.5 text-right">{m.conversations || "—"}</td>
                    <td className="num px-3 py-1.5 text-right">
                      {m.tokens > 0 ? formatTokens(m.tokens) : "—"}
                    </td>
                    {usage.onOwnKey && (
                      <td className="num px-3 py-1.5 text-right">
                        {m.costMicros ? formatUsd(m.costMicros) : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </MonthlyBars>

          {/* ── Year on year ──────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <p className="eyebrow">Year on year</p>
            {usage.years.length < 2 ? (
              <p className="text-sm text-ink-2">
                Only {usage.years.map((y) => y.year).join(" ") || "this year"} to go on so far.
                A year-on-year comparison needs two.
              </p>
            ) : (
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-rule">
                    <th className="th">Year</th>
                    <th className="th text-right">Conversations</th>
                    <th className="th text-right">Tokens</th>
                    {usage.onOwnKey && <th className="th text-right">Est. cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {[...usage.years].reverse().map((y) => (
                    <tr key={y.year} className="border-b border-rule/60">
                      <td className="px-3 py-2">
                        {y.year}
                        {!y.complete && (
                          <span className="ml-2 text-[11px] text-ink-3">
                            so far — not a full year
                          </span>
                        )}
                      </td>
                      <td className="num px-3 py-2 text-right">{y.conversations}</td>
                      <td className="num px-3 py-2 text-right">
                        {y.tokens > 0 ? formatTokens(y.tokens) : "—"}
                      </td>
                      {usage.onOwnKey && (
                        <td className="num px-3 py-2 text-right">
                          {y.costMicros ? formatUsd(y.costMicros) : "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {usage.yearChangePct !== null ? (
              <p className={`text-[11px] ${usage.yearChangePct >= 0 ? "txt-good" : "txt-warn"}`}>
                {usage.yearChangePct >= 0 ? "Up" : "Down"} {Math.abs(usage.yearChangePct)}% year to
                date: {usage.ytd.thisYear} conversations so far against {usage.ytd.lastYear} by the
                same date last year. Compared to the same point in the year, not to all of it — and
                counted in conversations, so changing model or rate card cannot move it.
              </p>
            ) : (
              <p className="text-[11px] text-ink-3">
                Nothing by this date last year to compare against.
              </p>
            )}
          </div>

          {/* ── The caveats, stated rather than buried ────────────── */}
          <div className="flex flex-col gap-1 text-[11px] text-ink-3">
            <p>
              {usage.totals.inbound} message{usage.totals.inbound === 1 ? "" : "s"} in,{" "}
              {usage.totals.outbound} out. Answered on {usage.keyLabel}.
            </p>
            {usage.onOwnKey && (
              <p>
                Costs are an estimate at published list prices, not your invoice. If you
                negotiated a rate, or your provider prices differently, the real figure will
                differ.
              </p>
            )}
            {usage.unpricedTokens > 0 && (
              <p>
                {formatTokens(usage.unpricedTokens)} tokens ran on a model we have no published
                price for, so they are counted but not costed.
              </p>
            )}
            {usage.ledgerStartsAt && (
              <p>
                Token and cost figures begin {usage.ledgerStartsAt.toISOString().slice(0, 10)},
                when this started being recorded. Conversations before that are counted; their
                tokens are not.
              </p>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
