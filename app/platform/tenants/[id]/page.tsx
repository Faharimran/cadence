import { notFound } from "next/navigation";
import { requireOperator } from "@/lib/platform/guard";
import { loadTenantDetail } from "@/lib/platform/metrics";
import { setTenantStatus } from "../../actions";
import { BackLink, Button, Empty, PageHeader, Pill, Row, Section } from "../../../admin/ui";
import { formatTokens, formatUsd } from "@/lib/conversation/pricing";

export const dynamic = "force-dynamic";

/**
 * One business, in the detail an operator needs to help them.
 *
 * Note what is absent and stays absent: no customer list, no conversation
 * transcripts, no channel secrets. If a business asks for help with a specific
 * thread, the answer is to ask them to look at it — not to read it over their
 * shoulder from here.
 */
export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const operator = await requireOperator();
  const { id } = await params;

  const detail = await loadTenantDetail(id);
  if (!detail) notFound();

  const { tenant, setup, ready, volume, knowledge, sources, channel, endpoints, capabilities, users, apiKeys, recentAudit, failedDeliveries, key, spend } =
    detail;

  const bookingsByStatus = volume.bookings30d
    .map((b) => `${b._count._all} ${b.status}`)
    .join(" · ");

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <BackLink href="/platform">every business</BackLink>
        <PageHeader
          title={tenant.name}
          lede={`${tenant.slug} · ${tenant.timezone} · ${tenant.currency}${tenant.vertical ? ` · started from the ${tenant.vertical} preset` : ""}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          {tenant.status === "active" ? <Pill tone="ok">active</Pill> : <Pill tone="bad">{tenant.status}</Pill>}
          {ready ? <Pill tone="ok">can take bookings</Pill> : <Pill tone="bad">set-up unfinished</Pill>}
          <span className="num text-[11px] text-ink-3">
            joined {tenant.createdAt.toISOString().slice(0, 10)}
          </span>
        </div>
      </div>

      {/* ── Volume ─────────────────────────────────────────────────── */}
      <Section title="Last thirty days">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Conversations" value={volume.conversations30d} />
          <Metric
            label="Handed to a person"
            value={volume.escalated30d}
            note={
              volume.conversations30d > 0
                ? `${Math.round((volume.escalated30d / volume.conversations30d) * 100)}% of threads`
                : undefined
            }
          />
          <Metric label="Messages in" value={volume.inbound30d} />
          <Metric label="Messages out" value={volume.outbound30d} />
        </div>
        <p className="text-sm text-ink-2">
          Bookings: {bookingsByStatus || <span className="text-ink-3">none in this period</span>}
        </p>
      </Section>

      {/* ── Set-up ─────────────────────────────────────────────────── */}
      <Section title="Set-up">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Locations" value={setup.locations} />
          <Metric label="People & rooms" value={setup.resources} />
          <Metric label="Services" value={setup.services} />
          <Metric label="Opening-hours rules" value={setup.rules} />
        </div>
        {!ready && (
          <p className="txt-bad text-sm">
            Without a location, a service and opening hours there is no time to offer, so the
            assistant cannot book anything.
          </p>
        )}
      </Section>

      {/* ── What they'll let it say ────────────────────────────────── */}
      <Section title="What the assistant may say">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Approved" value={knowledge.approved} note="live to customers" />
          <Metric label="Drafts" value={knowledge.draft} note="invisible until approved" />
          <Metric label="Retired" value={knowledge.archived} />
        </div>
        {knowledge.approved === 0 && (
          <p className="txt-warn text-sm">
            Nothing approved, so every question about how anything works goes to a colleague.
          </p>
        )}
        {sources.length > 0 && (
          <ul className="mt-2 flex flex-col gap-2">
            {sources.map((s) => (
              <Row key={s.id}>
                <span className="font-mono text-sm">{s.filename}</span>
                {s.status === "failed" ? (
                  <Pill tone="bad">unreadable</Pill>
                ) : s.status === "review" ? (
                  <Pill tone="warn">{s.chunkCount} awaiting review</Pill>
                ) : (
                  <Pill tone="ok">{s.status}</Pill>
                )}
                <span className="num ml-auto text-[11px] text-ink-3">
                  {s.createdAt.toISOString().slice(0, 10)}
                </span>
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Whose key, and what it spent ───────────────────────────── */}
      <Section title="Model">
        <ul className="flex flex-col gap-2">
          <Row>
            <span className="num text-sm font-semibold">Answering on</span>
            <span className="text-sm text-ink-2">{key.label}</span>
            {key.source === "tenant" ? (
              key.lastFailureAt ? (
                <Pill tone="bad">failing</Pill>
              ) : (
                <Pill tone="ok">working</Pill>
              )
            ) : key.savedButInactive ? (
              <Pill tone="warn">theirs saved, switched off</Pill>
            ) : null}
            {key.model && <span className="num ml-auto text-[11px] text-ink-3">{key.model}</span>}
          </Row>

          {key.source === "tenant" && (
            <Row>
              <span className="num text-sm font-semibold">Last seen</span>
              <span className="text-xs text-ink-2">
                {key.lastOkAt
                  ? `worked ${key.lastOkAt.toISOString().slice(0, 16).replace("T", " ")}`
                  : "never yet seen to work"}
              </span>
              {key.lastFailureNote && (
                <span className="text-xs text-bad">{key.lastFailureNote}</span>
              )}
            </Row>
          )}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Tokens · 30 days" value={formatTokens(spend.total30d.total)} />
          <Metric
            label="Cost · 30 days"
            value={
              key.source === "tenant" ? "billed to them" : formatUsd(spend.total30d.costMicros)
            }
            note={key.source === "tenant" ? "their key, their rate card" : undefined}
          />
          <Metric
            label="Cached"
            value={
              spend.total30d.total > 0
                ? `${Math.round((spend.total30d.cacheRead / spend.total30d.total) * 100)}%`
                : "—"
            }
            note="of tokens, at a tenth of the price"
          />
          <Metric
            label="Cost · all time"
            value={
              // Ours only, and it stays ours even if they switch to their own
              // key tomorrow: the rows already written were our bill.
              spend.lifetimeCostMicros > 0 ? formatUsd(spend.lifetimeCostMicros) : "—"
            }
            note={
              spend.firstRecordedAt
                ? `since ${spend.firstRecordedAt.toISOString().slice(0, 10)}`
                : "nothing recorded yet"
            }
          />
        </div>

        {spend.byModel.length === 0 ? (
          <Empty>No model call recorded in the last thirty days.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {spend.byModel.map((m) => (
              <Row key={`${m.source}:${m.model}`}>
                <span className="num text-sm font-semibold">{m.model}</span>
                <span className="text-[11px] text-ink-3">
                  {m.source === "platform" ? "our key" : "their key"}
                </span>
                <span className="num ml-auto text-xs text-ink-2">
                  {formatTokens(m.totals.total)} tokens
                  {m.source === "platform" && m.totals.costMicros > 0 && (
                    <> · {formatUsd(m.totals.costMicros)}</>
                  )}
                </span>
              </Row>
            ))}
          </ul>
        )}

        <p className="text-[11px] text-ink-3">
          {spend.byKind
            .filter((k) => k.totals.total > 0)
            .map((k) => `${formatTokens(k.totals.total)} on ${k.kind}`)
            .join(" · ") || "Nothing spent yet."}
          {" — ingestion always runs on enori's key, whatever they answer customers on."}
        </p>

        <p className="text-[11px] text-ink-3">
          The credential itself is never loaded here, not even to show its last four
          characters. Whether it works is the only part of it an operator can act on.
        </p>
      </Section>

      {/* ── Plumbing ───────────────────────────────────────────────── */}
      <Section title="Connections">
        <ul className="flex flex-col gap-2">
          <Row>
            <span className="num text-sm font-semibold">WhatsApp</span>
            {channel ? (
              <>
                {channel.active && channel.hasToken ? (
                  <Pill tone="ok">connected</Pill>
                ) : (
                  <Pill tone="warn">incomplete</Pill>
                )}
                <span className="num text-xs text-ink-2">
                  {channel.displayNumber ?? "number not set"}
                </span>
              </>
            ) : (
              <span className="text-sm text-ink-3">not connected</span>
            )}
          </Row>

          {endpoints.map((e) => (
            <Row key={e.id}>
              <span className="num text-sm font-semibold">Webhook</span>
              <span className="num text-xs text-ink-2">{e.host}</span>
              {e.active ? <Pill tone="ok">on</Pill> : <Pill tone="bad">switched off</Pill>}
              {e.disabledReason && (
                <span className="text-xs text-ink-2">{e.disabledReason}</span>
              )}
              <span className="num ml-auto text-[11px] text-ink-3">
                {e.events.length} event{e.events.length === 1 ? "" : "s"}
              </span>
            </Row>
          ))}

          <Row>
            <span className="num text-sm font-semibold">API keys</span>
            <span className="num text-xs text-ink-2">{apiKeys} live</span>
            <span className="num ml-auto text-[11px] text-ink-3">
              {failedDeliveries} failed deliveries all-time
            </span>
          </Row>
        </ul>

        <p className="text-[11px] text-ink-3">
          Hostnames only, and never a token or secret — a webhook path routinely carries one.
        </p>
      </Section>

      {/* ── Capabilities ───────────────────────────────────────────── */}
      <Section title="Capabilities">
        <div className="flex flex-wrap gap-2">
          {capabilities.map((c) => (
            <span
              key={c.capability}
              className="chip"
            >
              {c.capability}
              <span className="text-ink-3">
                {" "}
                · {c.mode}
                {c.connector ? ` (${c.connector})` : ""}
              </span>
            </span>
          ))}
        </div>
      </Section>

      {/* ── Who to contact ─────────────────────────────────────────── */}
      <Section title="Who can sign in">
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <Row key={u.email}>
              <span className="font-mono text-sm">{u.email}</span>
              <Pill>{u.role}</Pill>
              {!u.active && <Pill tone="bad">disabled</Pill>}
              <span className="num ml-auto text-[11px] text-ink-3">
                {u.lastLoginAt ? `last in ${u.lastLoginAt.toISOString().slice(0, 10)}` : "never signed in"}
              </span>
            </Row>
          ))}
        </ul>
      </Section>

      {/* ── Their audit trail ──────────────────────────────────────── */}
      <Section title="Recent activity on their account">
        {recentAudit.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentAudit.map((a) => (
              <Row key={a.id}>
                <span className="font-mono text-xs">{a.action}</span>
                <span className="num text-[11px] text-ink-3">{a.actor}</span>
                <span className="num ml-auto text-[11px] text-ink-3">
                  {a.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {/* ── The one write ──────────────────────────────────────────── */}
      <Section title="Suspend" boxed>
        <p className="mb-4 max-w-[66ch] text-sm text-ink-2">
          A suspended business stops answering customers entirely — inbound messages are accepted
          and recorded, but nothing is replied to and nothing is booked. It is recorded on
          <em> their</em> audit trail, with your name on it, so they can see what happened.
        </p>
        {operator.role === "admin" ? (
          <form action={setTenantStatus}>
            <input type="hidden" name="tenantId" value={tenant.id} />
            <input
              type="hidden"
              name="status"
              value={tenant.status === "active" ? "suspended" : "active"}
            />
            <Button type="submit">
              {tenant.status === "active" ? `Suspend ${tenant.name}` : `Reactivate ${tenant.name}`}
            </Button>
          </form>
        ) : (
          <Empty>Only a platform admin can suspend a business.</Empty>
        )}
      </Section>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-surface p-4">
      <p className="eyebrow">{label}</p>
      <p className="num mt-2 text-[22px] font-semibold">{value}</p>
      {note && <p className="mt-1 text-[11px] text-ink-3">{note}</p>}
    </div>
  );
}
