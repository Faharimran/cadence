"use client";

import { useActionState } from "react";
import { addScheduleRule, type ScheduleFormState } from "./actions";
import { Button, Field, inputClass, labelClass, WEEKDAY_OPTIONS } from "../ui";

export function ScheduleForm({
  resources,
  locations,
}: {
  resources: { id: string; name: string }[];
  locations: { id: string; name: string; timezone: string }[];
}) {
  const [state, formAction, pending] = useActionState<ScheduleFormState, FormData>(
    addScheduleRule,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Who">
          <select name="resourceId" required className={inputClass} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Where" hint="Times below are local to this location.">
          <select name="locationId" required className={inputClass} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} — {l.timezone}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Opens">
          <input type="time" name="startTime" required defaultValue="09:00" className={inputClass} />
        </Field>

        <Field label="Closes">
          <input type="time" name="endTime" required defaultValue="17:00" className={inputClass} />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={labelClass}>Which days</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
          {WEEKDAY_OPTIONS.map((d) => (
            <label key={d.value} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name="weekdays"
                value={d.value}
                defaultChecked={d.value >= 1 && d.value <= 5}
              />
              {d.label.slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        label="Appointment slots every"
        hint="The grid customers are offered — 30 means 09:00, 09:30, 10:00…"
      >
        <select name="slotMinutes" className={inputClass} defaultValue="30">
          {[10, 15, 20, 30, 45, 60].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </Field>

      {state?.error && (
        <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-sm" style={{ color: "var(--ok)" }}>
          {state.ok}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save hours"}
      </Button>
    </form>
  );
}
