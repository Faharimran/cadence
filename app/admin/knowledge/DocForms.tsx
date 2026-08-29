"use client";

import { useActionState, useState } from "react";
import { createDoc, updateDoc, type KnowledgeFormState } from "./actions";
import { Button, Field, inputClass } from "../ui";

function Feedback({ state }: { state: KnowledgeFormState }) {
  if (state?.error)
    return (
      <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="text-sm" style={{ color: "var(--ok)" }}>
        {state.ok}
      </p>
    );
  return null;
}

const textareaClass = `${inputClass} min-h-[11rem] resize-y font-sans leading-relaxed`;

/**
 * The hint text does real work here. Left to themselves people write articles
 * titled "PRP" and bodies that are internal notes; the assistant then matches
 * nothing and repeats things that were never meant for a customer. Asking for
 * the customer's own question as the title fixes both.
 */
export function NewDocForm() {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(createDoc, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Write an article
      </Button>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="Title" hint="Phrase it as a customer would ask it — “How long does recovery take?”">
        <input name="title" required className={inputClass} />
      </Field>

      <Field
        label="Answer"
        hint="Your words, as you'd say them at the front desk. The assistant quotes this; it never adds to it."
      >
        <textarea name="body" required className={textareaClass} />
      </Field>

      <Field label="Tags" hint="Optional, comma separated — preparing, aftercare, payment.">
        <input name="tags" className={inputClass} />
      </Field>

      <Feedback state={state} />

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save as draft"}
        </Button>
        <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
          cancel
        </Button>
      </div>
    </form>
  );
}

export function EditDocForm({
  doc,
}: {
  doc: { id: string; title: string; body: string; tags: string[]; status: string };
}) {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(updateDoc, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
        edit
      </Button>
    );
  }

  return (
    <form action={action} className="mt-3 flex w-full flex-col gap-4 border-t border-rule pt-4">
      <input type="hidden" name="id" value={doc.id} />

      <Field label="Title">
        <input name="title" required defaultValue={doc.title} className={inputClass} />
      </Field>

      <Field label="Answer">
        <textarea name="body" required defaultValue={doc.body} className={textareaClass} />
      </Field>

      <Field label="Tags" hint="Comma separated.">
        <input name="tags" defaultValue={doc.tags.join(", ")} className={inputClass} />
      </Field>

      {doc.status === "approved" && (
        <p className="text-[11px] text-ink-3">
          This article is live. Saving returns it to draft — customers keep getting the approved
          version until you approve the new one.
        </p>
      )}

      <Feedback state={state} />

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
          cancel
        </Button>
      </div>
    </form>
  );
}
