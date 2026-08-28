import { requireUser, asTenant } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { cancelBookingAction } from "./actions";
import { Button, Empty, PageHeader, Pill, Row, Section } from "../ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, "ok" | "warn" | "bad" | undefined> = {
  confirmed: "ok",
  scheduled: "ok",
  completed: undefined,
  held: "warn",
  needs_rebooking: "warn",
  cancelled: "bad",
  no_show: "bad",
};

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ past?: string }>;
}) {
  const user = await requireUser();
  const { past } = await searchParams;
  const showPast = past === "1";

  const bookings = await asTenant(user, (db) =>
    db.booking.findMany({
      where: {
        tenantId: user.tenantId,
        ...(showPast ? { startsAt: { lt: new Date() } } : { startsAt: { gte: new Date() } }),
      },
      include: {
        customer: true,
        service: true,
        location: true,
        resources: { include: { resource: true } },
      },
      orderBy: { startsAt: showPast ? "desc" : "asc" },
      take: 100,
    }),
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Bookings"
        lede="Cancelling here frees the slot immediately — the assistant can offer it to the next person who asks."
      />

      <nav className="flex gap-4 text-sm">
        <a
          href="/admin/bookings"
          className={showPast ? "text-ink-2 underline underline-offset-2" : "font-semibold"}
        >
          Upcoming
        </a>
        <a
          href="/admin/bookings?past=1"
          className={showPast ? "font-semibold" : "text-ink-2 underline underline-offset-2"}
        >
          Past
        </a>
      </nav>

      <Section title={showPast ? "Already happened" : "Coming up"}>
        {bookings.length === 0 ? (
          <Empty>{showPast ? "Nothing in the past." : "Nothing booked."}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {bookings.map((b) => {
              const live = ["held", "scheduled", "confirmed"].includes(b.status);
              return (
                <Row key={b.id}>
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {describeInstant(b.startsAt, b.location.timezone)}
                  </span>
                  <span className="text-sm">
                    {b.customer.name ?? b.customer.phone ?? "—"}
                  </span>
                  <span className="text-sm text-ink-2">{b.service.name}</span>
                  <Pill tone={TONE[b.status]}>{b.status.replace("_", " ")}</Pill>

                  <span className="font-mono text-[11px] text-ink-3">
                    {b.location.name} · {b.resources.map((r) => r.resource.name).join(" + ")}
                    {b.source === "agent" && " · booked by the assistant"}
                  </span>

                  {live && (
                    <form action={cancelBookingAction} className="ml-auto">
                      <input type="hidden" name="id" value={b.id} />
                      <Button type="submit" variant="quiet">
                        cancel
                      </Button>
                    </form>
                  )}
                </Row>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
