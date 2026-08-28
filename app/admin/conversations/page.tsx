import Link from "next/link";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { Empty, PageHeader, Pill, Row, Section } from "../ui";

export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  const user = await requireUser();

  const conversations = await asTenant(user, (db) =>
    db.conversation.findMany({
      where: { tenantId: user.tenantId },
      include: {
        customer: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      // Threads a colleague owns float to the top: somebody is waiting on a
      // person, and that is the only thing on this screen with a deadline.
      orderBy: [{ botPaused: "desc" }, { updatedAt: "desc" }],
      take: 100,
    }),
  );

  const waiting = conversations.filter((c) => c.botPaused);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Conversations"
        lede="Every thread the assistant is handling. Take one over and it goes quiet until you hand it back."
      />

      {waiting.length > 0 && (
        <p className="text-sm" style={{ color: "var(--warn)" }}>
          {waiting.length} conversation{waiting.length === 1 ? "" : "s"} waiting for a person.
        </p>
      )}

      <Section title="All threads">
        {conversations.length === 0 ? (
          <Empty>Nobody has messaged yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {conversations.map((c) => {
              const last = c.messages[0];
              return (
                <Row key={c.id}>
                  <Link
                    href={`/admin/conversations/${c.id}`}
                    className="font-mono text-sm font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {c.customer.name ?? c.customer.phone ?? "Unknown"}
                  </Link>

                  <Pill>{c.channel}</Pill>
                  {c.botPaused && <Pill tone="warn">with a colleague</Pill>}
                  {c.customer.optedOut && <Pill tone="bad">opted out</Pill>}

                  {last && (
                    <span className="max-w-[42ch] truncate text-xs text-ink-2">
                      {last.direction === "outbound" ? "You: " : ""}
                      {last.body}
                    </span>
                  )}

                  <span className="ml-auto font-mono text-[11px] text-ink-3">
                    {describeInstant(c.updatedAt, user.tenantTimezone)}
                  </span>
                </Row>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
