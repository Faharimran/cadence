"use client";

import { useActionState } from "react";
import { createService, type ServiceFormState } from "./actions";
import { Button, Field, inputClass } from "../ui";

export function ServiceForm({ currency }: { currency: string }) {
  const [state, formAction, pending] = useActionState<ServiceFormState, FormData>(
    createService,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <input name="name" required className={inputClass} placeholder="Consultation" />
        </Field>
        <Field label="Category" hint="Used to scope closures to some services only.">
          <input name="category" className={inputClass} placeholder="consult" />
        </Field>
        <Field label="Takes">
          <input
            type="number"
            name="durationMinutes"
            required
            min={5}
            max={1440}
            defaultValue={30}
            className={inputClass}
          />
        </Field>
        <Field label={`Price (${currency})`} hint="Leave blank for price on request.">
          <input name="price" className={inputClass} placeholder="250" inputMode="decimal" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Prep before" hint="Blocks the resource beforehand.">
          <input
            type="number"
            name="bufferBeforeMinutes"
            min={0}
            max={240}
            defaultValue={0}
            className={inputClass}
          />
        </Field>
        <Field label="Turnover after" hint="Cleaning, notes, reset.">
          <input
            type="number"
            name="bufferAfterMinutes"
            min={0}
            max={240}
            defaultValue={0}
            className={inputClass}
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-md border border-rule p-4">
        <legend className="eyebrow px-1">
          What it needs
        </legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Skills" hint="Comma separated; must match a person or room.">
            <input name="requirementTags" className={inputClass} placeholder="Senior" />
          </Field>
          <Field label="Kind">
            <select name="requirementKind" className={inputClass} defaultValue="any">
              <option value="any">Anything</option>
              <option value="person">A person</option>
              <option value="room">A room</option>
              <option value="equipment">Equipment</option>
            </select>
          </Field>
          <Field label="How many">
            <input
              type="number"
              name="requirementQuantity"
              min={1}
              max={10}
              defaultValue={1}
              className={inputClass}
            />
          </Field>
        </div>
        <p className="text-[11px] text-ink-3">
          Add more requirements after creating it — a session needing a stylist <em>and</em> a
          room is two.
        </p>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="priceQuotable" defaultChecked className="mt-0.5" />
        <span>
          The assistant may tell customers this price.
          <span className="block text-[11px] text-ink-3">
            Unticked, the figure is never given to the assistant at all — it will say the team
            will confirm.
          </span>
        </span>
      </label>

      {state?.error && (
        <p role="alert" className="txt-bad text-sm">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="txt-good text-sm">
          {state.ok}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add service"}
      </Button>
    </form>
  );
}
