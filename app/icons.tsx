/**
 * Every glyph in the interface, drawn.
 *
 * No emoji anywhere — an emoji is drawn by the operating system, so the same
 * character is a different picture on macOS, Windows, Android and Linux, and
 * several plain dingbats (☎, ☀, ⚠) switch to emoji presentation on their own.
 * A status glyph that changes shape per platform is not a status glyph.
 *
 * One box (16 units), one stroke (1.6), `currentColor` throughout, sized from
 * whatever it sits in: 11px inside a tag, 13px in a button, 16px as a card
 * mark. Consistency of weight matters more than the quality of the drawings.
 */

export type IconName =
  | "check"
  | "circle"
  | "clock"
  | "pause"
  | "alert"
  | "cross"
  | "info"
  | "person"
  | "archive"
  | "sun"
  | "moon"
  | "monitor"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up-right"
  | "arrow-down"
  | "chevron-right"
  | "plus"
  | "key"
  | "spark";

/** The paths, in a 16-unit box. Stroke only — no fills, so weight stays even. */
const PATHS: Record<IconName, React.ReactNode> = {
  check: <path d="M3.25 8.4 6.5 11.6 12.75 4.9" />,
  circle: <circle cx="8" cy="8" r="5.25" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.9V8.2l2.3 1.4" />
    </>
  ),
  pause: <path d="M6.2 4.4v7.2M9.8 4.4v7.2" />,
  alert: (
    <>
      <path d="M8 2.8 14 12.9H2z" />
      <path d="M8 6.6v3.05M8 11.5v.05" />
    </>
  ),
  cross: <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" />,
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.4v3.6M8 5.05v.05" />
    </>
  ),
  person: (
    <>
      <circle cx="8" cy="5.6" r="2.5" />
      <path d="M3.4 13.2c0-2.3 2.06-3.6 4.6-3.6s4.6 1.3 4.6 3.6" />
    </>
  ),
  archive: (
    <>
      <path d="M2.6 4.6h10.8v2.2H2.6zM3.6 6.8v5.4a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V6.8" />
      <path d="M6.6 9.4h2.8" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.9" />
      <path d="M8 1.9v1.4M8 12.7v1.4M1.9 8h1.4M12.7 8h1.4M3.7 3.7l1 1M11.3 11.3l1 1M12.3 3.7l-1 1M4.7 11.3l-1 1" />
    </>
  ),
  moon: <path d="M13.1 9.7A5.6 5.6 0 0 1 6.3 2.9a5.6 5.6 0 1 0 6.8 6.8Z" />,
  monitor: (
    <>
      <rect x="2.2" y="3.1" width="11.6" height="8" rx="1.2" />
      <path d="M6.2 13.4h3.6" />
    </>
  ),
  "arrow-left": <path d="M12.4 8H3.6M7.2 4.4 3.6 8l3.6 3.6" />,
  "arrow-right": <path d="M3.6 8h8.8M8.8 4.4 12.4 8l-3.6 3.6" />,
  "arrow-up-right": <path d="M4.8 11.2 11.2 4.8M5.9 4.8h5.3v5.3" />,
  "arrow-down": <path d="M8 3.6v8.8M4.4 8.8 8 12.4l3.6-3.6" />,
  "chevron-right": <path d="M6.4 3.8 10.6 8l-4.2 4.2" />,
  plus: <path d="M8 3.8v8.4M3.8 8h8.4" />,
  key: (
    <>
      <circle cx="5.6" cy="10.4" r="2.6" />
      <path d="M7.5 8.6 13 3.1M10.8 5.3l1.5 1.5" />
    </>
  ),
  spark: <path d="M8 2.6 9.5 6.5 13.4 8 9.5 9.5 8 13.4 6.5 9.5 2.6 8 6.5 6.5Z" />,
};

export function Icon({
  name,
  size = 13,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  /**
   * Only when the icon stands alone. Beside a label it is decoration, and a
   * screen reader announcing it twice is worse than not announcing it.
   */
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
