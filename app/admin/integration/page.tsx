import Link from "next/link";
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
        title="Connecting other software"
        lede="Most businesses never need this page."
      />

      {/* The default answer, stated first and plainly. Someone who does not run
          their own system should be able to read one paragraph, conclude there
          is nothing for them to do, and leave. */}
      <section className="rounded-lg border border-rule bg-surface p-5">
        <p className="max-w-[66ch] text-sm text-ink-2">
          If you keep your bookings, customers and staff here in enori, everything is already
          connected and there is nothing on this page to set up.
        </p>
        <p className="mt-3 max-w-[66ch] text-sm text-ink-2">
          You only need what follows if you also run <strong>your own software</strong> — a CRM
          or clinic system that should stay in step with what happens here. Setting it up is a
          job for whoever looks after that software, not for the front desk.
        </p>
      </section>

      {/* Deliberately ABOVE the developer fold, not inside it.
          The two directions on this page have different audiences: keeping a CRM
          in step is a job for whoever maintains it, whereas "I already have all
          this in a spreadsheet" is the owner, on their first afternoon — and it
          is the one most of them actually need. */}
      <Section title="Already have this in a spreadsheet?" boxed>
        <p className="max-w-[68ch] text-sm text-ink-2">
          If your services and prices live in a Google Sheet — or in Zoho, Zenoti, Fresha or a till
          system that can export one — point enori at it instead of retyping. It reads the sheet,
          works out which column is which, and keeps following it, so the copy you already edit
          stays the real one.
        </p>
        <Link
          href="/admin/integration/imports"
          className="btn btn-primary mt-4"
        >
          Bring in what you already have
        </Link>
      </Section>

      {!isOwner && <Empty>Only the owner can change these.</Empty>}

      {/* Everything below is the developer surface, folded away by default. */}
      <details className="flex flex-col gap-10 [&[open]>summary]:mb-2">
        <summary className="cursor-pointer text-[13px] font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          I run my own software — show me the technical setup
        </summary>

        <p className="mb-6 max-w-[66ch] text-sm text-ink-2">
          Hand this page to whoever maintains that software. They will need about an hour: create
          a key, tell us where to send updates, and write a small endpoint on their side to
          receive them.
        </p>

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
                <span className="num text-sm font-semibold">{k.name}</span>
                <code className="num text-xs text-ink-2">{k.prefix}.•••</code>
                <span className="num text-[11px] text-ink-3">{k.scopes.join(", ")}</span>
                <span className="num text-[11px] text-ink-3">
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
                <span className="num text-[11px] text-ink-3">
                  {e.events.length === 0 ? "all events" : e.events.join(", ")}
                </span>
                {!e.active && <Pill tone="bad">off</Pill>}
                {e.disabledReason && (
                  <span className="txt-bad max-w-[46ch] text-[11px]">
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
                  <span className="txt-bad max-w-[40ch] truncate">
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
          enori handles the calendar — the assistant works identically either way, and simply
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
                    {current.mode === "hosted" ? "in enori" : `via ${current.connector ?? "connector"}`}
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
                      <option value="hosted">in enori</option>
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

        <h3 className="eyebrow mt-2">
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
      </details>
    </div>
  );
}
