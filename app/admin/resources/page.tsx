import { requireUser, asTenant } from "@/lib/auth/guard";
import { toggleResource } from "./actions";
import { ResourceForm } from "./ResourceForm";
import { Button, Empty, PageHeader, Pill, Row, Section } from "../ui";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  person: "person",
  room: "room",
  equipment: "equipment",
};

export default async function ResourcesPage() {
  const user = await requireUser();

  const { locations, resources } = await asTenant(user, async (db) => {
    const [locations, resources] = await Promise.all([
      db.location.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { name: "asc" },
      }),
      db.resource.findMany({
        where: { tenantId: user.tenantId },
        include: {
          locations: { include: { location: true } },
          _count: { select: { scheduleRules: true } },
        },
        orderBy: [{ active: "desc" }, { name: "asc" }],
      }),
    ]);
    return { locations, resources };
  });

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="People &amp; rooms"
        lede="Anything a booking occupies. A service can require several at once — a stylist and a chair, a surgeon and a theatre — so rooms and equipment live here alongside people."
      />

      <Section title="Add someone or something" boxed>
        <ResourceForm locations={locations} />
      </Section>

      <Section title="Everything bookable">
        {resources.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {resources.map((r) => (
              <Row key={r.id}>
                <span className="num text-sm font-semibold">{r.name}</span>
                <Pill>{KIND_LABEL[r.kind] ?? r.kind}</Pill>

                {r.tags.length > 0 && (
                  <span className="num text-[11px] text-ink-3">{r.tags.join(" · ")}</span>
                )}

                <span className="text-xs text-ink-2">
                  {r.locations.length > 0
                    ? r.locations.map((l) => l.location.name).join(", ")
                    : "no location"}
                </span>

                {/* The most common reason someone is "set up" but never offered. */}
                {r.active && r._count.scheduleRules === 0 && (
                  <Pill tone="warn">no hours set</Pill>
                )}
                {!r.active && <Pill tone="bad">inactive</Pill>}

                <form action={toggleResource} className="ml-auto">
                  <input type="hidden" name="id" value={r.id} />
                  <Button type="submit" variant="quiet">
                    {r.active ? "deactivate" : "reactivate"}
                  </Button>
                </form>
              </Row>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
