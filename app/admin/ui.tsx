import Link from "next/link";
import { Icon, type IconName } from "@/app/icons";

/**
 * Shared admin primitives.
 *
 * Not a component library — just the handful of shapes every screen repeats, in
 * one place so a spacing or focus change lands everywhere at once. Sixteen
 * files import from here, which is why restyling happens in this file rather
 * than across all of them.
 *
 * The language is docs/ui-reference.md: a near-white page with white cards on
 * it, hairline rules, tight radii, one accent spent rarely, and a status system
 * that carries a fill, an ink AND a drawn glyph so a state survives greyscale
 * and colour blindness. Density is deliberate — this is software people read
 * all day, where one more row on screen is worth more than a generous headline.
 *
 * Nothing here contains a hex value. Every colour is a token from globals.css.
 */

/** The `.input` component class. Named for the twenty files already using it. */
export const inputClass = "input";

export const labelClass = "eyebrow";

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
      {hint && <span className="text-[11px] leading-relaxed text-ink-faint">{hint}</span>}
    </label>
  );
}

/**
 * The page title.
 *
 * Interface face, not the display one. Playfair is for the logotype; a 19px
 * page heading in a serif reads as an article, and this is a console.
 */
export function PageHeader({ title, lede }: { title: string; lede?: string }) {
  return (
    <header className="flex flex-col gap-1.5">
      <h1 className="text-[19px] font-semibold leading-tight tracking-[-0.01em] text-ink">
        {title}
      </h1>
      {lede && <p className="max-w-[72ch] text-sm leading-relaxed text-ink-2">{lede}</p>}
    </header>
  );
}

/**
 * A card, or a labelled run of content.
 *
 * Flat in both cases. With a near-white page and white cards the surfaces
 * already separate on tone and the rule draws the edge — a shadow on top is a
 * third statement of the same boundary.
 */
export function Section({
  title,
  children,
  boxed,
}: {
  title: string;
  children: React.ReactNode;
  boxed?: boolean;
}) {
  if (boxed) {
    return (
      <section className="card card-hover p-4">
        <h2 className="mb-3 text-[15px] font-semibold leading-snug text-ink">{title}</h2>
        {children}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="border-b border-rule pb-1.5 text-[15px] font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Buttons.
 *
 * Variants are component classes (`.btn-primary`), never a base utility string
 * with an override for the same property — with utility CSS the winner is
 * decided by the order the framework emits its rules, not the order they appear
 * in the string. One filled primary action per screen; everything else is the
 * quiet white pill.
 */
export function Button({
  children,
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "danger" | "plain";
}) {
  const variantClass = {
    primary: "btn btn-primary",
    danger: "btn btn-danger",
    quiet: "btn btn-ghost",
    plain: "btn",
  }[variant];

  return (
    <button {...rest} className={variantClass}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-rule px-3.5 py-4 text-sm text-ink-2">
      {children}
    </p>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="card card-hover flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-3.5 py-2.5">
      {children}
    </li>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Status
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The eight hues, and what each one is for.
 *
 * Badges answer different questions — is it held, has this person opted out,
 * does it need a person, did it fail — and one hue cannot give four answers.
 * These were measured rather than chosen: the worst adjacent pair clears ΔE 15
 * for normal vision and for the worst colour-blind pairing. Narrow this palette
 * and it has to be measured again.
 */
export type TagHue =
  | "blue"
  | "lime"
  | "aqua"
  | "citric"
  | "klein"
  | "fushia"
  | "tangerine"
  | "neutral";

export function Tag({
  children,
  hue = "neutral",
  icon,
  exact,
}: {
  children: React.ReactNode;
  hue?: TagHue;
  /** The third channel. A state must survive greyscale and a printed page. */
  icon?: IconName;
  /**
   * Keeps the label's own capitalisation. Tags are lowercase by default, which
   * is right for a state ("held", "needs a person") and wrong for a tag that
   * carries a proper noun or an identifier — "DeepSeek" is not "deepseek".
   */
  exact?: boolean;
}) {
  return (
    <span className={`tag tag-${hue}`} style={exact ? { textTransform: "none" } : undefined}>
      {icon && <Icon name={icon} size={11} className="tag-icon" />}
      {children}
    </span>
  );
}

/**
 * The older three-tone badge, kept because thirteen screens call it.
 *
 * It maps onto the tag palette rather than re-implementing one: good is the
 * aqua with a tick, a warning is the citric with a triangle, a failure is the
 * tangerine with a cross, and no tone is the neutral grey. New code should
 * reach for `Tag` and pick the hue that answers the actual question.
 */
export function Pill({
  children,
  tone,
  exact,
}: {
  children: React.ReactNode;
  tone?: "ok" | "bad" | "warn";
  exact?: boolean;
}) {
  const map = {
    ok: { hue: "aqua", icon: "check" },
    warn: { hue: "citric", icon: "alert" },
    bad: { hue: "tangerine", icon: "cross" },
  } as const;
  // No tone means no state — a category, a count, a name. Those get the neutral
  // fill and NO glyph: the third channel exists to tell two states apart, and a
  // glyph that says nothing is just a smaller word.
  const chosen = tone ? map[tone] : null;

  return (
    <Tag hue={chosen?.hue ?? "neutral"} icon={chosen?.icon} exact={exact}>
      {children}
    </Tag>
  );
}

/**
 * An inline banner. Same hues as the tags, on purpose: a failure in a sentence
 * and a failure in a badge must not be two different reds.
 */
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "bad" | "warn" | "good" | "info";
  title?: string;
  children: React.ReactNode;
}) {
  const icons: Record<typeof tone, IconName> = {
    bad: "cross",
    warn: "alert",
    good: "check",
    info: "info",
  };

  return (
    <div className={`notice notice-${tone} flex gap-2.5`}>
      <Icon name={icons[tone]} size={14} className="mt-0.5 shrink-0" />
      <div className="flex flex-col gap-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className="[&_p]:leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

/**
 * A figure worth looking at.
 *
 * Tabular numerals are not a detail here: without them digits change width as
 * they change, and a column of counts jitters as you read down it.
 */
export function Stat({
  label,
  value,
  hint,
  hero,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  hero?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={labelClass}>{label}</span>
      <span
        className={`num font-semibold leading-none text-ink ${hero ? "text-[27px]" : "text-[22px]"}`}
      >
        {value}
      </span>
      {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
    </div>
  );
}

/** Shown when a screen needs something set up first. */
export function Prerequisite({ what, href, cta }: { what: string; href: string; cta: string }) {
  return (
    <p className="rounded-lg border border-dashed border-rule px-3.5 py-4 text-sm text-ink-2">
      {what}{" "}
      <Link href={href} className="font-medium text-accent underline underline-offset-2">
        {cta}
      </Link>
      .
    </p>
  );
}

/** A back link, with a drawn arrow rather than a character that varies by OS. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted transition-colors hover:text-ink"
    >
      <Icon name="arrow-left" size={12} />
      {children}
    </Link>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayName = (n: number) => WEEKDAYS[n] ?? String(n);
export const WEEKDAY_OPTIONS = WEEKDAYS.map((label, value) => ({ value, label }));
