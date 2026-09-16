"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LiveBadge } from "./LiveBadge";

export type ThreadSummary = {
  id: string;
  name: string;
  channel: string;
  botPaused: boolean;
  optedOut: boolean;
  lastInboundAt: string | null;
  updatedAt: string;
  preview: string | null;
};

/** How often the list re-reads from the server. */
const REFRESH_MS = 15_000;

export function ThreadList({
  threads,
  timezone,
}: {
  threads: ThreadSummary[];
  timezone: string;
}) {
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const selected = params?.id;
  const [query, setQuery] = useState("");

  // "Active" is time-relative, so it goes stale just sitting there. A periodic
  // refresh keeps the badges honest and pulls in new messages without anyone
  // reaching for F5. Cheap: one server render of a list that is already cached.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  // Drives the relative timestamps. Liveness itself is LiveBadge's business —
  // one definition of "active", used by both panes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? threads.filter(
        (t) =>
          t.name.toLowerCase().includes(needle) ||
          (t.preview ?? "").toLowerCase().includes(needle),
      )
    : threads;

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-rule bg-surface">
      <div className="border-b border-rule p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or message"
          aria-label="Search conversations"
          className="input"
        />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <li className="p-4 text-sm text-ink-2">
            {threads.length === 0 ? "Nobody has messaged yet." : "Nothing matches that."}
          </li>
        )}

        {visible.map((t) => {
          const current = t.id === selected;

          return (
            <li key={t.id}>
              <Link
                href={`/admin/conversations/${t.id}`}
                aria-current={current ? "page" : undefined}
                className={`flex flex-col gap-1 border-b border-rule/60 px-4 py-3 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  current ? "bg-accent/10" : "hover:bg-surface-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{t.name}</span>

                  <LiveBadge lastInboundAt={t.lastInboundAt} />

                  <span className="num ml-auto shrink-0 text-[10px] text-ink-3">
                    {relative(t.updatedAt, now)}
                  </span>
                </div>

                {t.preview && (
                  <p className="truncate text-[12px] leading-snug text-ink-2">{t.preview}</p>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  {t.botPaused && (
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: "var(--warn)",
                        background: "color-mix(in srgb, var(--warn) 14%, transparent)",
                      }}
                    >
                      with a colleague
                    </span>
                  )}
                  {t.optedOut && (
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: "var(--bad)",
                        background: "color-mix(in srgb, var(--bad) 14%, transparent)",
                      }}
                    >
                      opted out
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="num border-t border-rule px-4 py-2 text-[10px] text-ink-3">
        {threads.length} thread{threads.length === 1 ? "" : "s"} · {timezone}
      </p>
    </aside>
  );
}

/** Short, list-sized. The thread itself shows exact times. */
function relative(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
