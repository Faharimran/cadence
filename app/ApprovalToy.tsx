"use client";

import { useState } from "react";

/**
 * The approval gate, as something a visitor can operate rather than read about.
 *
 * The static card this replaced drew three boxes labelled draft → read →
 * approved, which is the shape of the rule but not the feel of it. The feel is
 * the part that sells: you write an answer, the assistant refuses to say it,
 * you approve, and only then does it appear in the thread. Nobody believes that
 * from a diagram and everybody believes it after doing it once.
 *
 * The subtle behaviour is the one worth building for. Editing approved text
 * does NOT take the answer off the air — the last approved revision keeps
 * serving customers until someone signs the new one off. That is the rule in
 * AGENTS.md, it is the difference between a review queue and a kill switch, and
 * it is invisible in every competitor's screenshot. Here you can watch it: type
 * over an approved answer and the customer keeps getting the previous version,
 * with its version number, until you approve again.
 *
 * Nothing here calls the model. This is the lifecycle, not a conversation — the
 * live agent is the panel above, and conflating the two would let a visitor
 * think the refusal below was a model's judgement rather than a state machine.
 */

const QUESTION = "How long does recovery take?";

const STARTING_DRAFT =
  "Most people are back at a desk within three days. We'll go through what to expect at your consultation.";

/** What the assistant says when it has nothing approved to say. */
const NOT_KNOWN =
  "That's not something the clinic has written down — let me check and come back to you.";

type Live = { text: string; version: number };

export default function ApprovalToy() {
  const [draft, setDraft] = useState(STARTING_DRAFT);
  const [live, setLive] = useState<Live | null>(null);
  const [justApproved, setJustApproved] = useState(false);

  // Three states, and the middle one is the interesting one: an edit is
  // pending, and a customer is still being served the last signed-off text.
  const pending = live === null || draft.trim() !== live.text;
  const status: "draft" | "approved" = pending ? "draft" : "approved";
  const canApprove = draft.trim().length > 0 && pending;

  function approve() {
    if (!canApprove) return;
    setLive({ text: draft.trim(), version: (live?.version ?? 0) + 1 });
    setJustApproved(true);
    window.setTimeout(() => setJustApproved(false), 1400);
  }

  return (
    <div className="band-panel rounded-2xl p-6 sm:p-7">
      {/* ── The article ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <p className="eyebrow text-on-deep-3">
          Your knowledge base
        </p>
        <span
          className="eyebrow ml-auto rounded px-2 py-0.5"
          style={
            status === "approved"
              ? { color: "var(--spark)", border: "1px solid var(--spark)" }
              : {
                  color: "var(--warn)",
                  border: "1px solid color-mix(in srgb, var(--warn) 45%, transparent)",
                }
          }
        >
          {status}
        </span>
      </div>

      <label htmlFor="approval-body" className="mt-4 block font-display text-[15px] font-semibold">
        {QUESTION}
      </label>
      <p className="mt-1 text-[12px] text-on-deep-3">
        Edit this the way you would in the admin. It is your text — the assistant never rewrites it.
      </p>

      <textarea
        id="approval-body"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        maxLength={280}
        className="band-field mt-3 w-full resize-none rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed"
        placeholder="Write what this business would actually say…"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={approve}
          disabled={!canApprove}
          className="rounded-full px-4 py-1.5 text-[13px] font-semibold transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-40"
          style={{ background: "var(--spark)", color: "var(--spark-ink)" }}
        >
          {live === null ? "Approve" : `Approve as v${live.version + 1}`}
        </button>

        <p aria-live="polite" className="num text-[11px] text-on-deep-3">
          {justApproved
            ? "approved — the assistant can quote it now"
            : live === null
              ? "nothing approved yet"
              : pending
                ? `edit pending · customers still get v${live.version}`
                : `live · v${live.version}`}
        </p>
      </div>

      {/* ── What the customer gets, right now ───────────────────── */}
      <div className="band-rule mt-6 border-t pt-5">
        <p className="eyebrow text-on-deep-3">
          What a customer gets right now
        </p>

        <div className="mt-3 flex flex-col gap-2">
          <p
            className="max-w-[85%] self-end rounded-2xl rounded-br-sm px-3.5 py-2 text-[13px] leading-snug text-white"
            style={{ background: "var(--signal)" }}
          >
            {QUESTION.toLowerCase()}
          </p>

          {/* The whole argument of the section, in one bubble that changes. */}
          <div className="max-w-[90%] self-start">
            <p className="band-panel whitespace-pre-wrap rounded-xl rounded-bl-sm px-3.5 py-2 text-[13px] leading-snug text-on-deep">
              {live === null ? NOT_KNOWN : live.text}
            </p>
            <p className="num mt-1.5 text-[10px] text-on-deep-3">
              {live === null
                ? "answered from · nothing — it will not guess"
                : `answered from · “${QUESTION}” v${live.version}`}
            </p>
          </div>
        </div>

        {pending && live !== null && (
          <p
            className="mt-4 rounded-xl border px-3 py-2 text-[12px] leading-relaxed"
            style={{
              borderColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
              color: "var(--warn)",
            }}
          >
            Your edit is sitting in draft. Customers keep getting v{live.version} until you approve
            the new wording — an unread change never reaches anybody, and neither does a gap.
          </p>
        )}
      </div>
    </div>
  );
}
