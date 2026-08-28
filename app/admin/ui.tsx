import Link from "next/link";

/**
 * Shared admin primitives.
 *
 * Not a component library — just the handful of shapes every screen repeats, in
 * one place so a spacing or focus-ring change lands everywhere at once. Anything
 * used on a single screen stays on that screen.
 */

export const inputClass =
  "rounded-md border border-rule bg-surface px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

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
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, lede }: { title: string; lede?: string }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-mono text-xl font-semibold tracking-tight">{title}</h1>
      {lede && <p className="max-w-[62ch] text-sm text-ink-2">{lede}</p>}
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
          ? "rounded-lg border border-rule bg-surface p-5"
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
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      : "font-mono text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink";
  return (
    <button {...rest} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-2">{children}</p>;
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-rule bg-surface px-4 py-3">
      {children}
    </li>
  );
}

export function Pill({ children, tone }: { children: React.ReactNode; tone?: "ok" | "bad" | "warn" }) {
  const colour = tone ? `var(--${tone})` : "var(--ink-3)";
  return (
    <span
      className="rounded px-2 py-0.5 font-mono text-[11px] font-semibold"
      style={{ color: colour, border: `1px solid color-mix(in srgb, ${colour} 40%, transparent)` }}
    >
      {children}
    </span>
  );
}

/** Shown when a screen needs something set up first. */
export function Prerequisite({ what, href, cta }: { what: string; href: string; cta: string }) {
  return (
    <p className="text-sm text-ink-2">
      {what}{" "}
      <Link href={href} className="text-accent underline underline-offset-2">
        {cta}
      </Link>
      .
    </p>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayName = (n: number) => WEEKDAYS[n] ?? String(n);
export const WEEKDAY_OPTIONS = WEEKDAYS.map((label, value) => ({ value, label }));
