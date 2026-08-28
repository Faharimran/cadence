import { requireUser, asTenant } from "@/lib/auth/guard";
import { toggleService, togglePriceQuotable } from "./actions";
import { ServiceForm } from "./ServiceForm";
import { Button, Empty, PageHeader, Pill, Row, Section } from "../ui";

export const dynamic = "force-dynamic";

function money(minor: number | null, currency: string): string | null {
  if (minor === null) return null;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export default async function ServicesPage() {
  const user = await requireUser();

  const services = await asTenant(user, (db) =>
    db.service.findMany({
      where: { tenantId: user.tenantId },
      include: { requirements: true },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
  );

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Services"
        lede="What customers can book. Duration and buffers decide how much of a person's day each one takes; requirements decide who can deliver it."
      />

      <Section title="Add a service" boxed>
        <ServiceForm currency={user.tenantCurrency} />
      </Section>

      <Section title="Everything on offer">
        {services.length === 0 ? (
          <Empty>Nothing yet. Without a service there is nothing to book.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {services.map((s) => {
              const price = money(s.priceMinor, user.tenantCurrency);
              const occupies =
                s.bufferBeforeMinutes + s.durationMinutes + s.bufferAfterMinutes;

              return (
                <Row key={s.id}>
                  <span className="font-mono text-sm font-semibold">{s.name}</span>
                  {s.category && <Pill>{s.category}</Pill>}

                  <span className="font-mono text-xs tabular-nums">
                    {s.durationMinutes} min
                    {occupies !== s.durationMinutes && (
                      <span className="text-ink-3"> ({occupies} incl. buffers)</span>
                    )}
                  </span>

                  <span className="font-mono text-xs tabular-nums">
                    {price ?? <span className="text-ink-3">on request</span>}
                  </span>

                  {price &&
                    (s.priceQuotable ? (
                      <Pill tone="ok">assistant may quote</Pill>
                    ) : (
                      <Pill tone="warn">withheld from assistant</Pill>
                    ))}

                  {s.requirements.length === 0 && <Pill tone="warn">no requirements</Pill>}
                  {!s.active && <Pill tone="bad">inactive</Pill>}

                  <span className="font-mono text-[11px] text-ink-3">
                    {s.requirements
                      .map(
                        (r) =>
                          `${r.quantity}× ${r.tags.length ? r.tags.join("+") : r.kind ?? "anything"}`,
                      )
                      .join(", ")}
                  </span>

                  <div className="ml-auto flex items-center gap-4">
                    {price && (
                      <form action={togglePriceQuotable}>
                        <input type="hidden" name="id" value={s.id} />
                        <Button type="submit" variant="quiet">
                          {s.priceQuotable ? "withhold price" : "allow quoting"}
                        </Button>
                      </form>
                    )}
                    <form action={toggleService}>
                      <input type="hidden" name="id" value={s.id} />
                      <Button type="submit" variant="quiet">
                        {s.active ? "deactivate" : "reactivate"}
                      </Button>
                    </form>
                  </div>
                </Row>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
