"use client";

import { useActionState, useState } from "react";
import { forgetModelProvider, saveModelProvider, type SettingsFormState } from "../actions";
import { Button, Field, inputClass } from "../../ui";

/**
 * Whose key answers customers.
 *
 * The vendor list arrives as props rather than being imported here. It lives in
 * lib/conversation/providers.ts, which reads the environment — importing it into
 * a client component would drag server configuration into the browser bundle,
 * where it would either leak or fail to parse. Props are the boundary.
 */
export type VendorOption = {
  id: string;
  label: string;
  protocol: "anthropic" | "openai";
  baseUrl: string | null;
  keySource: string;
  exampleModels: string[];
  customBaseUrl?: boolean;
  note?: string;
};

export type CurrentProvider = {
  vendor: string;
  vendorLabel: string;
  baseUrl: string | null;
  model: string;
  active: boolean;
  keyHint: string;
} | null;

function Feedback({ state }: { state: SettingsFormState }) {
  if (state?.error)
    return (
      <p role="alert" className="txt-bad max-w-[70ch] text-sm">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="txt-good max-w-[70ch] text-sm">
        {state.ok}
      </p>
    );
  return null;
}

export function ProviderForm({
  vendors,
  current,
  cadenceModelLabel,
}: {
  vendors: VendorOption[];
  current: CurrentProvider;
  /** What cadence's own key would run, so the choice is a comparison. */
  cadenceModelLabel: string;
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    saveModelProvider,
    null,
  );

  const [source, setSource] = useState<"cadence" | "own">(current?.active ? "own" : "cadence");
  const [vendorId, setVendorId] = useState(current?.vendor ?? vendors[0]?.id ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [model, setModel] = useState(current?.model ?? "");

  const vendor = vendors.find((v) => v.id === vendorId) ?? vendors[0];
  const hasSavedKey = Boolean(current);

  return (
    <form action={action} className="flex flex-col gap-8">
      <div className="grid gap-3 sm:grid-cols-2">
        <SourceCard
          checked={source === "cadence"}
          onSelect={() => setSource("cadence")}
          value="cadence"
          title="cadence's key"
          blurb={`Nothing to set up. Answers run on the model you picked — ${cadenceModelLabel.toLowerCase()} — billed as part of what you pay us.`}
        />
        <SourceCard
          checked={source === "own"}
          onSelect={() => setSource("own")}
          value="own"
          title="Your own key"
          blurb="Claude, DeepSeek, OpenAI, or any endpoint you already pay for. Usage is billed to that account, not to us."
        />
      </div>

      {source === "own" && (
        <div className="flex flex-col gap-6 rounded-2xl border border-rule bg-surface-2 p-5">
          <Field label="Who provides the model" hint={vendor?.note ?? vendor?.keySource}>
            <select
              name="vendor"
              value={vendorId}
              onChange={(e) => {
                const next = vendors.find((v) => v.id === e.target.value);
                setVendorId(e.target.value);
                // Preset addresses are ours to fill in; only "anything else"
                // asks for one, and clearing it when switching away stops a
                // stale URL being saved against a vendor that has its own.
                setBaseUrl(next?.customBaseUrl ? baseUrl : (next?.baseUrl ?? ""));
              }}
              className={inputClass}
            >
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>

          {vendor?.customBaseUrl ? (
            <Field
              label="Address of the API"
              hint="Anything that answers OpenAI's chat-completions shape. Ends in /v1 on most providers."
            >
              <input
                name="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
          ) : (
            <>
              <input type="hidden" name="baseUrl" value={vendor?.baseUrl ?? ""} />
              {vendor?.baseUrl && (
                <p className="num text-[11px] text-ink-3">sends to {vendor.baseUrl}</p>
              )}
            </>
          )}

          <Field
            label="API key"
            hint={
              hasSavedKey
                ? `A key ending ${current?.keyHint} is saved. Leave this blank to keep it.`
                : `From ${vendor?.keySource}. Stored encrypted, and never shown again.`
            }
          >
            <input
              name="apiKey"
              type="password"
              placeholder={hasSavedKey ? "•••••••••• (unchanged)" : "Paste the key"}
              className={`${inputClass} font-mono`}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Which model"
            hint={
              vendor && vendor.exampleModels.length > 0
                ? `For example ${vendor.exampleModels.join(", ")}. Exactly as your provider writes it.`
                : "Exactly as your provider writes it."
            }
          >
            <input
              name="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="model-suggestions"
              placeholder={vendor?.exampleModels[0] ?? "model-id"}
              className={`${inputClass} font-mono`}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <datalist id="model-suggestions">
            {(vendor?.exampleModels ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

          {/* The thing that actually decides whether this works, said before
              they save rather than after a customer cannot book. */}
          <p className="max-w-[70ch] text-[12px] leading-relaxed text-ink-3">
            The model must support tool calling — that is how the assistant checks availability and
            books. Most current models do; the smallest and oldest ones do not, and a model that
            ignores tools will chat pleasantly and never book anything. The check below tells you
            which you have.
          </p>
        </div>
      )}

      {/* The one field that is always submitted. Everything else belongs to the
          "own key" branch and is absent when that branch is not shown, which the
          server reads as empty rather than as missing. */}
      <input type="hidden" name="source" value={source} />

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

function SourceCard({
  checked,
  onSelect,
  value,
  title,
  blurb,
}: {
  checked: boolean;
  onSelect: () => void;
  value: string;
  title: string;
  blurb: string;
}) {
  return (
    <label
      className={`flex cursor-pointer flex-col gap-1.5 rounded-2xl border p-4 transition-colors ${
        checked ? "border-accent bg-accent/5" : "border-rule hover:border-ink-3"
      }`}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="sourceChoice"
          value={value}
          checked={checked}
          onChange={onSelect}
          className="accent-[var(--accent)]"
        />
        <span className="text-sm font-semibold">{title}</span>
      </span>
      <span className="text-[12px] leading-relaxed text-ink-2">{blurb}</span>
    </label>
  );
}

/**
 * Removing the key, kept away from the form above.
 *
 * Switching back to cadence's key does not delete anything — this does, and it
 * is the only thing here that cannot be undone by clicking the other card.
 */
export function ForgetKey() {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(
    () => forgetModelProvider(),
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Removing…" : "Remove the saved key"}
        </Button>
        <span className="text-[12px] text-ink-3">
          Deletes it from cadence. Customers are answered on our key from the next message.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}
