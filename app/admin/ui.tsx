import Link from "next/link";

/**
 * Shared admin primitives.
 *
 * Not a component library — just the handful of shapes every screen repeats, in
 * one place so a spacing or focus-ring change lands everywhere at once. Anything
 * used on a single screen stays on that screen. Sixteen files import from here,
 * which is why restyling happens in this file rather than across all of them.
 *
 * The visual language is soft and rounded: generous radii, hairline borders, a
 * lift on anything interactive. What it deliberately does NOT inherit from that
 * language is density. A booking list or a schedule grid is scanned, not
 * browsed, so `Row` stays compact and every number stays tabular — a card big
 * enough to be charming is a card you can only fit six of on a screen.
 */

export const inputClass =
  "rounded-xl border border-rule bg-surface px-3.5 py-2.5 text-sm outline-none transition-colors " +
  "placeholder:text-ink-3/70 focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent/15";

export const labelClass = "font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-ink-3">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, lede }: { title: string; lede?: string }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em]">
        {title}
      </h1>
      {lede && <p className="max-w-[62ch] text-sm leading-relaxed text-ink-2">{lede}</p>}
    </header>
  );
}

export function Section({
  title,
  children,
  boxed,
}: {
  title: string;
  children: React.ReactNode;
  boxed?: boolean;
}) {
  return (
    <section
      className={
        boxed
          ? "rounded-2xl border border-rule bg-surface p-6 shadow-[0_1px_2px_rgba(16,32,48,0.04),0_8px_24px_-16px_rgba(16,32,48,0.18)]"
          : "flex flex-col gap-3"
      }
    >
      <h2
        className={
          boxed
            ? "mb-4 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-accent"
            : "border-b border-rule pb-2 font-mono text-xs font-semibold uppercase tracking-[0.13em] text-accent"
        }
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Button({
  children,
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" }) {
  const base =
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none";
  const styles =
    variant === "primary"
      ? "self-start rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-[0_6px_16px_-8px_var(--accent)] transition-transform hover:-translate-y-px active:translate-y-0"
      : "font-mono text-[11px] text-ink-3 underline underline-offset-2 transition-colors hover:text-ink";
  return (
    <button {...rest} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-rule px-4 py-5 text-sm text-ink-2">
      {children}
    </p>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-rule bg-surface px-4 py-3 transition-colors hover:border-accent/40">
      {children}
    </li>
  );
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: "ok" | "bad" | "warn" }) {
  const colour = tone ? `var(--${tone})` : "var(--ink-3)";
  return (
    <span
      className="rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold"
      style={{
        color: colour,
        background: `color-mix(in srgb, ${colour} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${colour} 28%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

/** Shown when a screen needs something set up first. */
export function Prerequisite({ what, href, cta }: { what: string; href: string; cta: string }) {
  return (
    <p className="rounded-xl border border-dashed border-rule px-4 py-5 text-sm text-ink-2">
      {what}{" "}
      <Link href={href} className="font-medium text-accent underline underline-offset-2">
        {cta}
      </Link>
      .
    </p>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayName = (n: number) => WEEKDAYS[n] ?? String(n);
export const WEEKDAY_OPTIONS = WEEKDAYS.map((label, value) => ({ value, label }));
