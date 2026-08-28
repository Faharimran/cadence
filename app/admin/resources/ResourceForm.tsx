"use client";

import { useActionState } from "react";
import { createResource, type ResourceFormState } from "./actions";
import { Button, Field, inputClass, labelClass } from "../ui";

export function ResourceForm({
  locations,
}: {
  locations: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<ResourceFormState, FormData>(
    createResource,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name">
          <input name="name" required className={inputClass} placeholder="Alex, Suite 1, Laser…" />
        </Field>

        <Field label="Kind">
          <select name="kind" className={inputClass} defaultValue="person">
            <option value="person">A person</option>
            <option value="room">A room</option>
            <option value="equipment">Equipment</option>
          </select>
        </Field>

        <Field
          label="Skills / labels"
          hint="Comma separated. Services ask for these by name."
        >
          <input name="tags" className={inputClass} placeholder="Senior, Cut" />
        </Field>
      </div>

      {locations.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className={labelClass}>Works at</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="locationIds" value={l.id} defaultChecked />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

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
        {pending ? "Adding…" : "Add"}
      </Button>
    </form>
  );
}
