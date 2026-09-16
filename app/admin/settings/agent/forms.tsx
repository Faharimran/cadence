"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { saveAgent, type SettingsFormState } from "../actions";
import { Button, Field, inputClass, labelClass } from "../../ui";
import { MODELS, EFFORTS, DEFAULT_MODEL, DEFAULT_EFFORT } from "@/lib/conversation/models";

const textareaClass = `${inputClass} resize-y font-sans leading-relaxed`;

function Feedback({ state }: { state: SettingsFormState }) {
  if (state?.error)
    return (
      <p role="alert" className="txt-bad text-sm">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="txt-good text-sm">
        {state.ok}
      </p>
    );
  return null;
}

/**
 * A radio group that shows the trade-off rather than only the name.
 *
 * Presented as cards instead of a `<select>` because these choices cost money
 * per message and differ in ways a label cannot carry. "Balanced" tells someone
 * running a barber shop nothing; the sentence under it tells them whether to
 * pick it.
 */
function ChoiceCards({
  name,
  options,
  initial,
}: {
  name: string;
  options: readonly { id: string; label: string; blurb: string }[];
  initial: string;
}) {
  const [value, setValue] = useState(initial);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {options.map((o) => {
        const active = value === o.id;
        return (
          <label
            key={o.id}
            className={`flex cursor-pointer flex-col gap-1.5 rounded-2xl border p-4 transition-colors ${
              active ? "border-accent bg-accent/5" : "border-rule hover:border-ink-3"
            }`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={o.id}
                checked={active}
                onChange={() => setValue(o.id)}
                className="accent-[var(--accent)]"
              />
              <span className="text-sm font-semibold">{o.label}</span>
            </span>
            <span className="text-[12px] leading-relaxed text-ink-2">{o.blurb}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * What these instructions cost, said while they are being written.
 *
 * Every character here is re-sent on every message, forever. Cara's brief grew
 * to 5,800 characters — forty per cent of the entire prompt, more than the whole
 * knowledge corpus — and nothing on this page gave any hint of that. An
 * invisible recurring cost is one nobody can weigh against the benefit.
 *
 * Not a limit and not a warning to obey. Long instructions are often exactly
 * right; the point is only that the trade should be made knowingly.
 */
function InstructionCost({ chars }: { chars: number }) {
  if (chars === 0) return null;

  // ~3.5 chars per token for English prose. Deliberately approximate — precision
  // here would need a tokeniser round trip on every keystroke to tell somebody
  // something a rough figure already tells them.
  const tokens = Math.round(chars / 3.5);
  const heavy = chars > 3000;

  return (
    <p className="text-[11px] text-ink-3">
      About {tokens.toLocaleString()} tokens, re-sent with every message.
      {heavy && (
        <span className="txt-warn">
          {" "}
          That is a large share of what the assistant reads each time — worth keeping if you need
          it, worth trimming if any of it has stopped being true.
        </span>
      )}
    </p>
  );
}

export function AgentForm({
  tenant,
  byo,
}: {
  tenant: {
    name: string;
    agentInstructions: string | null;
    agentModel: string | null;
    agentEffort: string | null;
  };
  /**
   * Set when this business answers on its own key.
   *
   * The cards below choose from the models cadence pays for, which is not what
   * is running when someone has brought their own — showing them anyway would
   * mean a page that says "Balanced" while every message goes to DeepSeek. The
   * saved values are still submitted, so switching back next month finds the
   * choice exactly where it was left.
   */
  byo: { vendorLabel: string; model: string } | null;
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(saveAgent, null);
  const [instructions, setInstructions] = useState(tenant.agentInstructions ?? "");

  return (
    <form action={action} className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Field
          label={`Your instructions to the assistant`}
          hint="Written in your own words, and followed as written. This is the part of the prompt that is yours."
        >
          <textarea
            name="agentInstructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={14}
            className={`${textareaClass} min-h-[18rem]`}
            placeholder={`Always ask which branch they mean before offering times — we have three and they're a long way apart.

If someone asks about parking, it's the multi-storey behind us, free for the first two hours with a ticket from reception.

Don't offer Saturday mornings to new customers; those are for regulars.

If they mention they're coming for a wedding, say congratulations.`}
          />
        </Field>
        <InstructionCost chars={instructions.trim().length} />
        <p className="max-w-[70ch] text-[12px] leading-relaxed text-ink-3">
          Anything you write here is treated as a house rule and followed. What it cannot do is
          switch off the handful of rules underneath it — quoting prices only from your catalogue,
          giving times in the right timezone, and never claiming a slot has gone when it hasn&apos;t.
          Those are the ones that go wrong quietly, so they stay on.
        </p>
      </div>

      {byo ? (
        <div className="flex flex-col gap-3">
          <span className={labelClass}>Which model answers</span>
          <div className="rounded-2xl border border-rule bg-surface-2 p-4">
            <p className="text-sm text-ink-2">
              Your own {byo.vendorLabel} key, running{" "}
              <span className="font-mono text-[12px] text-ink">{byo.model}</span>. Change it on{" "}
              <Link
                href="/admin/settings/model"
                className="underline underline-offset-2 hover:text-ink"
              >
                which API key answers
              </Link>
              .
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              The model and effort you picked for cadence&apos;s key are kept as they are, for if
              you switch back.
            </p>
          </div>
          {/* Submitted but not shown. Dropping them would make saving these
              instructions silently reset a model choice nobody touched. */}
          <input type="hidden" name="agentModel" value={tenant.agentModel ?? DEFAULT_MODEL} />
          <input type="hidden" name="agentEffort" value={tenant.agentEffort ?? DEFAULT_EFFORT} />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <span className={labelClass}>Which model answers</span>
            <ChoiceCards
              name="agentModel"
              options={MODELS}
              initial={tenant.agentModel ?? DEFAULT_MODEL}
            />
          </div>

          <div className="flex flex-col gap-3">
            <span className={labelClass}>How carefully it thinks</span>
            <ChoiceCards
              name="agentEffort"
              options={EFFORTS}
              initial={tenant.agentEffort ?? DEFAULT_EFFORT}
            />
            <p className="max-w-[70ch] text-[12px] leading-relaxed text-ink-3">
              This is the setting that most affects what you pay per message. If your customers
              mainly ask simple questions, Quick is genuinely enough. Ignored by the fastest model,
              which has one speed.
            </p>
          </div>
        </>
      )}

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}
