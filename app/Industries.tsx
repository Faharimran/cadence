"use client";

import { useState } from "react";
import type { CardIcon, Industry } from "@/lib/marketing/industries";
import { SELECT_DEMO_EVENT } from "@/lib/marketing/demoEvent";

/**
 * "Is it for a business like mine?"
 *
 * The one question the rest of the page does not answer. Everything above it
 * argues that the thing is correct — approval, live availability, no double
 * bookings — which is the right argument and the wrong order for someone who
 * has not yet decided the product is aimed at them.
 *
 * Each tab therefore leads with the trade's own operational problem and lands
 * on the mechanism, rather than the other way round. What keeps it honest is
 * `lib/marketing/industries.ts`: every card names something in this repository,
 * and the `neverDoes` line is given the same weight as the capabilities,
 * because for a clinic or a vet it IS the capability.
 */

export type IndustryView = Industry & {
  /** Resolved server-side from lib/presets.ts, so PRESETS stays out of this bundle. */
  presetLabel: string;
};

export default function Industries({
  industries,
  notFor,
}: {
  industries: IndustryView[];
  notFor: string;
}) {
  const [activeId, setActiveId] = useState(industries[0]?.id ?? "");
  const active = industries.find((i) => i.id === activeId) ?? industries[0];
  if (!active) return null;

  return (
    <section id="industries" className="bg-m-paper pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-m-ink-3">
            <span
              aria-hidden
              className="inline-block size-1 rounded-full"
              style={{ background: "var(--signal)" }}
            />
            For your business
          </p>
          <h2
            className="mt-5 font-display text-[clamp(1.9rem,4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.025em]"
            style={{ textWrap: "balance" }}
          >
            One assistant, eight trades, nothing hard-coded
          </h2>
          <p className="mt-6 text-[15px] leading-relaxed text-m-ink-2">
            The engine knows resources, services and customers — not doctors, chairs or vehicles.
            What makes it yours is your words, your hours and your hand-over list, all of them
            rows you own rather than code we wrote.
          </p>
        </div>

        {/* ── The trades ─────────────────────────────────────────── */}
        <div
          role="tablist"
          aria-label="Industries"
          className="mt-10 flex flex-wrap items-center justify-center gap-2"
        >
          {industries.map((industry) => {
            const selected = industry.id === activeId;
            return (
              <button
                key={industry.id}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls="industry-panel"
                onClick={() => setActiveId(industry.id)}
                className="rounded-full border px-4 py-2 text-[13px] font-medium transition-colors"
                style={
                  selected
                    ? {
                        borderColor: "var(--signal)",
                        color: "var(--signal)",
                        background: "color-mix(in srgb, var(--signal) 8%, var(--m-surface))",
                      }
                    : {
                        borderColor: "var(--m-rule)",
                        color: "var(--m-ink-2)",
                        background: "var(--m-surface)",
                      }
                }
              >
                {industry.tab}
              </button>
            );
          })}
        </div>

        {/* ── The panel ──────────────────────────────────────────── */}
        <div
          id="industry-panel"
          role="tabpanel"
          aria-label={active.tab}
          className="mt-6 rounded-3xl border border-m-rule bg-m-surface-2 p-6 sm:p-10"
        >
          <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            {/* Left — what it is worth */}
            <div>
              <h3
                className="font-display text-[clamp(1.5rem,2.7vw,2.1rem)] font-semibold leading-[1.1] tracking-[-0.02em]"
                style={{ textWrap: "balance" }}
              >
                {active.headline}
              </h3>
              <p className="mt-5 max-w-lg text-[14px] leading-relaxed text-m-ink-2">
                {active.lede}
              </p>

              <ul className="mt-7 flex flex-col gap-3">
                {active.handles.map((item) => (
                  <li key={item} className="flex gap-3 text-[14px] leading-snug text-m-ink">
                    <span aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--signal)" }}>
                      <Check />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>

              {/* The refusal, given the same weight as the list above it. For
                  half these trades it is the reason they would buy at all. */}
              <div
                className="mt-7 rounded-2xl border p-5"
                style={{
                  borderColor: "color-mix(in srgb, var(--warn) 30%, transparent)",
                  background: "color-mix(in srgb, var(--warn) 5%, transparent)",
                }}
              >
                <p
                  className="font-mono text-[11px] uppercase tracking-[0.18em]"
                  style={{ color: "var(--warn)" }}
                >
                  Never, without exception
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed text-m-ink-2">
                  {active.neverDoes}
                </p>
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                {active.demo && (
                  <a
                    href="#demo"
                    onClick={() => {
                      // The demo panel owns its own tab state, so this asks it
                      // to switch rather than reaching into it. The href does
                      // the scrolling; this only decides what is on screen when
                      // the visitor arrives.
                      window.dispatchEvent(
                        new CustomEvent(SELECT_DEMO_EVENT, { detail: { persona: active.demo } }),
                      );
                    }}
                    className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-semibold transition-transform hover:-translate-y-0.5"
                    style={{ background: "var(--lime)", color: "var(--lime-ink)" }}
                  >
                    Talk to a {active.tab.toLowerCase()} agent
                    <span aria-hidden>↓</span>
                  </a>
                )}
                <p className="font-mono text-[11px] leading-relaxed text-m-ink-3">
                  Starts from the “{active.presetLabel}” setup
                </p>
              </div>
            </div>

            {/* Right — what runs it */}
            <ul className="flex flex-col gap-2.5">
              {active.cards.map((card) => (
                <li
                  key={card.label}
                  className="flex items-start gap-3.5 rounded-2xl border border-m-rule bg-m-surface p-4"
                >
                  <span
                    aria-hidden
                    className="grid size-9 shrink-0 place-items-center rounded-xl"
                    style={{
                      background: "color-mix(in srgb, var(--signal) 10%, transparent)",
                      color: "var(--signal)",
                    }}
                  >
                    <Icon name={card.icon} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold leading-snug">
                      {card.label}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-relaxed text-m-ink-2">
                      {card.note}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mx-auto mt-5 max-w-2xl text-center text-[13px] leading-relaxed text-m-ink-3">
          {notFor}
        </p>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Glyphs
// ══════════════════════════════════════════════════════════════════════
//
// Drawn here rather than pulled from an icon package: ten 16px marks do not
// justify a dependency, and every one of them is decorative — the card's label
// carries the meaning, so they are hidden from assistive technology.

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5 6.2 11.5 13 4.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PATHS: Record<CardIcon, React.ReactNode> = {
  calendar: (
    <>
      <rect x="2.8" y="3.6" width="12.4" height="11.6" rx="2" />
      <path d="M2.8 7.4h12.4M6.2 2.2v2.6M11.8 2.2v2.6" />
    </>
  ),
  shield: <path d="M9 2.2 15 4.6v4.6c0 3.4-2.4 5.6-6 6.6-3.6-1-6-3.2-6-6.6V4.6L9 2.2Z" />,
  chat: <path d="M15.2 8.6c0 3-2.8 5.4-6.2 5.4a7.4 7.4 0 0 1-2.2-.3l-3.6 1.2 1.2-3A5.2 5.2 0 0 1 2.8 8.6c0-3 2.8-5.4 6.2-5.4s6.2 2.4 6.2 5.4Z" />,
  handover: (
    <>
      <path d="M2.6 9h9.6" />
      <path d="m9.4 5.6 3.4 3.4-3.4 3.4" />
      <path d="M15.4 3.4v11.2" />
    </>
  ),
  layers: (
    <>
      <path d="M9 2.4 15.6 6 9 9.6 2.4 6 9 2.4Z" />
      <path d="m2.4 10.4 6.6 3.6 6.6-3.6" />
    </>
  ),
  doc: (
    <>
      <path d="M4.4 2.4h6l3.4 3.4v9.8H4.4V2.4Z" />
      <path d="M10.2 2.4v3.6h3.6M6.8 9.4h4.6M6.8 12h4.6" />
    </>
  ),
  clock: (
    <>
      <circle cx="9" cy="9" r="6.4" />
      <path d="M9 5.2V9l2.6 1.8" />
    </>
  ),
  plug: (
    <>
      <path d="M6.2 2.6v4M11.8 2.6v4" />
      <path d="M4 6.6h10v2.2a5 5 0 0 1-5 5 5 5 0 0 1-5-5V6.6Z" />
    </>
  ),
  globe: (
    <>
      <circle cx="9" cy="9" r="6.4" />
      <path d="M2.6 9h12.8M9 2.6c1.7 1.9 2.6 4 2.6 6.4S10.7 13.5 9 15.4C7.3 13.5 6.4 11.4 6.4 9S7.3 4.5 9 2.6Z" />
    </>
  ),
  tag: (
    <>
      <path d="M8.4 2.6H15v6.6l-6.4 6.4-6.6-6.6L8.4 2.6Z" />
      <circle cx="11.8" cy="5.8" r="1.1" />
    </>
  ),
};

function Icon({ name }: { name: CardIcon }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}
