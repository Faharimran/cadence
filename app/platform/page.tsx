import Link from "next/link";
import { requireOperator } from "@/lib/platform/guard";
import { loadOverview } from "@/lib/platform/metrics";
import { Empty, PageHeader, Pill, Row, Section } from "../admin/ui";
import { formatTokens, formatUsd } from "@/lib/conversation/pricing";

export const dynamic = "force-dynamic";

/**
 * What is happening across every business on cadence.
 *
 * Ordered by what a person can act on: the things that are wrong, then the
 * volume that says whether anything is happening at all, then the roster. A
 * console that leads with a chart of totals looks impressive and tells nobody
 * what to do next.
 */
export default async function PlatformOverview() {
  await requireOperator();
  const { tenants, totals, attention, spend30d } = await loadOverview();

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Every business"
        lede="Counts and health only. This console deliberately cannot show you a customer's name, number or messages — running the platform doesn't require reading anyone's conversations."
      />

      {/* ── Needs looking at ───────────────────────────────────────── */}
      <Section title={attention.length > 0 ? `Needs looking at (${attention.length})` : "Nothing needs looking at"}>
        {attention.length === 0 ? (
          <Empty>Every active business can take a booking, and no delivery is failing.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {attention.map((item, i) => (
              <Row key={`${item.tenantId}-${i}`}>
                <Pill tone={item.severity}>{item.severity === "bad" ? "blocked" : "check"}</Pill>
                {item.tenantId ? (
                  <Link
                    href={`/platform/tenants/${item.tenantId}`}
                    className="text-sm font-semibold text-accent underline underline-offset-2"
                  >
                    {item.tenantName}
                  </Link>
                ) : (
                  <span className="num text-sm font-semibold">{item.tenantName ?? "—"}</span>
                )}
                <span className="text-sm text-ink-2">{item.what}</span>
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Last seven days ────────────────────────────────────────── */}
      <Section title="Last seven days">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Businesses" value={totals.tenants} note={`${totals.active} active`} />
          <Metric label="Conversations" value={totals.conversations7d} />
          <Metric label="Bookings" value={totals.bookings7d} />
          <Metric label="Handed to a person" value={totals.escalations7d} />
          <Metric
            label="Escalation rate"
            value={`${totals.escalationRate7d}%`}
            // Not colour-coded. A clinic that hands over anything clinical is
            // supposed to escalate often; a barber is not. One threshold across
            // every vertical would be a made-up number.
            note="varies by trade"
          />
        </div>
      </Section>

      {/* ── What the models cost ───────────────────────────────────── */}
      <Section title="Model spend · last thirty days">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Our bill"
            value={formatUsd(spend30d.platform.costMicros)}
            note={`${formatTokens(spend30d.platform.total)} tokens on enori's key`}
          />
          <Metric
            label="On their own keys"
            value={formatTokens(spend30d.tenant.total)}
            // Never a dollar figure. We do not pay for these and have never seen
            // the rate card they are billed at — printing one would be fiction.
            note={
              spend30d.onOwnKey === 1
                ? "1 business, billed to them"
                : `${spend30d.onOwnKey} businesses, billed to them`
            }
          />
          <Metric
            label="Cache reads"
            value={formatTokens(spend30d.all.cacheRead)}
            // The lever, stated as a share. A prompt that stops being cached
            // does not look like an error anywhere else — it looks like a bill.
            note={
              spend30d.all.total > 0
                ? `${Math.round((spend30d.all.cacheRead / spend30d.all.total) * 100)}% of all tokens, at a tenth of the price`
                : "nothing cached yet"
            }
          />
          <Metric
            label="Model calls"
            value={spend30d.all.roundTrips}
            note="each one re-sends the whole prompt"
          />
        </div>

        {spend30d.partialWindow && (
          <p className="text-[11px] text-ink-3">
            The ledger starts when this was deployed, so anything before that is
            missing rather than zero.
          </p>
        )}
        {spend30d.platform.unpricedTokens > 0 && (
          <p className="text-[11px] text-warn">
            {formatTokens(spend30d.platform.unpricedTokens)} tokens ran on our key against a
            model with no entry in <span className="font-mono">lib/conversation/pricing.ts</span>,
            so they are counted but not costed. The bill above is short by whatever they came to.
          </p>
        )}
      </Section>

      {/* ── The roster ─────────────────────────────────────────────── */}
      <Section title="Businesses">
        {tenants.length === 0 ? (
          <Empty>Nobody has signed up yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[72rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule text-left">
                  {[
                    "Business",
                    "Trade",
                    "Set up",
                    "WhatsApp",
                    "Whose key",
                    "Articles",
                    "Convos",
                    "Bookings",
                    "Tokens 30d",
                    "Cost 30d",
                    "Joined",
                  ].map(
                    (h) => (
                      <th
                        key={h}
                        className="th whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b border-rule/60">
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/platform/tenants/${t.id}`}
                        className="font-medium text-accent underline underline-offset-2"
                      >
                        {t.name}
                      </Link>
                      {t.status !== "active" && (
                        <span className="ml-2">
                          <Pill tone="bad">{t.status}</Pill>
                        </span>
                      )}
                      <span className="block font-mono text-[11px] text-ink-3">
                        {t.slug} · {t.timezone} · {t.currency}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{t.vertical ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {t.ready ? <Pill tone="ok">ready</Pill> : <Pill tone="bad">unfinished</Pill>}
                    </td>
                    <td className="px-3 py-2.5">
                      {t.whatsappConnected ? (
                        <Pill tone="ok">connected</Pill>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {t.key.source === "tenant" ? (
                        t.key.lastFailureAt ? (
                          <Pill tone="bad">their key failing</Pill>
                        ) : (
                          <Pill tone="ok">own key</Pill>
                        )
                      ) : (
                        <span className="text-[11px] text-ink-3">
                          ours{t.key.savedButInactive && " (theirs saved, off)"}
                        </span>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-right">
                      {t.approvedArticles || <span className="text-ink-3">0</span>}
                    </td>
                    <td className="num px-3 py-2.5 text-right">
                      {t.conversations7d}
                      {t.escalations7d > 0 && (
                        <span className="text-ink-3"> ({t.escalations7d} handed over)</span>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-right">{t.bookings7d}</td>
                    <td className="num px-3 py-2.5 text-right">
                      {t.usage30d.total > 0 ? (
                        formatTokens(t.usage30d.total)
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-right">
                      {t.key.source === "tenant" ? (
                        // Their key, their bill. An em dash rather than $0.00,
                        // which would read as a business that costs nothing.
                        <span className="text-ink-3" title="billed to them, not to us">
                          theirs
                        </span>
                      ) : t.usage30d.costMicros > 0 ? (
                        formatUsd(t.usage30d.costMicros)
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="num whitespace-nowrap px-3 py-2.5 text-[11px] text-ink-3">
                      {t.createdAt.toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-rule bg-surface p-4">
      <p className="eyebrow">{label}</p>
      <p className="num mt-2 text-[22px] font-semibold">{value}</p>
      {note && <p className="mt-1 text-[11px] text-ink-3">{note}</p>}
    </div>
  );
}
