"use client";

import { useActionState, useState } from "react";
import {
  addWebsiteSource,
  createDoc,
  updateDoc,
  uploadSource,
  type KnowledgeFormState,
} from "./actions";
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
 * The copy here is doing safety work, not marketing.
 *
 * Someone uploading a company deck needs to know two things before they choose
 * the file: nothing goes live unread, and the assistant will only ever repeat
 * what they approve. Told afterwards, on a review screen, it is too late — they
 * have already uploaded the deck with the margin table in it.
 */
export function UploadForm() {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(uploadSource, null);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="PDF"
        hint="A company profile, a brochure, a policy document, a price list. Up to 15 MB."
      >
        <input
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1 file:text-sm file:text-white`}
        />
      </Field>

      <p className="max-w-[66ch] text-[11px] leading-relaxed text-ink-3">
        We&apos;ll read it, split it into answers, and title each one with the question a customer
        would ask. Everything arrives as a <strong>draft</strong> — the assistant cannot see any of
        it until you approve it. Company documents often carry internal pricing and staff notes, so
        read before you approve.
      </p>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Uploading…" : "Upload and read it"}
      </Button>
    </form>
  );
}

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

/**
 * Reading the business's own website.
 *
 * Placed alongside the PDF upload rather than behind a separate page, because
 * from the owner's side these are one question — "how does it learn about us?" —
 * and the answer happens to have two doors.
 *
 * The crawl bounds are stated up front. "It reads your website" invites someone
 * to paste a URL and expect all four hundred pages of a blog; twenty-five is
 * generous for a small business site and honest about the rest.
 */
export function WebsiteForm() {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(
    addWebsiteSource,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="Your website"
        hint="The address customers visit. We follow links within the site — not links away from it."
      >
        <input
          name="url"
          required
          inputMode="url"
          className={inputClass}
          placeholder="https://yourbusiness.com"
        />
      </Field>

      <p className="max-w-[66ch] text-[11px] leading-relaxed text-ink-3">
        We read up to <strong>25 pages</strong>, two links deep, skipping anything the site asks
        automated readers not to touch. Menus, cookie banners and footers are stripped out, so what
        arrives is the writing rather than the furniture. Everything lands as a{" "}
        <strong>draft</strong> — the assistant sees none of it until you approve it.
      </p>
      <p className="max-w-[66ch] text-[11px] leading-relaxed text-ink-3">
        Pages built entirely in JavaScript cannot be read this way. If your site is one of those,
        upload a brochure or price list instead.
      </p>

      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Starting…" : "Read my website"}
      </Button>
    </form>
  );
}
