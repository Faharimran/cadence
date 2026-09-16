"use client";

import { useActionState, useState } from "react";
import {
  createLocation,
  createExceptionType,
  saveWhatsAppAccount,
  saveVoice,
  type SettingsFormState,
} from "./actions";
import { Button, Field, inputClass } from "../ui";

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

const textareaClass = `${inputClass} min-h-[6rem] resize-y font-sans leading-relaxed`;

/**
 * Ready-made ways for the assistant to write.
 *
 * Phrased as instructions to the assistant, not as labels, because the chosen
 * text goes into the prompt verbatim — "Formal" tells a model nothing, whereas
 * the sentence beneath it does. Picking one fills the box and leaves it
 * editable: most businesses want one of these with a clause of their own added,
 * and starting from a blank field is what leaves it blank.
 *
 * Deliberately vertical-neutral. A clinic and a barber both pick from the same
 * list; what makes them different is what they write in it afterwards.
 */
const TONE_PRESETS: { label: string; value: string }[] = [
  {
    label: "Warm and brief",
    value: "Write like a good receptionist texting: warm, brief, one idea per message.",
  },
  {
    label: "Friendly and casual",
    value:
      "Friendly and casual — first names, contractions, the way you'd talk to someone across the counter.",
  },
  {
    label: "Formal and precise",
    value:
      "Formal and precise. Full sentences, no slang or abbreviations, and address people as Mr or Ms unless they say otherwise.",
  },
  {
    label: "Calm and reassuring",
    value:
      "Calm and reassuring. Take the worry out of it, never rush anyone, and never promise how something will turn out.",
  },
  {
    label: "Short and efficient",
    value:
      "Short and efficient. Answer the question and stop — no pleasantries, no filler, no repeating the question back.",
  },
  {
    label: "Careful, never clinical",
    value:
      "Write carefully and plainly. Explain what happens, never give an opinion on what someone should have done, and hand anything technical to a person.",
  },
];

/**
 * Tone, as a pick-one-then-edit rather than a blank box.
 *
 * The textarea is the field that actually saves; the dropdown only writes into
 * it. That keeps a single source of truth — whatever is in the box is what the
 * assistant is told — and means an edited preset is just text, with no state to
 * reconcile about whether it is "still" a preset.
 */
function ToneField({ initial }: { initial: string }) {
  const [tone, setTone] = useState(initial);

  // Matched on exact text, so editing a preset simply shows "Custom" again.
  const selected = TONE_PRESETS.find((p) => p.value === tone)?.value ?? "";

  return (
    <div className="flex flex-col gap-2">
      <Field
        label="How it should write"
        hint="Pick a starting point and edit it, or write your own. Left blank, it writes like a brief, warm receptionist."
      >
        <select
          value={selected}
          onChange={(e) => setTone(e.target.value)}
          aria-label="Choose a starting point"
          className={inputClass}
        >
          <option value="">
            {tone.trim() ? "Custom — your own wording" : "Choose a starting point…"}
          </option>
          {TONE_PRESETS.map((p) => (
            <option key={p.label} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <textarea
        name="toneNote"
        value={tone}
        onChange={(e) => setTone(e.target.value)}
        rows={3}
        className={textareaClass}
        placeholder="Friendly and short, first names."
        aria-label="How it should write"
      />

      {tone.trim() && (
        <button
          type="button"
          onClick={() => setTone("")}
          className="self-start text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
        >
          clear
        </button>
      )}
    </div>
  );
}

export function VoiceForm({
  tenant,
}: {
  tenant: { name: string; descriptor: string | null; toneNote: string | null; escalationTopics: string[] };
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(saveVoice, null);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label={`What ${tenant.name} is`}
        hint="A sentence or two, as you'd describe it to someone new. The assistant is otherwise only told your name."
      >
        <textarea name="descriptor" defaultValue={tenant.descriptor ?? ""} className={textareaClass} />
      </Field>

      <ToneField initial={tenant.toneNote ?? ""} />

      <Field
        label="Always pass these to a person"
        hint="One per line, in your own words. The assistant hands over instead of answering — it never guesses at these."
      >
        <textarea
          name="escalationTopics"
          defaultValue={tenant.escalationTopics.join("\n")}
          className={textareaClass}
          placeholder={"anything about a refund\nwhether something is safe"}
        />
      </Field>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function LocationForm({ suggested }: { suggested: string }) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    createLocation,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name">
          <input name="name" required className={inputClass} placeholder="Santacruz" />
        </Field>
        <Field label="Short code" hint="Optional, used in references.">
          <input name="code" className={inputClass} placeholder="SCZ" />
        </Field>
        <Field label="Timezone" hint="IANA name — this one is never guessed.">
          <input name="timezone" required className={inputClass} defaultValue={suggested} />
        </Field>
      </div>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add location"}
      </Button>
    </form>
  );
}

export function ExceptionTypeForm() {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    createExceptionType,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name staff will see">
          <input name="label" required className={inputClass} placeholder="Study leave" />
        </Field>
        <Field label="Short code" hint="Lowercase, no spaces.">
          <input name="code" required className={inputClass} placeholder="study_leave" />
        </Field>
        <Field label="Effect" hint="The only two the engine understands.">
          <select name="effect" className={inputClass} defaultValue="subtract">
            <option value="subtract">Removes availability</option>
            <option value="add">Adds availability</option>
          </select>
        </Field>
        <Field label="Priority" hint="Higher wins when two overlap.">
          <input
            type="number"
            name="defaultPriority"
            min={0}
            max={1000}
            defaultValue={50}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label="If bookings already exist in that window"
        hint="Blocking is safer: it makes someone deal with the customers rather than stranding them."
      >
        <select name="onConflict" className={inputClass} defaultValue="block">
          <option value="block">Refuse, and list them</option>
          <option value="rebook">Accept, and flag them for rebooking</option>
        </select>
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requiresApproval" />
        Needs a manager to approve before it takes effect
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="publicVisible" className="mt-0.5" />
        <span>
          Customers may be told about this
          <span className="block text-[11px] text-ink-3">
            Off by default. Internal notes are never repeated — only the approved wording below.
          </span>
        </span>
      </label>

      <Field label="Exact wording customers hear">
        <input
          name="defaultPublicReason"
          className={inputClass}
          placeholder="We're closed that day."
        />
      </Field>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add type"}
      </Button>
    </form>
  );
}

export function WhatsAppForm({
  existing,
}: {
  existing: { externalAccountId: string; displayNumber: string | null; hasToken: boolean } | null;
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    saveWhatsAppAccount,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Editable after saving, deliberately. Meta shows the WhatsApp
            Business Account id right beside the phone number id, and picking
            the wrong one still passes verification — it only shows up later as
            messages that never arrive. Locking this field made that typo
            uncorrectable without touching the database. */}
        <Field
          label="Phone number ID"
          hint="From Meta's API Setup, under the From number. Not the WhatsApp Business Account ID beside it."
        >
          <input
            name="externalAccountId"
            required
            className={inputClass}
            defaultValue={existing?.externalAccountId ?? ""}
          />
        </Field>
        <Field label="Display number">
          <input
            name="displayNumber"
            className={inputClass}
            defaultValue={existing?.displayNumber ?? ""}
            placeholder="+44…"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Access token" hint={existing?.hasToken ? "Saved — blank keeps it." : undefined}>
          <input name="accessToken" type="password" className={inputClass} autoComplete="off" />
        </Field>
        <Field label="App secret" hint="Verifies inbound messages are genuinely from Meta.">
          <input name="appSecret" type="password" className={inputClass} autoComplete="off" />
        </Field>
        <Field label="Verify token" hint="Any string; paste the same one into Meta.">
          <input name="verifyToken" type="password" className={inputClass} autoComplete="off" />
        </Field>
      </div>

      <p className="text-[11px] text-ink-3">
        Stored encrypted, and never shown again once saved.
      </p>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
