"use client";

import { useEffect, useRef, useState } from "react";
import { SELECT_DEMO_EVENT, type SelectDemoDetail } from "@/lib/marketing/demoEvent";

/**
 * The "try it" panel.
 *
 * Three businesses, one agent, and a real request per message. What this
 * component is careful about is not pretending: it renders what came back and
 * nothing else. There is no typing simulation, no canned fallback when the
 * request fails, and no client-side answer for anything. If the endpoint is
 * down the panel says so, because a demo that fakes a reply on error is a demo
 * that could be faking all of them.
 *
 * The tool chips under a reply are the other half of the argument. A visitor
 * can see that "10:15 or 11:00 suit you?" arrived with `check_availability`
 * attached and that a question about a treatment arrived with nothing but a
 * hand-over — which is a claim about the architecture that a transcript alone
 * cannot make.
 */

export type DemoPersonaView = {
  id: string;
  tab: string;
  trade: string;
  blurb: string;
  starters: string[];
  businessName: string;
};

type Message =
  | { role: "visitor"; text: string }
  | { role: "agent"; text: string; tools: string[] }
  /** enori speaking about the conversation, never the business speaking. */
  | { role: "system"; text: string };

/**
 * Tool names are an internal vocabulary; these are what they mean to someone
 * who has been on the page for forty seconds. Anything unmapped falls through
 * to its raw name rather than being hidden — a chip nobody labelled is still
 * true, and silently dropping it would misrepresent the turn.
 */
const TOOL_LABELS: Record<string, string> = {
  list_services: "read the price list",
  check_availability: "checked the live calendar",
  list_my_bookings: "checked your bookings",
  search_knowledge: "searched what's written down",
  escalate_to_human: "handed over to a person",
};

export default function DemoChat({
  personas,
  configured,
}: {
  personas: DemoPersonaView[];
  configured: boolean;
}) {
  const [activeId, setActiveId] = useState(personas[0]?.id ?? "");
  // Kept per persona, matching the server: each business has its own thread for
  // this visitor, so switching tabs and coming back resumes rather than resets.
  const [threads, setThreads] = useState<Record<string, Message[]>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const active = personas.find((p) => p.id === activeId) ?? personas[0];
  const messages = threads[activeId] ?? [];
  const closed = messages.some((m) => m.role === "system");

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow the conversation down. Scoped to the log's own box rather than the
  // window, or sending a message would drag the whole page.
  //
  // Keyed on the state rather than on `messages`, which is a fresh array on
  // every render and would make this fire continuously.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threads, activeId, pending]);

  // The industries section links down here with a trade already in mind. It has
  // no way to reach this component's state, so it asks — see lib/marketing/
  // demoEvent.ts. An id that is not one of ours is ignored rather than trusted.
  useEffect(() => {
    function onSelect(event: Event) {
      const persona = (event as CustomEvent<SelectDemoDetail>).detail?.persona;
      if (persona && personas.some((p) => p.id === persona)) setActiveId(persona);
    }
    window.addEventListener(SELECT_DEMO_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_DEMO_EVENT, onSelect);
  }, [personas]);

  function push(personaId: string, message: Message) {
    setThreads((prev) => ({ ...prev, [personaId]: [...(prev[personaId] ?? []), message] }));
  }

  async function send(text: string) {
    const body = text.trim();
    if (!body || pending || closed) return;

    const personaId = activeId;
    setDraft("");
    setError(null);
    push(personaId, { role: "visitor", text: body });
    setPending(true);

    try {
      const response = await fetch("/api/demo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: personaId, message: body }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data?.error ?? "That didn't go through.");
        return;
      }
      if (data.reply) {
        push(personaId, { role: "agent", text: data.reply, tools: data.tools ?? [] });
      }
      if (data.note) push(personaId, { role: "system", text: data.note });
    } catch {
      setError("Couldn't reach the demo. Check your connection and try again.");
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }

  async function startOver() {
    setThreads({});
    setError(null);
    setDraft("");
    // Rotates the identity server-side too. Clearing only the browser's copy
    // would leave the next message landing in the thread we just hid.
    await fetch("/api/demo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: activeId, reset: true }),
    }).catch(() => {});
  }

  if (!active) return null;

  return (
    <section id="demo" className="bg-m-paper pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <p className="eyebrow flex items-center gap-2 text-m-ink-3">
            <span
              aria-hidden
              className="inline-block size-1 rounded-full"
              style={{ background: "var(--signal)" }}
            />
            Try it
          </p>
          <h2
            className="mt-5 font-display text-[clamp(1.9rem,4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.025em]"
            style={{ textWrap: "balance" }}
          >
            Three businesses. One assistant. Ask it anything.
          </h2>
          <p className="mt-6 text-[15px] leading-relaxed text-m-ink-2">
            These are real tenants on this deployment — three currencies, three timezones, three
            sets of things they refuse to discuss. The same agent answers all of them, and nothing
            in it knows what a clinic is. Try to catch it out.
          </p>
        </div>

        {/* ── Which business ─────────────────────────────────────── */}
        <div role="tablist" aria-label="Demo businesses" className="mt-10 grid gap-3 md:grid-cols-3">
          {personas.map((persona) => {
            const selected = persona.id === activeId;
            return (
              <button
                key={persona.id}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => {
                  setActiveId(persona.id);
                  setError(null);
                }}
                className="rounded-2xl border p-5 text-left transition-colors"
                style={{
                  borderColor: selected ? "var(--signal)" : "var(--m-rule)",
                  background: selected
                    ? "color-mix(in srgb, var(--signal) 7%, var(--m-surface))"
                    : "var(--m-surface)",
                }}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-1.5 rounded-full"
                    style={{ background: selected ? "var(--signal)" : "var(--m-rule)" }}
                  />
                  <span className="text-[15px] font-semibold text-ink">
                    {persona.tab}
                  </span>
                </span>
                <span className="num mt-2 block text-[11px] text-m-ink-3">
                  {persona.trade}
                </span>
                <span className="mt-2 block text-[13px] leading-relaxed text-m-ink-2">
                  {persona.blurb}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── The thread ─────────────────────────────────────────── */}
        <div className="mt-4 overflow-hidden rounded-2xl border border-m-rule bg-m-surface">
          <div className="flex items-center gap-3 border-b border-m-rule px-5 py-3">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-full text-[11px] font-bold"
              style={{ background: "var(--signal)", color: "#fff" }}
            >
              {active.businessName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold">{active.businessName}</p>
              <p className="num text-[10px] text-m-ink-3">
                {configured ? "assistant · live" : "assistant · offline"}
              </p>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={startOver}
                className="ml-auto rounded-full border border-m-rule px-3 py-1 text-[12px] text-m-ink-2 transition-colors hover:bg-m-surface-2"
              >
                Start over
              </button>
            )}
          </div>

          <div
            ref={logRef}
            aria-live="polite"
            aria-label={`Conversation with ${active.businessName}`}
            className="flex h-[22rem] flex-col gap-3 overflow-y-auto px-5 py-5"
          >
            {messages.length === 0 && !pending && (
              <p className="m-auto max-w-sm text-center text-[13px] leading-relaxed text-m-ink-3">
                Nothing said yet. Pick one below, or type your own — it will only know what this
                business wrote down.
              </p>
            )}

            {messages.map((message, i) =>
              message.role === "system" ? (
                <p
                  key={i}
                  className="mx-auto max-w-md rounded-xl border px-3 py-2 text-center text-[12px] leading-relaxed"
                  style={{
                    borderColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
                    color: "var(--warn)",
                  }}
                >
                  {message.text}
                </p>
              ) : message.role === "visitor" ? (
                <p
                  key={i}
                  className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-sm px-3.5 py-2 text-[13px] leading-snug text-white"
                  style={{ background: "var(--signal)" }}
                >
                  {message.text}
                </p>
              ) : (
                <div key={i} className="max-w-[85%] self-start">
                  <p className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-m-surface-2 px-3.5 py-2 text-[13px] leading-snug text-m-ink">
                    {message.text}
                  </p>
                  {message.tools.length > 0 && (
                    <p className="mt-1.5 flex flex-wrap gap-1.5">
                      {message.tools.map((tool) => (
                        <span
                          key={tool}
                          className="num rounded border border-m-rule px-1.5 py-0.5 text-[10px] text-m-ink-3"
                        >
                          {TOOL_LABELS[tool] ?? tool}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              ),
            )}

            {pending && (
              <p className="self-start rounded-xl rounded-bl-sm bg-m-surface-2 px-3.5 py-2 text-[11px] text-m-ink-3">
                thinking…
              </p>
            )}
          </div>

          {/* Suggested openers, while there is nothing to read. One of the three
              is always something the business hands over rather than answers —
              the refusal is the feature, so it should be one click away. */}
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2 border-t border-m-rule px-5 py-3">
              {active.starters.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  disabled={pending || !configured}
                  onClick={() => send(starter)}
                  className="rounded-full border border-m-rule bg-m-paper px-3 py-1.5 text-[12px] text-m-ink-2 transition-colors hover:bg-m-surface-2 disabled:opacity-50"
                >
                  {starter}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p
              className="border-t px-5 py-3 text-[12px] leading-relaxed"
              style={{
                borderColor: "var(--m-rule)",
                color: "var(--warn)",
                background: "color-mix(in srgb, var(--warn) 6%, transparent)",
              }}
            >
              {error}
            </p>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
            className="flex items-center gap-2 border-t border-m-rule px-3 py-3"
          >
            <label htmlFor="demo-message" className="sr-only">
              Message {active.businessName}
            </label>
            <input
              id="demo-message"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={500}
              autoComplete="off"
              disabled={pending || closed || !configured}
              placeholder={
                !configured
                  ? "The demo is offline on this deployment"
                  : closed
                    ? "Handed over — start over to keep going"
                    : `Message ${active.businessName}…`
              }
              className="min-w-0 flex-1 rounded-full border border-m-rule bg-m-paper px-4 py-2 text-[13px] text-m-ink outline-none placeholder:text-m-ink-3 focus-visible:border-signal disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={pending || closed || !configured || draft.trim().length === 0}
              className="shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-40"
              style={{ background: "var(--spark)", color: "var(--spark-ink)" }}
            >
              Send
            </button>
          </form>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-m-ink-3">
          Read-only: these three have no booking capability, so the assistant is handed no tool that
          writes. It will quote you a time and stop there.
        </p>
      </div>
    </section>
  );
}
