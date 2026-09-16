import { requireUser, asTenant } from "@/lib/auth/guard";
import { removeScheduleRule } from "./actions";
import { ScheduleForm } from "./ScheduleForm";
import { Button, Empty, PageHeader, Prerequisite, Section, weekdayName } from "../ui";

export const dynamic = "force-dynamic";

export default async function SchedulesPage() {
  const user = await requireUser();

  const { resources, locations, rules } = await asTenant(user, async (db) => {
    const [resources, locations, rules] = await Promise.all([
      db.resource.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { name: "asc" },
      }),
      db.location.findMany({
        where: { tenantId: user.tenantId, active: true },
        orderBy: { name: "asc" },
      }),
      db.scheduleRule.findMany({
        // Only the rules currently in force. Closed-off ones stay in the table
        // so historical availability remains reconstructible, but nobody needs
        // to look at them here.
        where: { tenantId: user.tenantId, effectiveTo: null },
        include: { resource: true, location: true },
        orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
      }),
    ]);
    return { resources, locations, rules };
  });

  // Grouped by person, because "when does Alex work" is the question people
  // actually arrive with — not "who works on Tuesdays".
  const byResource = new Map<string, typeof rules>();
  for (const rule of rules) {
    const list = byResource.get(rule.resource.name) ?? [];
    list.push(rule);
    byResource.set(rule.resource.name, list);
  }

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Opening hours"
        lede="The normal week. Everything else — leave, closures, one-off extra sessions — is recorded separately and applied on top of this."
      />

      <Section title="Set hours" boxed>
        {resources.length === 0 ? (
          <Prerequisite
            what="Add a person or a room first."
            href="/admin/resources"
            cta="People &amp; rooms"
          />
        ) : locations.length === 0 ? (
          <Prerequisite
            what="Add a location first."
            href="/admin/settings"
            cta="Settings"
          />
        ) : (
          <ScheduleForm resources={resources} locations={locations} />
        )}
      </Section>

      <Section title="The normal week">
        {rules.length === 0 ? (
          <Empty>
            Nothing set. Until hours exist here, the assistant has no times to offer anyone.
          </Empty>
        ) : (
          <div className="flex flex-col gap-6">
            {[...byResource.entries()].map(([name, theirs]) => (
              <div key={name} className="flex flex-col gap-2">
                <h3 className="num text-sm font-semibold">{name}</h3>
                <ul className="flex flex-col gap-1.5">
                  {theirs.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-rule bg-surface px-4 py-2"
                    >
                      <span className="w-24 text-xs">{weekdayName(r.weekday)}</span>
                      <span className="num text-sm">
                        {r.startTime} – {r.endTime}
                      </span>
                      <span className="num text-[11px] text-ink-3">
                        {r.location.name} · {r.slotMinutes}-minute slots
                      </span>
                      <form action={removeScheduleRule} className="ml-auto">
                        <input type="hidden" name="id" value={r.id} />
                        <Button type="submit" variant="quiet">
                          remove
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
