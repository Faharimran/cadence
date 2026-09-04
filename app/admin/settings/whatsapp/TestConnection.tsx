"use client";

import { useActionState } from "react";
import { testWhatsAppConnection } from "../actions";
import { Button } from "../../ui";
import type { SettingsFormState } from "../actions";

/**
 * Checks the saved credentials against Meta, without sending anything.
 *
 * Exists because the common failure is silent: Meta's test-app tokens expire
 * after a day, and the symptom is customers not being answered while the
 * assistant carries on writing replies nobody receives. This turns a question
 * you can only answer from the server log into a button.
 */
export function TestConnection() {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    () => testWhatsAppConnection(),
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Check the connection"}
        </Button>
        <span className="text-[12px] text-ink-3">Asks WhatsApp. Sends nothing to anyone.</span>
      </div>

      {state?.ok && (
        <p role="status" className="text-sm" style={{ color: "var(--ok)" }}>
          {state.ok}
        </p>
      )}
      {state?.error && (
        <p role="alert" className="max-w-[70ch] text-sm" style={{ color: "var(--bad)" }}>
          {state.error}
        </p>
      )}
    </form>
  );
}
