"use client";

import { useActionState } from "react";
import {
  createLocation,
  createExceptionType,
  saveWhatsAppAccount,
  type SettingsFormState,
} from "./actions";
import { Button, Field, inputClass } from "../ui";

function Feedback({ state }: { state: SettingsFormState }) {
  if (state?.error)
    return (
      <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="text-sm" style={{ color: "var(--ok)" }}>
        {state.ok}
      </p>
    );
  return null;
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
        <Field label="Phone number ID" hint="From Meta. This is how inbound messages find you.">
          <input
            name="externalAccountId"
            required
            className={inputClass}
            defaultValue={existing?.externalAccountId ?? ""}
            readOnly={Boolean(existing)}
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

      <p
        className="rounded-md border px-3 py-2 text-[11px]"
        style={{ borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)", color: "var(--warn)" }}
      >
        These are stored unencrypted for now. Do not connect a production number until that is
        fixed.
      </p>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
