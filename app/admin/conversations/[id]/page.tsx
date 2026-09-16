import { notFound } from "next/navigation";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { takeOver, handBack, replyAsHuman } from "../actions";
import { LiveBadge } from "../LiveBadge";
import { Composer } from "./Composer";

export const dynamic = "force-dynamic";

/**
 * One conversation, as the right-hand pane.
 *
 * Three things share this space and their order is deliberate: who you are
 * talking to and whether the assistant still has the thread; the transcript;
 * and the composer pinned to the bottom. The takeover control sits in the
 * header rather than beside the composer because it changes who owns the whole
 * conversation, not who sends the next message.
 */
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
        messages: { orderBy: { createdAt: "asc" }, take: 300 },
      },
    }),
  );

  if (!conversation) notFound();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Who, and who owns the thread ──────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-5 py-3">
        <span className="text-[15px] font-semibold text-ink">
          {conversation.customer.name ?? conversation.customer.phone ?? "Unknown"}
        </span>

        <LiveBadge lastInboundAt={conversation.lastInboundAt?.toISOString() ?? null} />

        <span className="num text-[11px] text-ink-3">
          {conversation.channel}
          {conversation.customer.phone ? ` · ${conversation.customer.phone}` : ""}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={
              conversation.botPaused
                ? { color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 14%, transparent)" }
                : { color: "var(--ok)", background: "color-mix(in srgb, var(--ok) 14%, transparent)" }
            }
          >
            {conversation.botPaused ? "you have this thread" : "assistant is replying"}
          </span>

          <form action={conversation.botPaused ? handBack : takeOver}>
            <input type="hidden" name="id" value={conversation.id} />
            <button
              type="submit"
              className={`rounded-full px-4 py-1.5 text-[12px] font-semibold transition-transform hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                conversation.botPaused
                  ? "border border-rule bg-surface text-ink"
                  : "bg-accent text-on-accent"
              }`}
            >
              {conversation.botPaused ? "Hand back to the assistant" : "Take over"}
            </button>
          </form>
        </div>
      </header>

      {conversation.customer.optedOut && (
        <p
          className="border-b border-rule px-5 py-2 text-[12px]"
          style={{ color: "var(--bad)", background: "color-mix(in srgb, var(--bad) 8%, transparent)" }}
        >
          This customer has opted out. Nothing can be sent to them.
        </p>
      )}

      {/* ── Transcript ────────────────────────────────────────────── */}
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-paper px-5 py-4">
        {conversation.messages.length === 0 && (
          <li className="text-sm text-ink-3">Nothing said yet.</li>
        )}

        {conversation.messages.map((m) => {
          const outbound = m.direction === "outbound";
          const byHuman = m.author === "human";

          return (
            <li
              key={m.id}
              className={`flex flex-col gap-1 ${outbound ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[68ch] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm ${
                  outbound ? "rounded-br-sm" : "rounded-bl-sm border border-rule bg-surface"
                }`}
                // A colleague's message is visually distinct from the
                // assistant's, because "did a person say this?" is the first
                // question anyone reading back has.
                //
                // Both grounds carry their own ink rather than a literal white:
                // the assistant's accent and the colleague's aqua are different
                // colours in dark mode, and white sat on neither of them.
                style={
                  outbound
                    ? byHuman
                      ? { background: "var(--tag-aqua-fill)", color: "var(--tag-aqua-ink)" }
                      : { background: "var(--accent)", color: "var(--on-accent)" }
                    : undefined
                }
              >
                {m.body}
              </div>

              <span className="num text-[10px] text-ink-3">
                {byHuman ? "a colleague" : m.author}
                {" · "}
                {describeInstant(m.createdAt, user.tenantTimezone)}
                {m.status === "failed" && (
                  <span className="txt-bad"> · not delivered</span>
                )}
                {/* Which snapshot the assistant was reading when it said this —
                    how you tell stale data from a model error, weeks later. */}
                {m.snapshotAt && m.author === "agent" && (
                  <span> · data from {describeInstant(m.snapshotAt, user.tenantTimezone)}</span>
                )}
                {m.sources.length > 0 && <span> · read {m.sources.join(", ")}</span>}
              </span>

              {/* Why it failed, next to the message that failed.
                  "Not delivered" alone tells someone that something is wrong
                  and nothing about what, so it reaches us or nobody. The usual
                  cause is an expired access token, which they can fix
                  themselves once told that is what happened. */}
              {m.status === "failed" && m.failureReason && (
                <p
                  className="max-w-[60ch] rounded-xl border px-3 py-2 text-[12px] leading-relaxed"
                  style={{
                    borderColor: "color-mix(in srgb, var(--bad) 35%, transparent)",
                    background: "color-mix(in srgb, var(--bad) 8%, transparent)",
                    color: "var(--bad)",
                  }}
                >
                  {m.failureReason}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {/* ── Composer ──────────────────────────────────────────────── */}
      {!conversation.customer.optedOut && (
        <Composer
          conversationId={conversation.id}
          action={replyAsHuman}
          botPaused={conversation.botPaused}
        />
      )}
    </div>
  );
}
