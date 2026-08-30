"use client";

import { useEffect, useState } from "react";

/**
 * "Active" — the customer wrote in the last few minutes and is probably still
 * holding their phone.
 *
 * A client component because the answer is time-relative. Computed on the
 * server it would be correct at render and then frozen: a thread would stay
 * badged "active" for as long as the tab was open, which is worse than not
 * showing it at all.
 *
 * Five minutes rather than one: on a messaging app people put the phone down
 * mid-conversation and pick it up again, and a badge that flickers off between
 * two of someone's sentences reads as a bug.
 *
 * Keyed on the CUSTOMER's last message specifically. Our own outbound reply
 * says nothing about whether anyone is still at the other end, and that is the
 * only question this badge exists to answer.
 */
export const ACTIVE_WINDOW_MS = 5 * 60_000;

export function useIsLive(lastInboundAt: string | null): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!lastInboundAt) return false;
  return now - Date.parse(lastInboundAt) < ACTIVE_WINDOW_MS;
}

export function LiveBadge({ lastInboundAt }: { lastInboundAt: string | null }) {
  const live = useIsLive(lastInboundAt);
  if (!live) return null;

  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: "var(--ok)", background: "color-mix(in srgb, var(--ok) 14%, transparent)" }}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 animate-pulse rounded-full"
        style={{ background: "var(--ok)" }}
      />
      active
    </span>
  );
}
