"use client";

import { useActionState } from "react";
import { previewSheet, saveLink, type ImportFormState } from "./actions";
import { Button, Field, inputClass, labelClass } from "../../ui";
import { KINDS, fieldsFor } from "@/lib/imports/fields";

function Feedback({ state }: { state: ImportFormState }) {
  if (state && "error" in state && state.error)
    return (
      <p role="alert" className="max-w-[70ch] text-sm" style={{ color: "var(--bad)" }}>
        {state.error}
      </p>
    );
  if (state && "ok" in state && state.ok)
    return (
      <p role="status" className="text-sm" style={{ color: "var(--ok)" }}>
        {state.ok}
      </p>
    );
  return null;
}

/**
 * Step one: point at a sheet.
 *
 * The sharing instruction sits here rather than in a help page, because being
 * unable to read the sheet is the single most likely outcome of this form and
 * the fix takes ten seconds if you know it.
 */
export function ConnectForm() {
  const [state, action, pending] = useActionState<ImportFormState, FormData>(previewSheet, null);
  const preview = state && "preview" in state ? state.preview : null;

  if (preview) return <MappingForm preview={preview} />;

  return (
    <form action={action} className="flex flex-col gap-5">
      <Field
        label="Link to your spreadsheet"
        hint="Open the sheet in Google Sheets and copy the address from your browser."
      >
        <input
          name="sourceUrl"
          required
          className={inputClass}
          placeholder="https://docs.google.com/spreadsheets/d/…"
        />
      </Field>

      <Field label="What is in this sheet?" hint="One kind per sheet. If your workbook has services on one tab and customers on another, connect each tab separately.">
        <select name="kind" className={inputClass} defaultValue="services">
          {Object.entries(KINDS).map(([key, k]) => (
            <option key={key} value={key}>
              {k.label} — {k.blurb}
            </option>
          ))}
        </select>
      </Field>

      <div className="rounded-2xl border border-line bg-surface-2 p-4">
        <p className={labelClass}>Before you paste it</p>
        <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-ink-2">
          In Google Sheets press <strong>Share</strong>, then under <em>General access</em> choose{" "}
          <strong>Anyone with the link</strong> as <strong>Viewer</strong>. We only ever read it,
          and nobody can find the link unless you give it to them. Without this, Google shows us a
          sign-in page instead of your sheet.
        </p>
      </div>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Reading the sheet…" : "Read the sheet"}
      </Button>
    </form>
  );
}

/**
 * Step two: agree what each column is.
 *
 * Shows the owner's own first rows above the dropdowns. A mapping screen with
 * only column names is a puzzle; the same screen with "Ladies cut and finish"
 * and "£45" next to it is obvious, and obvious is what stops someone confirming
 * a price column that is actually a tax rate.
 */
function MappingForm({
  preview,
}: {
  preview: Extract<ImportFormState, { preview: unknown }>["preview"];
}) {
  const [state, action, pending] = useActionState<ImportFormState, FormData>(saveLink, null);
  const fields = fieldsFor(preview.kind);
  const uncertainBy = new Map(preview.uncertain.map((u) => [u.header, u]));

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="sourceUrl" value={preview.sourceUrl} />
      <input type="hidden" name="kind" value={preview.kind} />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold">
          {preview.rowCount.toLocaleString()} rows, {preview.headers.length} columns
        </span>
        <span className="font-mono text-[11px] text-ink-3">
          {preview.source === "model"
            ? "columns matched automatically — check them below"
            : "matched on column names — check them below"}
        </span>
      </div>

      {preview.missing.length > 0 && (
        <p
          className="max-w-[70ch] rounded-xl border px-3 py-2 text-[13px]"
          style={{
            borderColor: "color-mix(in srgb, var(--bad) 35%, transparent)",
            background: "color-mix(in srgb, var(--bad) 8%, transparent)",
            color: "var(--bad)",
          }}
        >
          We could not find a column for{" "}
          {preview.missing
            .map((m) => fields.find((f) => f.key === m)?.label.toLowerCase() ?? m)
            .join(" or ")}
          . Set it below — without it, rows cannot be imported.
        </p>
      )}

      {/* Their own data, above the controls. */}
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[40rem] border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              {preview.headers.map((h) => (
                <th key={h} className="px-3 py-2 font-mono text-[11px] font-semibold text-ink-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.sample.map((row, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {preview.headers.map((h) => (
                  <td key={h} className="whitespace-nowrap px-3 py-2 text-ink-2">
                    {row[h] || <span className="text-ink-3">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {preview.headers.map((header) => {
          const doubt = uncertainBy.get(header);
          return (
            <div key={header} className="flex flex-col gap-1.5">
              <label className={labelClass} htmlFor={`map:${header}`}>
                {header}
              </label>
              <select
                id={`map:${header}`}
                name={`map:${header}`}
                defaultValue={preview.mapping[header] ?? "ignore"}
                className={inputClass}
                style={
                  doubt
                    ? { borderColor: "color-mix(in srgb, var(--warn) 55%, transparent)" }
                    : undefined
                }
              >
                <option value="ignore">Don&apos;t import this column</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                    {f.required ? " (required)" : ""}
                  </option>
                ))}
              </select>
              {doubt && (
                <span className="text-[11px]" style={{ color: "var(--warn)" }}>
                  {doubt.note}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="removeMissing" className="mt-0.5" />
        <span>
          Stop offering anything that disappears from this sheet
          <span className="block text-[11px] text-ink-3">
            Off by default. With it on, deleting a row here retires that service. A filtered view
            or a half-loaded sheet would do the same, which is why it is not the default.
          </span>
        </span>
      </label>

      <Feedback state={state} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Importing…" : "Import now and keep it in sync"}
        </Button>
        <span className="text-[12px] text-ink-3">
          Applies straight away. You can undo it afterwards.
        </span>
      </div>
    </form>
  );
}
