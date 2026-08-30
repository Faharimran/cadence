import { requireUser, asTenant } from "@/lib/auth/guard";
import { ThreadList, type ThreadSummary } from "./ThreadList";

export const dynamic = "force-dynamic";

/**
 * The inbox, as two panes: everyone on the left, one conversation on the right.
 *
 * A layout rather than a page, so the list is the frame and the thread is the
 * child. That keeps a real URL per conversation — shareable, linkable from the
 * dashboard, survives a refresh — while the list stays mounted and does not
 * re-render as you move between threads.
 *
 * The list is loaded here, once, for every route beneath it.
 */
export default async function ConversationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  const conversations = await asTenant(user, (db) =>
    db.conversation.findMany({
      where: { tenantId: user.tenantId },
      include: {
        customer: { select: { name: true, phone: true, optedOut: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { body: true, direction: true, author: true },
        },
      },
      // Threads a colleague owns float to the top: somebody is waiting on a
      // person, and that is the only thing on this screen with a deadline.
      orderBy: [{ botPaused: "desc" }, { updatedAt: "desc" }],
      take: 200,
    }),
  );

  const threads: ThreadSummary[] = conversations.map((c) => {
    const last = c.messages[0];
    return {
      id: c.id,
      name: c.customer.name ?? c.customer.phone ?? "Unknown",
      channel: c.channel,
      botPaused: c.botPaused,
      optedOut: c.customer.optedOut,
      lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
      updatedAt: c.updatedAt.toISOString(),
      preview: last
        ? `${last.direction === "outbound" ? (last.author === "human" ? "You: " : "Assistant: ") : ""}${last.body}`
        : null,
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em]">
          Conversations
        </h1>
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Every thread the assistant is handling. Take one over and it goes quiet until you hand it
          back — but it still reads what you said.
        </p>
      </div>

      {/* Fixed height so each pane scrolls independently, the way an inbox
          should: picking a thread must not move the list you picked it from. */}
      <div className="grid h-[calc(100vh-16rem)] min-h-[32rem] grid-cols-1 gap-4 md:grid-cols-[20rem_1fr] lg:grid-cols-[23rem_1fr]">
        <ThreadList threads={threads} timezone={user.tenantTimezone} />
        <section className="min-w-0 overflow-hidden rounded-2xl border border-rule bg-surface">
          {children}
        </section>
      </div>
    </div>
  );
}
