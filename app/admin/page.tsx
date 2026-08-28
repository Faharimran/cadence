import Link from "next/link";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { describeInstant, localDateIn } from "@/lib/engine/time";

export const dynamic = "force-dynamic";

/**
 * Today.
 *
 * Deliberately the first screen: what a front desk needs on opening is what is
 * happening now and what needs a person — not a configuration menu.
 */
export default async function AdminHome() {
  const user = await requireUser();
  const now = new Date();

  const data = await asTenant(user, async (db) => {
    const today = localDateIn(now, user.tenantTimezone);
    const dayStart = new Date(`${today}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 36 * 3600_000);

    const [todays, needsPerson, closures, unread] = await Promise.all([
      db.booking.findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: ["scheduled", "confirmed"] },
          startsAt: { gte: dayStart, lt: dayEnd },
        },
        include: { customer: true, service: true, location: true, resources: { include: { resource: true } } },
        orderBy: { startsAt: "asc" },
        take: 50,
      }),
      db.conversation.count({ where: { tenantId: user.tenantId, botPaused: true, status: "open" } }),
      db.scheduleException.count({
        where: { tenantId: user.tenantId, startsAt: { lte: dayEnd }, endsAt: { gte: now } },
      }),
      db.conversation.count({ where: { tenantId: user.tenantId, status: "open" } }),
    ]);

    return { todays, needsPerson, closures, unread };
  });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">
          {describeInstant(now, user.tenantTimezone)} · {user.tenantTimezone}
        </span>
        <h1 className="font-mono text-xl font-semibold tracking-tight">
          {user.name ? `Morning, ${user.name.split(" ")[0]}` : user.tenantName}
        </h1>
      </header>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-3">
        <Stat label="Booked today" value={String(data.todays.length)} />
        <Stat
          label="Waiting for a person"
          value={String(data.needsPerson)}
          href="/admin/conversations"
          urgent={data.needsPerson > 0}
        />
        <Stat label="Closures in effect" value={String(data.closures)} href="/admin/exceptions" />
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="border-b border-rule pb-2 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-accent">
          Next 24 hours
        </h2>

        {data.todays.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing booked yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.todays.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-rule bg-surface px-4 py-3"
              >
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {describeInstant(b.startsAt, b.location.timezone)}
                </span>
                <span className="text-sm">{b.customer.name ?? b.customer.phone ?? "—"}</span>
                <span className="text-sm text-ink-2">{b.service.name}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-3">
                  {b.location.name} · {b.resources.map((r) => r.resource.name).join(" + ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm text-ink-2">
        {data.unread} open conversation{data.unread === 1 ? "" : "s"}.{" "}
        <Link href="/admin/conversations" className="text-accent underline underline-offset-2">
          Open the inbox
        </Link>
        .
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  urgent,
}: {
  label: string;
  value: string;
  href?: string;
  urgent?: boolean;
}) {
  const body = (
    <div className="flex flex-col gap-1 bg-surface p-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">{label}</dt>
      <dd
        className="font-mono text-2xl font-semibold tabular-nums"
        style={urgent ? { color: "var(--warn)" } : undefined}
      >
        {value}
      </dd>
    </div>
  );
  return href ? (
    <Link href={href} className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      {body}
    </Link>
  ) : (
    body
  );
}
