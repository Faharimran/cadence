import { requireUser, asTenant } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { deleteException, approveException } from "./actions";
import { ExceptionForm } from "./ExceptionForm";

export const dynamic = "force-dynamic";

export default async function ExceptionsPage() {
  const user = await requireUser();

  const data = await asTenant(user, async (db) => {
    const [types, locations, resources, services, upcoming] = await Promise.all([
      db.exceptionType.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { label: "asc" },
      }),
      db.location.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { name: "asc" },
      }),
      db.resource.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { name: "asc" },
      }),
      db.service.findMany({
        where: { tenantId: user.tenantId, active: true },
        select: { category: true },
      }),
      db.scheduleException.findMany({
        where: { tenantId: user.tenantId, endsAt: { gte: new Date() } },
        include: { type: true, location: true, resource: true },
        orderBy: { startsAt: "asc" },
        take: 100,
      }),
    ]);

    const categories = [...new Set(services.map((s) => s.category).filter(Boolean))] as string[];
    return { types, locations, resources, categories, upcoming };
  });

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="num text-[19px] font-semibold">Leave &amp; closures</h1>
        <p className="max-w-[62ch] text-sm text-ink-2">
          Anything recorded here is removed from what customers can book, immediately. The
          assistant will not offer a time that falls inside one of these — and will only
          explain why if the type allows it.
        </p>
      </header>

      {/* ── New entry ─────────────────────────────────────────────── */}
      <section className="rounded-lg border border-rule bg-surface p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-ink">
          Record something new
        </h2>

        {data.types.length === 0 ? (
          <p className="text-sm text-ink-2">
            No types are set up yet. An owner can add them under Settings.
          </p>
        ) : (
          <ExceptionForm
            types={data.types.map((t) => ({
              id: t.id,
              label: t.label,
              hint: t.effect === "add" ? "(adds time)" : undefined,
            }))}
            locations={data.locations.map((l) => ({ id: l.id, label: l.name }))}
            resources={data.resources.map((r) => ({ id: r.id, label: r.name }))}
            categories={data.categories}
            timezone={user.tenantTimezone}
          />
        )}
      </section>

      {/* ── Upcoming ──────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="border-b border-rule pb-1.5 text-[15px] font-semibold text-ink">
          Coming up
        </h2>

        {data.upcoming.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing recorded. Everything is bookable as normal.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.upcoming.map((e) => {
              const tz = e.location?.timezone ?? user.tenantTimezone;
              return (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-rule bg-surface px-4 py-3"
                >
                  <span
                    className="num rounded px-2 py-0.5 text-[11px] font-semibold"
                    style={{
                      color: e.type.effect === "add" ? "var(--ok)" : "var(--bad)",
                      border: `1px solid ${e.type.effect === "add" ? "var(--ok)" : "var(--bad)"}40`,
                    }}
                  >
                    {e.type.label}
                  </span>

                  <span className="num text-xs">
                    {describeInstant(e.startsAt, tz)} → {describeInstant(e.endsAt, tz)}
                  </span>

                  <span className="text-xs text-ink-2">
                    {e.resource?.name ?? "Everyone"} · {e.location?.name ?? "Every location"}
                    {e.serviceCategories.length > 0 && ` · ${e.serviceCategories.join(", ")}`}
                  </span>

                  {e.status === "requested" && (
                    <form action={approveException}>
                      <input type="hidden" name="id" value={e.id} />
                      <button
                        type="submit"
                        className="txt-warn text-[11px] underline underline-offset-2"
                      >
                        awaiting approval — approve
                      </button>
                    </form>
                  )}

                  <form action={deleteException} className="ml-auto">
                    <input type="hidden" name="id" value={e.id} />
                    <button
                      type="submit"
                      className="text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      remove
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
