"use client";

import { useActionState } from "react";
import { createKey, createEndpoint, type IntegrationFormState } from "./actions";
import { Button, Field, inputClass, labelClass } from "../ui";

/**
 * Shown once, and said so plainly.
 *
 * A secret rendered in the same grey as everything else gets closed without
 * being copied, and the next thing that happens is a support message.
 */
function ShownOnce({ value }: { value: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--warn)" }}>
        Copy this now — it is not shown again
      </span>
      <code className="overflow-x-auto whitespace-nowrap rounded bg-surface-2 px-3 py-2 font-mono text-xs">
        {value}
      </code>
    </div>
  );
}

function Feedback({ state }: { state: IntegrationFormState }) {
  return (
    <>
      {state?.error && (
        <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>
          {state.error}
        </p>
      )}
      {state?.ok && !state.secret && (
        <p role="status" className="text-sm" style={{ color: "var(--ok)" }}>
          {state.ok}
        </p>
      )}
      {state?.secret && <ShownOnce value={state.secret} />}
    </>
  );
}

export function ApiKeyForm() {
  const [state, action, pending] = useActionState<IntegrationFormState, FormData>(
    createKey,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What is it for" hint="So you know what you are revoking later.">
          <input name="name" required className={inputClass} placeholder="Cara CRM — production" />
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className={labelClass}>Allowed to</legend>
          <div className="flex gap-4 pt-1">
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="scopes" value="read" defaultChecked />
              read
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="scopes" value="write" defaultChecked />
              write
            </label>
          </div>
        </fieldset>
      </div>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create key"}
      </Button>
    </form>
  );
}

export function EndpointForm({ events }: { events: readonly string[] }) {
  const [state, action, pending] = useActionState<IntegrationFormState, FormData>(
    createEndpoint,
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="Where should we POST"
        hint="Must be https. We sign every request; verify it before trusting the body."
      >
        <input
          name="url"
          type="url"
          required
          className={inputClass}
          placeholder="https://your-crm.example.com/hooks/cadence"
        />
      </Field>

      <fieldset className="flex flex-col gap-1.5">
        <legend className={labelClass}>Which events</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
          {events.map((e) => (
            <label key={e} className="flex items-center gap-1.5 font-mono text-xs">
              <input type="checkbox" name="events" value={e} />
              {e}
            </label>
          ))}
        </div>
        <span className="text-[11px] text-ink-3">Tick none to receive everything.</span>
      </fieldset>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add endpoint"}
      </Button>
    </form>
  );
}
