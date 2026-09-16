"use client";

import { useActionState } from "react";
import { createException, type ExceptionFormState } from "./actions";

/**
 * A client component only because the form needs to show what came back — a
 * validation message, or the list of bookings that block a closure. A plain
 * server form cannot render a result.
 *
 * It still degrades: without JavaScript the form posts and the page re-renders;
 * only the inline feedback is lost.
 */

type Option = { id: string; label: string; hint?: string };

const field =
  "input";
const labelCls = "eyebrow";

export function ExceptionForm({
  types,
  locations,
  resources,
  categories,
  timezone,
}: {
  types: Option[];
  locations: Option[];
  resources: Option[];
  categories: string[];
  timezone: string;
}) {
  const [state, formAction, pending] = useActionState<ExceptionFormState, FormData>(
    createException,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>What</span>
          <select name="typeId" required className={field} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.hint ? ` ${t.hint}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Where</span>
          <select name="locationId" className={field} defaultValue="">
            <option value="">Every location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Who</span>
          <select name="resourceId" className={field} defaultValue="">
            <option value="">Everyone</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>From</span>
          <input type="datetime-local" name="startsAtLocal" required className={field} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Until</span>
          <input type="datetime-local" name="endsAtLocal" required className={field} />
          <span className="text-[11px] text-ink-3">Times are local to the location.</span>
        </label>

        {categories.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className={labelCls}>Only these services</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              {categories.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="serviceCategories" value={c} />
                  {c}
                </label>
              ))}
            </div>
            <span className="text-[11px] text-ink-3">Leave blank for everything.</span>
          </fieldset>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>Internal note</span>
          <input name="internalReason" className={field} placeholder="Only staff ever see this" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelCls}>What customers may be told</span>
          <input name="publicReason" className={field} placeholder="Most types ignore this" />
          <span className="text-[11px] text-ink-3">
            Saved only if the chosen type allows a customer-facing reason.
          </span>
        </label>
      </div>

      {state?.error && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-sm"
          style={{ borderColor: "color-mix(in srgb, var(--bad) 40%, transparent)" }}
        >
          <span className="txt-bad">{state.error}</span>

          {state.clashes && state.clashes.length > 0 && (
            <ul className="flex flex-col gap-1 font-mono text-[11px] text-ink-2">
              {state.clashes.map((c) => (
                <li key={c.id}>
                  {new Intl.DateTimeFormat("en-GB", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: timezone,
                  }).format(new Date(c.startsAt))}{" "}
                  — {c.who} · {c.what}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state?.ok && (
        <p role="status" className="txt-good text-sm">
          Recorded. Those times are no longer bookable.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary"
      >
        {pending ? "Recording…" : "Record it"}
      </button>
    </form>
  );
}
