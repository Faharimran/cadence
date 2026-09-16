"use client";

import { useActionState, useState } from "react";
import { signUp, type SignUpState } from "./actions";

const field =
  "input";

const label = "eyebrow";

export type PresetOption = { id: string; label: string; blurb: string };

/**
 * The preset choice is asked first and framed as "closest kind", because it is
 * not a commitment — it seeds some rows and is then never read again. Presenting
 * it as a category to be got right makes people hesitate over a decision that
 * does not matter.
 */
export function SignUpForm({
  presets,
  suggestedTimezone,
}: {
  presets: PresetOption[];
  suggestedTimezone: string;
}) {
  const [state, action, pending] = useActionState<SignUpState, FormData>(signUp, null);
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "other");

  return (
    <form action={action} className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-3">
        <legend className={`${label} mb-2`}>What kind of business?</legend>
        <p className="mb-1 text-sm text-ink-2">
          Only decides what you start with — the words for time off, a couple of services, some
          suggested tags. Change anything afterwards.
        </p>
        <div className="flex flex-col gap-2">
          {presets.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer gap-3 rounded-lg border px-4 py-3 ${
                presetId === p.id ? "border-accent bg-accent/5" : "border-rule bg-surface"
              }`}
            >
              <input
                type="radio"
                name="presetId"
                value={p.id}
                checked={presetId === p.id}
                onChange={() => setPresetId(p.id)}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{p.label}</span>
                <span className="text-[12px] leading-snug text-ink-2">{p.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className={`${label} mb-2`}>The business</legend>

        <label className="flex flex-col gap-1.5">
          <span className={label}>Name</span>
          <input name="businessName" required className={field} />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={label}>Timezone</span>
            <input name="timezone" required defaultValue={suggestedTimezone} className={field} />
            <span className="text-[11px] text-ink-3">
              Everything you book is worked out from this.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={label}>Currency</span>
            <input
              name="currency"
              required
              maxLength={3}
              placeholder="GBP"
              className={`${field} uppercase`}
            />
            <span className="text-[11px] text-ink-3">Three letters — GBP, INR, USD, AED.</span>
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className={`${label} mb-2`}>Your login</legend>

        <label className="flex flex-col gap-1.5">
          <span className={label}>Your name</span>
          <input name="name" className={field} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={label}>Email</span>
          <input name="email" type="email" autoComplete="username" required className={field} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={label}>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            className={field}
          />
          <span className="text-[11px] text-ink-3">At least 12 characters.</span>
        </label>
      </fieldset>

      {state?.error && (
        <p
          role="alert"
          className="txt-bad rounded-md border border-bad/40 px-3 py-2 text-sm"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary"
      >
        {pending ? "Setting up…" : "Create the business"}
      </button>
    </form>
  );
}
