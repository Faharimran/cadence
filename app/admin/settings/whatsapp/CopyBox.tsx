"use client";

import { useState } from "react";

/**
 * A value to copy, with a button that says whether it worked.
 *
 * Every one of these is a string that has to arrive at Meta character-perfect —
 * a webhook URL, a verify token. Retyping them is where non-technical people
 * lose an afternoon, so the guide never asks anyone to.
 *
 * The fallback matters more than it looks: `navigator.clipboard` needs a secure
 * context, and this app is routinely opened over plain http on localhost during
 * setup. Without the fallback the button would silently do nothing on exactly
 * the machine where it is most needed.
 */
export function CopyBox({ label, value }: { label?: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2200);
  }

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <span className="eyebrow">{label}</span>
      )}
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-rule bg-surface-2 px-3 py-2 font-mono text-[12px]">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-xl border border-rule bg-surface px-3 py-2 text-[12px] font-medium transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}
        </button>
      </div>
      {state === "failed" && (
        <span className="text-[11px] text-ink-3">
          Your browser blocked the copy — select the text above and copy it by hand.
        </span>
      )}
    </div>
  );
}
