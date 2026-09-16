import Link from "next/link";
import { requireOperator } from "@/lib/platform/guard";
import { loadOverview } from "@/lib/platform/metrics";
import { Empty, PageHeader, Pill, Row, Section } from "../admin/ui";

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
  const { tenants, totals, attention } = await loadOverview();

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

      {/* ── The roster ─────────────────────────────────────────────── */}
      <Section title="Businesses">
        {tenants.length === 0 ? (
          <Empty>Nobody has signed up yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule text-left">
                  {["Business", "Trade", "Set up", "WhatsApp", "Articles", "Convos", "Bookings", "Joined"].map(
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
