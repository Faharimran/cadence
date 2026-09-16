"use client";

import { useMemo, useState } from "react";

/**
 * The availability rule, wired to switches.
 *
 * `recurring schedule − exceptions + extra sessions − bookings`, computed on
 * every render from the layers currently switched on. That is not a metaphor
 * for what the engine does; it is the same arithmetic, which is why the readout
 * under the grid shows its working rather than just a total. A visitor toggling
 * "Dr Mehta on leave" and watching four slots leave the day has understood
 * "availability is never stored" better than the paragraph above it can explain.
 *
 * Two details are here because they are the ones that cost money in production:
 *
 *   · **Unavailable is typed, not empty.** Every slot that is not free says
 *     which layer removed it. Collapsing those into an empty list is why
 *     assistants answer "no appointments available" when the truth was "that
 *     surgeon is away, his colleague is free all afternoon".
 *   · **A lost race returns alternatives.** The race button is the moment two
 *     customers ask for the same time in the same second. One is held, one is
 *     offered other times in the same breath — not apologised to.
 *
 * This is a worked example, not a live query: the day below is fixed so the
 * arithmetic stays legible. What is real is the rule it obeys.
 */

const SCHEDULE = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"];
const EXTRA = ["13:00", "13:30", "14:00"];
const ON_LEAVE = ["09:00", "09:30", "10:00", "10:30"];
const BOOKED = ["11:30", "12:30"];

const ALL = [...SCHEDULE, ...EXTRA].sort();

type SlotState = "free" | "leave" | "booked" | "closed" | "held";

const STATE_LABEL: Record<Exclude<SlotState, "free">, string> = {
  leave: "on leave",
  booked: "booked",
  closed: "closed",
  held: "just held",
};

export default function AvailabilityLab() {
  const [leaveOn, setLeaveOn] = useState(true);
  const [extraOn, setExtraOn] = useState(false);
  const [bookingsOn, setBookingsOn] = useState(true);
  const [race, setRace] = useState<{ slot: string; alternatives: string[] } | null>(null);

  const slots = useMemo(() => {
    return ALL.map((time) => {
      let state: SlotState = "free";
      const open = SCHEDULE.includes(time) || (EXTRA.includes(time) && extraOn);

      if (!open) state = "closed";
      else if (leaveOn && ON_LEAVE.includes(time)) state = "leave";
      else if (bookingsOn && BOOKED.includes(time)) state = "booked";
      else if (race?.slot === time) state = "held";

      return { time, state };
    });
  }, [leaveOn, extraOn, bookingsOn, race]);

  const free = slots.filter((s) => s.state === "free");

  // The working, in the order the engine applies it.
  const sums = {
    open: SCHEDULE.length,
    leave: leaveOn ? ON_LEAVE.length : 0,
    extra: extraOn ? EXTRA.length : 0,
    booked: bookingsOn ? BOOKED.filter((t) => !(leaveOn && ON_LEAVE.includes(t))).length : 0,
    held: race ? 1 : 0,
  };

  function runRace() {
    const target = free[0];
    if (!target) return;
    const rest = free.filter((s) => s.time !== target.time).slice(0, 2);
    setRace({ slot: target.time, alternatives: rest.map((s) => s.time) });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-m-rule bg-m-surface">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ── The layers ──────────────────────────────────────────── */}
        <div className="border-b border-m-rule p-6 lg:border-b-0 lg:border-r">
          <p className="eyebrow text-m-ink-3">
            Saturday, one clinician
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-m-ink-2">
            Switch a layer and the day is worked out again from scratch. There is no{" "}
            <code className="font-mono text-[12px] text-m-ink">isAvailable</code> column to go
            stale.
          </p>

          <div className="mt-5 flex flex-col gap-2">
            <Layer
              effect="base"
              label="Recurring schedule"
              note="09:00–13:00, every Saturday"
              on
              locked
            />
            <Layer
              effect="subtract"
              label="Exception · Dr Mehta on leave"
              note="Removes the morning"
              on={leaveOn}
              onToggle={() => setLeaveOn((v) => !v)}
            />
            <Layer
              effect="add"
              label="Extra session · late Saturday"
              note="Adds 13:00–14:30"
              on={extraOn}
              onToggle={() => setExtraOn((v) => !v)}
            />
            <Layer
              effect="subtract"
              label="Bookings already taken"
              note="11:30 and 12:30"
              on={bookingsOn}
              onToggle={() => setBookingsOn((v) => !v)}
            />
          </div>

          <p className="mt-5 border-t border-m-rule pt-4 text-[12px] leading-relaxed text-m-ink-3">
            Businesses name their own exception types. What they cannot invent is the effect —{" "}
            <span className="text-m-ink-2">add</span> and{" "}
            <span className="text-m-ink-2">subtract</span> are a closed set the engine
            owns.
          </p>
        </div>

        {/* ── The resulting day ───────────────────────────────────── */}
        <div className="p-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="eyebrow text-m-ink-3">
              Free right now
            </p>
            <p aria-live="polite" className="num text-[12px] text-m-ink-2">
              {free.length} of {slots.filter((s) => s.state !== "closed").length} open
            </p>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {slots.map((slot) => (
              <Slot key={slot.time} time={slot.time} state={slot.state} />
            ))}
          </div>

          {/* The working. This is the section's whole claim in one line. */}
          <p className="num mt-5 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-m-rule pt-4 text-[12px] text-m-ink-3">
            <Sum n={sums.open} label="open" />
            {sums.leave > 0 && (
              <>
                <span>−</span>
                <Sum n={sums.leave} label="on leave" />
              </>
            )}
            {sums.extra > 0 && (
              <>
                <span>+</span>
                <Sum n={sums.extra} label="extra" />
              </>
            )}
            {sums.booked > 0 && (
              <>
                <span>−</span>
                <Sum n={sums.booked} label="booked" />
              </>
            )}
            {sums.held > 0 && (
              <>
                <span>−</span>
                <Sum n={sums.held} label="held" />
              </>
            )}
            <span>=</span>
            <span className="font-semibold text-m-ink">{free.length} free</span>
          </p>

          {/* ── The race ──────────────────────────────────────────── */}
          <div className="mt-5 border-t border-m-rule pt-5">
            {race === null ? (
              <>
                <button
                  type="button"
                  onClick={runRace}
                  disabled={free.length === 0}
                  className="rounded-full px-4 py-2 text-[13px] font-semibold transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-40"
                  style={{ background: "var(--spark)", color: "var(--spark-ink)" }}
                >
                  {free.length === 0
                    ? "Nothing left to race for"
                    : `Two customers ask for ${free[0].time} at the same second`}
                </button>
                <p className="mt-2.5 text-[12px] leading-relaxed text-m-ink-3">
                  A check in application code loses this race in production, in front of real
                  people. A database constraint cannot.
                </p>
              </>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Reply
                    who="Customer A"
                    tone="won"
                    text={`Held — ${race.slot} on Saturday. Shall I confirm it?`}
                  />
                  <Reply
                    who="Customer B"
                    tone="lost"
                    text={
                      race.alternatives.length > 0
                        ? `That one's just gone. I can do ${race.alternatives.join(" or ")} the same day.`
                        : "That one's just gone, and Saturday is now full. Shall I look at Monday?"
                    }
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setRace(null)}
                    className="rounded-full border border-m-rule px-3 py-1 text-[12px] text-m-ink-2 transition-colors hover:bg-m-surface-2"
                  >
                    Reset the day
                  </button>
                  <p className="font-mono text-[11px] text-m-ink-3">
                    the second write failed at the database, not in a check
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────

function Layer({
  effect,
  label,
  note,
  on,
  locked,
  onToggle,
}: {
  effect: "base" | "add" | "subtract";
  label: string;
  note: string;
  on: boolean;
  locked?: boolean;
  onToggle?: () => void;
}) {
  const sign = effect === "add" ? "+" : effect === "subtract" ? "−" : "·";

  const body = (
    <>
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-md font-display text-[13px] font-semibold"
        style={
          on
            ? effect === "add"
              ? { background: "var(--spark)", color: "var(--spark-ink)" }
              : { background: "var(--signal)", color: "#fff" }
            : { background: "var(--m-surface-2)", color: "var(--m-ink-3)" }
        }
      >
        {sign}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-snug text-m-ink">{label}</span>
        <span className="block text-[11.5px] leading-snug text-m-ink-3">{note}</span>
      </span>
    </>
  );

  // The base schedule is not a switch, because a business without opening hours
  // is not a business. Rendering it as a disabled toggle would suggest it is.
  if (locked) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-m-rule bg-m-paper px-3 py-2.5">
        {body}
        <span className="eyebrow shrink-0 text-m-ink-3">
          always
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors"
      style={{
        borderColor: on ? "var(--signal)" : "var(--m-rule)",
        background: on ? "color-mix(in srgb, var(--signal) 6%, var(--m-surface))" : "var(--m-surface)",
      }}
    >
      {body}
      <span
        aria-hidden
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: on ? "var(--signal)" : "var(--m-rule)" }}
      >
        <span
          className="absolute top-0.5 size-4 rounded-full bg-white transition-all"
          style={{ left: on ? "1.125rem" : "0.125rem" }}
        />
      </span>
    </button>
  );
}

function Slot({ time, state }: { time: string; state: SlotState }) {
  const free = state === "free";
  const held = state === "held";

  return (
    <span
      className="flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-center transition-colors"
      style={
        free
          ? { background: "var(--spark)", color: "var(--spark-ink)" }
          : held
            ? { background: "color-mix(in srgb, var(--signal) 14%, transparent)", color: "var(--signal)" }
            : { background: "var(--m-surface-2)", color: "var(--m-ink-3)" }
      }
    >
      <span className={`font-mono text-[12px] tabular-nums ${free ? "font-semibold" : ""}`}>
        {time}
      </span>
      {/* Typed, never blank — the reason is the difference between "we're shut"
          and "that clinician is away". */}
      <span className="nav-heading opacity-80">
        {free ? "free" : STATE_LABEL[state]}
      </span>
    </span>
  );
}

function Sum({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <span className="font-semibold text-m-ink-2">{n}</span> {label}
    </span>
  );
}

function Reply({ who, tone, text }: { who: string; tone: "won" | "lost"; text: string }) {
  return (
    <div>
      <p className="eyebrow text-m-ink-3">{who}</p>
      <p
        className="mt-1.5 rounded-2xl rounded-bl-sm px-3.5 py-2 text-[13px] leading-snug"
        style={
          tone === "won"
            ? { background: "var(--spark)", color: "var(--spark-ink)" }
            : { background: "var(--m-surface-2)", color: "var(--m-ink)" }
        }
      >
        {text}
      </p>
    </div>
  );
}
