"use client";

import { useRef } from "react";

/**
 * The reply box.
 *
 * A client component for two small things that matter a lot in an inbox: Enter
 * sends (Shift+Enter for a newline), and the box clears itself after sending
 * rather than leaving the text sitting there looking unsent.
 *
 * The warning above it is only shown while the assistant still owns the thread,
 * because that is the only time sending changes anything beyond the message —
 * once you have taken over, saying so again is noise.
 */
export function Composer({
  conversationId,
  action,
  botPaused,
}: {
  conversationId: string;
  action: (formData: FormData) => Promise<void>;
  botPaused: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={form}
      action={async (formData) => {
        await action(formData);
        form.current?.reset();
      }}
      className="flex flex-col gap-2 border-t border-rule px-5 py-3"
    >
      <input type="hidden" name="id" value={conversationId} />

      {!botPaused && (
        <p className="text-[11px] text-ink-3">
          Sending takes the thread over — two voices answering one customer is worse than a slow
          reply. The assistant will read what you wrote when you hand it back.
        </p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          name="body"
          required
          rows={2}
          placeholder="Reply as yourself…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              // requestSubmit, not submit: it runs validation and the React
              // action, where .submit() would bypass both.
              form.current?.requestSubmit();
            }
          }}
          className="min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-rule bg-surface px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-3/70 focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent/15"
        />
        <button
          type="submit"
          className="shrink-0 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Send
        </button>
      </div>
    </form>
  );
}
