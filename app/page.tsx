import Link from "next/link";
import { currentUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { PRESETS } from "@/lib/presets";

/**
 * The public page.
 *
 * Everything stated here is true and checkable in this repository. There are no
 * client logos, no star rating and no testimonial, because cadence has no
 * customers yet and inventing them is the one thing a page selling *approval*
 * cannot do. What replaces them is the engineering — a business buying an
 * assistant that speaks to its customers has a reasonable interest in whether
 * the thing was tested.
 */

const signupOpen = env.CADENCE_SIGNUP_OPEN === "true";

export default async function Home() {
  // Someone already signed in has no use for a sales page.
  const user = await currentUser();

  return (
    // The wrapper paints its own ground. <body> uses --paper, which follows the
    // OS, so a transparent page would put near-black behind every light section
    // for a dark-mode visitor.
    <div className="flex flex-col bg-m-paper text-m-ink">
      <Hero signedIn={Boolean(user)} />
      <Trades />
      <WhatItDoes />
      <Approval />
      <Availability />
      <Numbers />
      <Close signedIn={Boolean(user)} />
      <Foot />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Shared
// ══════════════════════════════════════════════════════════════════════

const eyebrow = "font-mono text-[11px] uppercase tracking-[0.18em]";

function Eyebrow({ children, onDeep }: { children: React.ReactNode; onDeep?: boolean }) {
  return (
    <p className={`${eyebrow} ${onDeep ? "text-on-deep-3" : "text-m-ink-3"} flex items-center gap-2`}>
      <span
        aria-hidden
        className="inline-block size-1 rounded-full"
        style={{ background: onDeep ? "var(--lime)" : "var(--signal)" }}
      />
      {children}
    </p>
  );
}

function LimeButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lime"
      style={{ background: "var(--lime)", color: "var(--lime-ink)" }}
    >
      {children}
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-full text-[11px] transition-transform group-hover:translate-x-0.5"
        style={{ background: "var(--lime-ink)", color: "var(--lime)" }}
      >
        ↗
      </span>
    </Link>
  );
}

function GhostButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-full border border-white/25 bg-white/5 px-6 py-3 text-sm font-medium text-on-deep backdrop-blur transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60"
    >
      {children}
    </Link>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Hero
// ══════════════════════════════════════════════════════════════════════

function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="field relative overflow-hidden">
      {/* The receding grid of hours and days. Decorative, so it is hidden from
          assistive technology entirely rather than described. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="field-grid absolute inset-x-[-60%] bottom-0 h-[70%]" />
      </div>

      {/* The hand-off into the light sections. Declared BEFORE the content so it
          paints underneath it — as a later sibling it sat on top of the product
          cards and bleached their lower halves. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
        style={{ background: "linear-gradient(to bottom, transparent, var(--m-paper))" }}
      />

      <div className="relative mx-auto w-full max-w-6xl px-6 pb-0 pt-6">
        <Nav signedIn={signedIn} />

        <div className="rise mx-auto mt-20 flex max-w-4xl flex-col items-center text-center">
          <Eyebrow onDeep>Appointment businesses</Eyebrow>

          {/* Two authored lines from `sm` up, where they fit. `nowrap` is scoped
              to that breakpoint on purpose: applied unconditionally it made the
              longest clause the page's minimum width, and every section
              inherited a sideways scroll on a phone. Below `sm` the clauses wrap
              and `balance` keeps them even. */}
          <h1
            className="mt-6 font-display text-[clamp(1.75rem,5.3vw,4rem)] font-semibold leading-[1.06] tracking-[-0.03em] text-on-deep"
            style={{ textWrap: "balance" }}
          >
            <span className="block sm:whitespace-nowrap">Your assistant answers.</span>
            <span className="block sm:whitespace-nowrap">
              You approve <span style={{ color: "var(--lime)" }}>every word</span>.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-on-deep-2">
            cadence replies to your customers on WhatsApp, books into your real calendar, and hands
            over anything you haven&apos;t approved it to say.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            {signedIn ? (
              <LimeButton href="/admin">Open your dashboard</LimeButton>
            ) : signupOpen ? (
              <LimeButton href="/signup">Set up your business</LimeButton>
            ) : (
              <LimeButton href="/signin">Sign in</LimeButton>
            )}
            <GhostButton href="#how">See how it works</GhostButton>
          </div>
        </div>

        {/* The product, not a stock photograph. */}
        <div className="relative mt-16 pb-24">
          <div className="grid items-end gap-4 sm:grid-cols-3">
            <div className="drift" style={{ animationDelay: "0s" }}>
              <ThreadCard />
            </div>
            {/* Raised, because approval is the thing the page is about and this
                is the card that shows it. */}
            <div className="drift sm:mb-10" style={{ animationDelay: "-2.3s" }}>
              <ApprovalCard />
            </div>
            <div className="drift" style={{ animationDelay: "-4.6s" }}>
              <SlotsCard />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function Nav({ signedIn }: { signedIn: boolean }) {
  return (
    <nav className="flex items-center gap-6 rounded-full border border-white/12 bg-white/6 px-5 py-3 backdrop-blur">
      <Link href="/" className="flex items-center gap-2">
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-md text-[11px] font-bold"
          style={{ background: "var(--lime)", color: "var(--lime-ink)" }}
        >
          c
        </span>
        <span className="font-display text-[15px] font-semibold tracking-tight text-on-deep">
          cadence
        </span>
      </Link>

      <div className="ml-auto hidden items-center gap-7 sm:flex">
        <a href="#how" className="text-[13px] text-on-deep-2 transition-colors hover:text-on-deep">
          How it works
        </a>
        <a
          href="#approval"
          className="text-[13px] text-on-deep-2 transition-colors hover:text-on-deep"
        >
          Approval
        </a>
        <a href="#who" className="text-[13px] text-on-deep-2 transition-colors hover:text-on-deep">
          Who it&apos;s for
        </a>
      </div>

      <Link
        href={signedIn ? "/admin" : "/signin"}
        className="ml-auto rounded-full px-4 py-1.5 text-[13px] font-semibold transition-transform hover:-translate-y-0.5 sm:ml-0"
        style={{ background: "var(--lime)", color: "var(--lime-ink)" }}
      >
        {signedIn ? "Dashboard" : "Sign in"}
      </Link>
    </nav>
  );
}

// ── The three floating cards ────────────────────────────────────────

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-white/12 bg-white/95 p-4 shadow-[0_24px_60px_-20px_rgba(3,20,40,0.65)] backdrop-blur ${className}`}
    >
      {children}
    </div>
  );
}

function ThreadCard() {
  return (
    <Card>
      <p className={`${eyebrow} text-m-ink-3`}>WhatsApp</p>
      <div className="mt-3 flex flex-col gap-2">
        <p className="max-w-[85%] self-start rounded-2xl rounded-bl-sm bg-m-surface-2 px-3 py-2 text-[12px] leading-snug text-m-ink">
          do you take walk-ins on a saturday?
        </p>
        <p
          className="max-w-[90%] self-end rounded-2xl rounded-br-sm px-3 py-2 text-[12px] leading-snug text-white"
          style={{ background: "var(--signal)" }}
        >
          We do, but Saturdays fill up fast — mornings are usually quieter. Want me to hold you a
          time instead?
        </p>
      </div>
      <p className="mt-3 border-t border-m-rule pt-2 font-mono text-[10px] text-m-ink-3">
        answered from · &ldquo;Do you take walk-ins?&rdquo; v2
      </p>
    </Card>
  );
}

function ApprovalCard() {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className={`${eyebrow} text-m-ink-3`}>Waiting for you</p>
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
          style={{ color: "var(--warn)", border: "1px solid color-mix(in srgb, var(--warn) 40%, transparent)" }}
        >
          draft
        </span>
      </div>
      <p className="mt-3 text-[13px] font-semibold leading-snug text-m-ink">
        How long does recovery take?
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-m-ink-2">
        Most people are back at a desk within three days. We&apos;ll go through what to expect at
        your consultation.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span
          className="rounded-full px-3 py-1 text-[11px] font-semibold"
          style={{ background: "var(--lime)", color: "var(--lime-ink)" }}
        >
          Approve
        </span>
        <span className="font-mono text-[10px] text-m-ink-3">handbook.pdf · p4</span>
      </div>
    </Card>
  );
}

function SlotsCard() {
  const slots = [
    { time: "09:00", taken: true },
    { time: "09:30", taken: false },
    { time: "10:00", taken: false },
    { time: "10:30", taken: true },
    { time: "11:00", taken: false },
    { time: "11:30", taken: true },
  ];
  return (
    <Card>
      <p className={`${eyebrow} text-m-ink-3`}>Saturday</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {slots.map((s) => (
          <span
            key={s.time}
            className="rounded-md px-1 py-1.5 text-center font-mono text-[11px] tabular-nums"
            style={
              s.taken
                ? { background: "var(--m-surface-2)", color: "var(--m-ink-3)" }
                : { background: "var(--lime)", color: "var(--lime-ink)", fontWeight: 600 }
            }
          >
            {s.time}
          </span>
        ))}
      </div>
      <p className="mt-3 border-t border-m-rule pt-2 font-mono text-[10px] text-m-ink-3">
        held before it&apos;s promised
      </p>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Who it's for — replaces the reference's logo cloud
// ══════════════════════════════════════════════════════════════════════

/**
 * The reference puts a row of client logos here. cadence has no clients to show
 * and borrowed logos are a lie, so this does the same job — establishing
 * breadth — with something true: the trades the model actually fits.
 */
function Trades() {
  const trades = [
    "Hair clinic",
    "Barber",
    "Nail salon",
    "Physiotherapy",
    "Tattoo studio",
    "Dental practice",
    "Driving instructor",
    "Garage",
    "Veterinary",
    "Photography studio",
  ];
  return (
    <section className="border-b border-m-rule bg-m-paper py-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-2 px-6">
        {trades.map((t) => (
          <span
            key={t}
            className="rounded-full border border-m-rule bg-m-surface px-3.5 py-1.5 text-[12px] text-m-ink-2"
          >
            {t}
          </span>
        ))}
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  What it does
// ══════════════════════════════════════════════════════════════════════

function WhatItDoes() {
  const things = [
    {
      title: "It answers",
      body:
        "From what your business wrote down — and only that. Ask it something you haven't covered and it says it will check, rather than inventing an answer from what it happens to know about your industry.",
    },
    {
      title: "It books",
      body:
        "Against live availability, never a cached copy. It holds the slot before it tells anyone it's theirs, so two people asking at the same moment can't both be promised it.",
    },
    {
      title: "It hands over",
      body:
        "The moment a question crosses a line you drew. A clinic hands over anything clinical; a garage hands over quoting a repair it hasn't seen. You write the list in your own words.",
    },
  ];

  return (
    <section id="how" className="bg-m-paper py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <Eyebrow>What it does</Eyebrow>
          <h2
            className="mt-5 font-display text-[clamp(1.9rem,4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.025em]"
            style={{ textWrap: "balance" }}
          >
            Three jobs, and it refuses everything else
          </h2>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {things.map((t, i) => (
            <div
              key={t.title}
              className="flex flex-col rounded-2xl border border-m-rule bg-m-surface p-7"
            >
              <span
                aria-hidden
                className="font-mono text-[11px] tabular-nums"
                style={{ color: "var(--signal)" }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-4 font-display text-xl font-semibold tracking-tight">{t.title}</h3>
              <p className="mt-3 text-[14px] leading-relaxed text-m-ink-2">{t.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  The approval gate — the actual differentiator
// ══════════════════════════════════════════════════════════════════════

function Approval() {
  return (
    <section id="approval" className="bg-deep py-24 text-on-deep">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-14 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <div>
            <Eyebrow onDeep>The part that matters</Eyebrow>
            <h2
              className="mt-5 font-display text-[clamp(1.9rem,4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.025em]"
              style={{ textWrap: "balance" }}
            >
              Nothing reaches a customer unread
            </h2>
            <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-on-deep-2">
              Every answer starts as a draft. A person reads it and approves it, and only then can
              the assistant say it. Not a setting — there is no path that skips it.
            </p>

            <dl className="mt-10 flex flex-col gap-6">
              {[
                [
                  "Editing live text takes it offline",
                  "Change an approved answer and it returns to draft. Customers keep getting the last version you signed off until you sign off the new one.",
                ],
                [
                  "Uploads arrive as drafts too",
                  "Hand it your company PDF and it comes back as titled answers, each traceable to a page — all of them waiting for you. Company documents carry internal pricing, so this one is not negotiable.",
                ],
                [
                  "Every reply is traceable",
                  "Months later, when someone says “your bot told me…”, the message records which article it read and at which version.",
                ],
              ].map(([term, desc]) => (
                <div key={term} className="flex gap-4">
                  <span
                    aria-hidden
                    className="mt-2 h-px w-6 shrink-0"
                    style={{ background: "var(--lime)" }}
                  />
                  <div>
                    <dt className="font-display text-[15px] font-semibold">{term}</dt>
                    <dd className="mt-1.5 text-[14px] leading-relaxed text-on-deep-2">{desc}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>

          <FlowCard />
        </div>
      </div>
    </section>
  );
}

/** The lifecycle, as the three states an article can actually be in. */
function FlowCard() {
  const steps = [
    { label: "Written or uploaded", state: "draft", note: "the assistant cannot see it" },
    { label: "Read by a person", state: "draft", note: "edit, retitle, or discard" },
    { label: "Approved", state: "live", note: "now it can be quoted" },
  ];

  return (
    <div className="rounded-3xl border border-white/12 bg-white/5 p-7 backdrop-blur">
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const live = s.state === "live";
          return (
            <li
              key={s.label}
              className="flex items-center gap-4 rounded-2xl border p-4"
              style={{
                borderColor: live ? "var(--lime)" : "rgba(255,255,255,0.12)",
                background: live ? "color-mix(in srgb, var(--lime) 12%, transparent)" : "transparent",
              }}
            >
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full font-mono text-[11px] font-semibold"
                style={
                  live
                    ? { background: "var(--lime)", color: "var(--lime-ink)" }
                    : { background: "rgba(255,255,255,0.1)", color: "var(--on-deep-2)" }
                }
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold">{s.label}</p>
                <p className="text-[12px] text-on-deep-3">{s.note}</p>
              </div>
              <span
                className="ml-auto shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
                style={
                  live
                    ? { color: "var(--lime)", border: "1px solid var(--lime)" }
                    : { color: "var(--on-deep-3)", border: "1px solid rgba(255,255,255,0.18)" }
                }
              >
                {s.state}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Availability
// ══════════════════════════════════════════════════════════════════════

function Availability() {
  return (
    <section className="bg-m-paper py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <Eyebrow>Underneath</Eyebrow>
          <h2
            className="mt-5 font-display text-[clamp(1.9rem,4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.025em]"
            style={{ textWrap: "balance" }}
          >
            A calendar that can&apos;t be wrong
          </h2>
          <p className="mt-6 text-[15px] leading-relaxed text-m-ink-2">
            An assistant is only as good as the availability behind it. cadence never stores whether
            a slot is free — it works the answer out per question, from your hours, your leave and
            your bookings.
          </p>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-2">
          {[
            [
              "Two people can't take the same slot",
              "Not because the code checks first — because the database refuses. Two customers asking in the same second is a race, and a check in application code loses it in production, in front of real people.",
            ],
            [
              "Leave is per person, not per business",
              "Mark a surgeon away for four days and their colleagues keep taking bookings. If existing appointments fall inside the window, the screen refuses and lists the customers to call.",
            ],
            [
              "One booking, several resources",
              "A transplant needs a surgeon and a theatre for a full day. A cut needs a barber and a chair. Both are held together or neither is held.",
            ],
            [
              "Timezones that survive the clocks changing",
              "Branches in different countries, opening hours as wall-clock time, and an hour that doesn't exist on a spring-forward morning is refused rather than quietly shifted.",
            ],
          ].map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-m-rule bg-m-surface p-7">
              <h3 className="font-display text-[17px] font-semibold tracking-tight">{title}</h3>
              <p className="mt-3 text-[14px] leading-relaxed text-m-ink-2">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Numbers — engineering facts, not invented traction
// ══════════════════════════════════════════════════════════════════════

function Numbers() {
  // Fixed two-line height so the four numbers sit on one baseline. Without it
  // "Double bookings possible" wraps, pushes its 0 down, and the row reads as
  // four unrelated cards rather than one comparison.
  const statLabel = `${eyebrow} flex min-h-[2.6em] items-start leading-[1.3]`;

  return (
    <section id="who" className="bg-m-paper pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* The one number worth staring at gets the loud colour. */}
          <div className="rounded-2xl p-7 lg:row-span-1" style={{ background: "var(--lime)" }}>
            <p className={statLabel} style={{ color: "var(--lime-ink)", opacity: 0.7 }}>
              Assertions
            </p>
            <p
              className="mt-3 font-display text-5xl font-semibold tracking-tight tabular-nums"
              style={{ color: "var(--lime-ink)" }}
            >
              217
            </p>
            <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--lime-ink)", opacity: 0.8 }}>
              Run against a live database — tenant isolation, double-booking, DST, the approval gate.
            </p>
          </div>

          <div className="rounded-2xl border border-m-rule bg-m-surface p-7">
            <p className={`${statLabel} text-m-ink-3`}>Double bookings possible</p>
            <p className="mt-3 font-display text-5xl font-semibold tracking-tight tabular-nums">0</p>
            <p className="mt-3 text-[13px] leading-relaxed text-m-ink-2">
              Enforced by a Postgres exclusion constraint, not by a check someone can forget.
            </p>
          </div>

          <div className="rounded-2xl bg-deep p-7 text-on-deep">
            <p className={`${statLabel} text-on-deep-3`}>Starting points</p>
            <p className="mt-3 font-display text-5xl font-semibold tracking-tight tabular-nums">
              {PRESETS.length - 1}
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-on-deep-2">
              Clinic, barber, salon, studio, workshop — each seeds your own words for time off, not
              ours.
            </p>
          </div>

          <div className="rounded-2xl border border-m-rule bg-m-surface p-7">
            <p className={`${statLabel} text-m-ink-3`}>To get started</p>
            <p className="mt-3 font-display text-5xl font-semibold tracking-tight">1 file</p>
            <p className="mt-3 text-[13px] leading-relaxed text-m-ink-2">
              Upload the PDF you already have. It comes back as answers, each headed with the
              question a customer would ask.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  Close
// ══════════════════════════════════════════════════════════════════════

function Close({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="bg-m-paper pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="field relative overflow-hidden rounded-3xl px-8 py-20 text-center">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="field-grid absolute inset-x-[-60%] bottom-0 h-[80%]" />
          </div>

          <div className="relative">
            <h2
              className="mx-auto max-w-2xl font-display text-[clamp(1.8rem,4vw,2.9rem)] font-semibold leading-[1.05] tracking-[-0.025em] text-on-deep"
              style={{ textWrap: "balance" }}
            >
              Set it up in a minute. Approve what it says.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-[15px] leading-relaxed text-on-deep-2">
              Pick the closest kind of business and you land on a checklist that walks you through
              the rest.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              {signedIn ? (
                <LimeButton href="/admin">Open your dashboard</LimeButton>
              ) : signupOpen ? (
                <LimeButton href="/signup">Set up your business</LimeButton>
              ) : (
                <LimeButton href="/signin">Sign in</LimeButton>
              )}
              <GhostButton href="/signin">I already have an account</GhostButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Foot() {
  return (
    <footer className="border-t border-m-rule bg-m-paper py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="grid size-5 place-items-center rounded text-[10px] font-bold"
            style={{ background: "var(--signal)", color: "#fff" }}
          >
            c
          </span>
          <span className="font-display text-[14px] font-semibold tracking-tight">cadence</span>
        </div>
        <p className="text-[12px] text-m-ink-3">
          Scheduling, availability and conversation infrastructure.
        </p>
        <Link href="/signin" className="text-[12px] text-m-ink-2 underline underline-offset-2">
          Sign in
        </Link>
      </div>
    </footer>
  );
}
