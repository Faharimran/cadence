import { adminDb, isolationStatus } from "@/lib/prisma";
import { env } from "@/lib/env";

/**
 * Operator console.
 *
 * Reads platform-wide state, so it is deliberately NOT tenant-scoped and is
 * gated to development. Before this ships anywhere public it needs operator
 * authentication — a page that lists every tenant is exactly the thing tenant
 * isolation exists to prevent, and RLS does not protect it because it runs on
 * the admin connection.
 */
export const dynamic = "force-dynamic";

const ENDPOINTS = [
  ["GET", "/api/health", "Liveness and posture. No credentials."],
  ["GET", "/api/v1/availability", "?service=&from=&to=[&location=][&resource=][&limit=]"],
  ["POST", "/api/v1/holds", "Reserve a slot briefly while a customer decides."],
  ["POST", "/api/v1/bookings", "{ holdId } to confirm, or book outright."],
  ["GET", "/api/v1/bookings/:id", "Retrieve one booking."],
  ["DELETE", "/api/v1/bookings/:id", "Cancel; frees the slot immediately."],
] as const;

export default async function Home() {
  const isDev = env.NODE_ENV === "development";

  const isolation = await isolationStatus().catch((e) => ({
    enforced: false,
    reason: e instanceof Error ? e.message : "unknown",
  }));

  const constraint = await adminDb
    .$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'booking_resource_no_overlap'
    `
    .then((r) => Number(r[0]?.n ?? 0) > 0)
    .catch(() => false);

  const tenants = isDev
    ? await adminDb.tenant.findMany({
        orderBy: { createdAt: "asc" },
        include: {
          _count: { select: { locations: true, resources: true, services: true, bookings: true } },
          capabilities: { select: { capability: true, mode: true } },
        },
      })
    : [];

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-12 px-7 py-14">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">
          cadence · operator console
        </p>
        <h1 className="font-mono text-3xl font-semibold tracking-tight">
          Scheduling infrastructure
        </h1>
        <p className="max-w-[62ch] text-ink-2">
          There is no tenant-facing UI yet — this instance is an API. The admin interface
          where a business enters its own schedules and exceptions is still to be built.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="border-b border-rule pb-2 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-accent">
          Posture
        </h2>
        <dl className="grid gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-3">
          <Stat label="Database" value="reachable" ok />
          <Stat
            label="Tenant isolation"
            value={isolation.enforced ? "enforced" : "INERT"}
            detail={isolation.enforced ? undefined : isolation.reason}
            ok={isolation.enforced}
          />
          <Stat
            label="Overlap constraint"
            value={constraint ? "present" : "MISSING"}
            detail={constraint ? undefined : "run npm run db:rls"}
            ok={constraint}
          />
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="border-b border-rule pb-2 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-accent">
          Endpoints
        </h2>
        <p className="text-sm text-ink-2">
          Every <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em]">/v1</code>{" "}
          route requires{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em]">
            Authorization: Bearer &lt;prefix&gt;.&lt;secret&gt;
          </code>
          . Send an{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em]">
            Idempotency-Key
          </code>{" "}
          on writes.
        </p>
        <div className="overflow-x-auto rounded-lg border border-rule bg-surface">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {ENDPOINTS.map(([method, path, note]) => (
                <tr key={`${method} ${path}`} className="border-b border-rule/50 last:border-0">
                  <td className="whitespace-nowrap py-2.5 pl-4 pr-3 font-mono text-xs font-semibold text-accent">
                    {method}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 font-mono text-xs">{path}</td>
                  <td className="py-2.5 pr-4 text-xs text-ink-3">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isDev && (
        <section className="flex flex-col gap-3">
          <h2 className="border-b border-rule pb-2 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-accent">
            Tenants <span className="text-ink-3">· development only</span>
          </h2>
          {tenants.length === 0 ? (
            <p className="text-sm text-ink-2">
              None yet. Run <code className="font-mono">npm run seed:demo</code>.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {tenants.map((t) => (
                <div
                  key={t.id}
                  className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-sm font-semibold">{t.name}</span>
                    <span className="font-mono text-xs text-ink-3">{t.slug}</span>
                    <span className="font-mono text-xs text-ink-3">
                      {t.timezone} · {t.currency}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-4 font-mono text-xs text-ink-2">
                    <span>{t._count.locations} locations</span>
                    <span>{t._count.resources} resources</span>
                    <span>{t._count.services} services</span>
                    <span>{t._count.bookings} bookings</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {t.capabilities.map((c) => (
                      <span
                        key={c.capability}
                        className="rounded border border-rule px-2 py-0.5 font-mono text-[10px] text-ink-2"
                        title={`${c.capability} served ${c.mode}`}
                      >
                        {c.capability}
                        <span className="text-ink-3"> · {c.mode}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <footer className="flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 font-mono text-[11px] text-ink-3">
        <span>npx tsx scripts/proveEngine.ts</span>
        <span>npm run db:rls -- --verify</span>
        <span>Next.js 16 · Prisma 6 · Postgres 16</span>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  detail,
  ok,
}: {
  label: string;
  value: string;
  detail?: string;
  ok: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 bg-surface p-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">{label}</dt>
      <dd
        className="font-mono text-sm font-semibold"
        style={{ color: ok ? "var(--ok)" : "var(--bad)" }}
      >
        {value}
      </dd>
      {detail && <p className="font-mono text-[10px] text-ink-3">{detail}</p>}
    </div>
  );
}
