import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { takeOver, handBack, replyAsHuman } from "../actions";
import { Button, Pill, inputClass } from "../../ui";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const conversation = await asTenant(user, (db) =>
    db.conversation.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        customer: true,
        messages: { orderBy: { createdAt: "asc" }, take: 200 },
      },
    }),
  );

  if (!conversation) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/admin/conversations"
          className="font-mono text-[11px] text-ink-3 underline underline-offset-2"
        >
          ← all conversations
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold tracking-tight">
            {conversation.customer.name ?? conversation.customer.phone ?? "Unknown"}
          </h1>
          <Pill>{conversation.channel}</Pill>
          {conversation.botPaused ? (
            <Pill tone="warn">you have this thread</Pill>
          ) : (
            <Pill tone="ok">assistant is handling it</Pill>
          )}
          {conversation.customer.optedOut && <Pill tone="bad">opted out of contact</Pill>}
        </div>

        <form action={conversation.botPaused ? handBack : takeOver}>
          <input type="hidden" name="id" value={conversation.id} />
          <Button type="submit" variant="quiet">
            {conversation.botPaused
              ? "hand back to the assistant"
              : "take over — the assistant will stop replying"}
          </Button>
        </form>
      </div>

      <ol className="flex flex-col gap-3">
        {conversation.messages.map((m) => {
          const outbound = m.direction === "outbound";
          return (
            <li
              key={m.id}
              className={`flex flex-col gap-1 ${outbound ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[70ch] whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-sm ${
                  outbound ? "border-accent/30 bg-surface-2" : "border-rule bg-surface"
                }`}
              >
                {m.body}
              </div>
              <span className="font-mono text-[10px] text-ink-3">
                {m.author}
                {" · "}
                {describeInstant(m.createdAt, user.tenantTimezone)}
                {m.status === "failed" && (
                  <span style={{ color: "var(--bad)" }}> · not delivered</span>
                )}
                {/* Which snapshot the assistant was reading when it said this —
                    how you tell stale data from a model error, weeks later. */}
                {m.snapshotAt && m.author === "agent" && (
                  <span> · data from {describeInstant(m.snapshotAt, user.tenantTimezone)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {conversation.customer.optedOut ? (
        <p className="text-sm" style={{ color: "var(--bad)" }}>
          This customer has opted out. Nothing can be sent to them.
        </p>
      ) : (
        <form action={replyAsHuman} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={conversation.id} />
          <textarea
            name="body"
            required
            rows={3}
            className={inputClass}
            placeholder="Reply as yourself…"
          />
          <p className="text-[11px] text-ink-3">
            Sending takes the thread over automatically — two voices answering one customer is
            worse than a slow reply.
          </p>
          <Button type="submit">Send</Button>
        </form>
      )}
    </div>
  );
}
