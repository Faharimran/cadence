import { requireUser, asTenant, can } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { EVENTS } from "@/lib/events";
import { env } from "@/lib/env";
import { revokeKey, toggleEndpoint, sendTestEvent, setCapability } from "./actions";
import { ApiKeyForm, EndpointForm } from "./forms";
import { Button, Empty, PageHeader, Pill, Row, Section, inputClass } from "../ui";

export const dynamic = "force-dynamic";

const CAPABILITIES = [
  ["customers", "Who your customers are"],
  ["catalog", "What you sell"],
  ["availability", "When you are free"],
  ["booking_read", "Reading bookings"],
  ["booking_write", "Making bookings"],
  ["promotions", "Offers"],
] as const;

export default async function IntegrationPage() {
  const user = await requireUser();
  const isOwner = can(user, "owner");

  const { keys, endpoints, deliveries, capabilities } = await asTenant(user, async (db) => {
    const [keys, endpoints, deliveries, capabilities] = await Promise.all([
      db.apiKey.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: "desc" } }),
      db.webhookEndpoint.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { createdAt: "desc" },
      }),
      db.webhookDelivery.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      db.tenantCapability.findMany({ where: { tenantId: user.tenantId } }),
    ]);
    return { keys, endpoints, deliveries, capabilities };
  });

  const modeOf = (c: string) => capabilities.find((x) => x.capability === c);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Integration"
        lede="Connect the system you already run. Read availability and make bookings over the API; hear about everything that happens through webhooks."
      />

      {!isOwner && <Empty>Only the owner can change these.</Empty>}

      {/* ── API keys ──────────────────────────────────────────────── */}
      {isOwner && (
        <Section title="API keys" boxed>
          <ApiKeyForm />
        </Section>
      )}

      <Section title="Keys in use">
        {keys.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((k) => (
              <Row key={k.id}>
                <span className="font-mono text-sm font-semibold">{k.name}</span>
                <code className="font-mono text-xs text-ink-2">{k.prefix}.•••</code>
                <span className="font-mono text-[11px] text-ink-3">{k.scopes.join(", ")}</span>
                <span className="font-mono text-[11px] text-ink-3">
                  {k.lastUsedAt
                    ? `last used ${describeInstant(k.lastUsedAt, user.tenantTimezone)}`
                    : "never used"}
                </span>
                {k.revokedAt && <Pill tone="bad">revoked</Pill>}
                {isOwner && !k.revokedAt && (
                  <form action={revokeKey} className="ml-auto">
                    <input type="hidden" name="id" value={k.id} />
                    <Button type="submit" variant="quiet">
                      revoke
                    </Button>
                  </form>
                )}
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Webhooks ──────────────────────────────────────────────── */}
      {isOwner && (
        <Section title="Webhooks" boxed>
          <EndpointForm events={EVENTS} />
        </Section>
      )}

      <Section title="Where we send events">
        {endpoints.length === 0 ? (
          <Empty>
            None. Without one, your system never learns that the assistant booked someone — a
            colleague would see a lead with no appointment against it.
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {endpoints.map((e) => (
              <Row key={e.id}>
                <code className="font-mono text-xs">{e.url}</code>
                <span className="font-mono text-[11px] text-ink-3">
                  {e.events.length === 0 ? "all events" : e.events.join(", ")}
                </span>
                {!e.active && <Pill tone="bad">off</Pill>}
                {e.disabledReason && (
                  <span className="max-w-[46ch] text-[11px]" style={{ color: "var(--bad)" }}>
                    {e.disabledReason}
                  </span>
                )}
                {isOwner && (
                  <div className="ml-auto flex gap-4">
                    <form action={sendTestEvent}>
                      <input type="hidden" name="id" value={e.id} />
                      <Button type="submit" variant="quiet">
                        send a test
                      </Button>
                    </form>
                    <form action={toggleEndpoint}>
                      <input type="hidden" name="id" value={e.id} />
                      <Button type="submit" variant="quiet">
                        {e.active ? "disable" : "enable"}
                      </Button>
                    </form>
                  </div>
                )}
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {deliveries.length > 0 && (
        <Section title="Recent deliveries">
          <ul className="flex flex-col gap-1.5">
            {deliveries.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-rule bg-surface px-4 py-2 font-mono text-[11px]"
              >
                <span className="w-44">{d.event}</span>
                <Pill
                  tone={
                    d.status === "delivered" ? "ok" : d.status === "failed" ? "bad" : "warn"
                  }
                >
                  {d.status}
                </Pill>
                <span className="text-ink-3">
                  {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                </span>
                {d.lastError && (
                  <span className="max-w-[40ch] truncate" style={{ color: "var(--bad)" }}>
                    {d.lastError}
                  </span>
                )}
                <span className="ml-auto text-ink-3">
                  {describeInstant(d.createdAt, user.tenantTimezone)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ── Capabilities ──────────────────────────────────────────── */}
      <Section title="Where each thing lives">
        <p className="max-w-[68ch] text-sm text-ink-2">
          Set per capability, not per business. Keep customers in the CRM you already run while
          cadence handles the calendar — the assistant works identically either way, and simply
          loses the tools for anything you have not enabled.
        </p>
        <ul className="flex flex-col gap-2">
          {CAPABILITIES.map(([capability, description]) => {
            const current = modeOf(capability);
            return (
              <Row key={capability}>
                <span className="w-40 font-mono text-xs font-semibold">{capability}</span>
                <span className="text-xs text-ink-2">{description}</span>
                {!current && <Pill tone="warn">not enabled</Pill>}
                {current && (
                  <Pill tone={current.mode === "hosted" ? "ok" : undefined}>
                    {current.mode === "hosted" ? "in cadence" : `via ${current.connector ?? "connector"}`}
                  </Pill>
                )}
                {isOwner && (
                  <form action={setCapability} className="ml-auto flex items-center gap-2">
                    <input type="hidden" name="capability" value={capability} />
                    <select
                      name="mode"
                      defaultValue={current?.mode ?? "hosted"}
                      className={`${inputClass} py-1 text-xs`}
                    >
                      <option value="hosted">in cadence</option>
                      <option value="brokered">in our system</option>
                    </select>
                    <input
                      name="connector"
                      defaultValue={current?.connector ?? ""}
                      placeholder="connector"
                      className={`${inputClass} w-28 py-1 text-xs`}
                    />
                    <Button type="submit" variant="quiet">
                      save
                    </Button>
                  </form>
                )}
              </Row>
            );
          })}
        </ul>
        <p className="text-[11px] text-ink-3">
          Brokered capabilities need a connector, and none are built yet — setting one now means
          the assistant will decline that action rather than writing somewhere wrong.
        </p>
      </Section>

      {/* ── How to call it ────────────────────────────────────────── */}
      <Section title="Calling the API">
        <pre className="overflow-x-auto rounded-lg border border-rule bg-surface p-4 font-mono text-xs leading-relaxed text-ink-2">
{`# What's free next week
curl "${env.CADENCE_BASE_URL}/api/v1/availability?service=SERVICE_ID&from=2026-09-01T00:00:00Z&to=2026-09-08T00:00:00Z" \\
  -H "Authorization: Bearer YOUR_KEY"

# Hold a slot, then confirm it
curl -X POST ${env.CADENCE_BASE_URL}/api/v1/holds \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"customerId":"...","serviceId":"...","locationId":"...","startsAt":"2026-09-03T09:00:00+01:00"}'`}
        </pre>

        <p className="max-w-[68ch] text-sm text-ink-2">
          Send an <code className="font-mono text-[0.85em]">Idempotency-Key</code> on every write.
          Your request will time out eventually, you will retry, and without one that retry is a
          second booking.
        </p>

        <h3 className="mt-2 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-ink-3">
          Verifying a webhook
        </h3>
        <pre className="overflow-x-auto rounded-lg border border-rule bg-surface p-4 font-mono text-xs leading-relaxed text-ink-2">
{`// header: cadence-signature: t=<unix>,v1=<hex>
const [t, v1] = header.split(",").map(p => p.split("=")[1]);
const expected = crypto.createHmac("sha256", SECRET)
  .update(\`\${t}.\${rawBody}\`).digest("hex");

// Compare in constant time, and reject anything older than ~5 minutes —
// signing the body alone would let a captured request be replayed forever.
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) return 401;
if (Math.abs(Date.now()/1000 - Number(t)) > 300) return 401;`}
        </pre>
        <p className="max-w-[68ch] text-sm text-ink-2">
          Verify against the <strong>raw</strong> body. Re-serialising the parsed JSON changes key
          order and the signature will never match.
        </p>
      </Section>
    </div>
  );
}
