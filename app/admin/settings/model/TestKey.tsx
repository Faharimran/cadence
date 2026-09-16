"use client";

import { useActionState } from "react";
import { testModelProvider, type SettingsFormState } from "../actions";
import { Button } from "../../ui";

/**
 * Asks the provider, before a customer does.
 *
 * Two questions in one request: does this key authenticate, and does this model
 * call tools. The second is the one worth a button — an endpoint that
 * authenticates but ignores tools produces an assistant that chats well and
 * cannot book, which reads as a bad model rather than an unfinished setup and
 * would otherwise be found by whoever tried to make an appointment.
 */
export function TestKey() {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    () => testModelProvider(),
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Check the key"}
        </Button>
        <span className="text-[12px] text-ink-3">
          One short request to your provider. Costs a fraction of a penny on your account.
        </span>
      </div>

      {state?.ok && (
        <p role="status" className="txt-good max-w-[70ch] text-sm">
          {state.ok}
        </p>
      )}
      {state?.error && (
        <p role="alert" className="txt-bad max-w-[70ch] text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
