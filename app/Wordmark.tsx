/**
 * The enori logotype. Built to docs/logo-reference.md.
 *
 * Three rules from that document are enforced here rather than left to the
 * caller, because each one has already been got wrong somewhere:
 *
 *   · **Lowercase, always.** The word is never capitalised, so it is written
 *     lowercase in the markup and the class exempts itself from
 *     `text-transform`. A nav that uppercases its items would otherwise
 *     capitalise a mark that has no capital form.
 *   · **The two-tone split IS the mark.** `en` takes the accent, `ori` the ink.
 *     They are one word, never separated, never recoloured to match. The one
 *     permitted exception is a coloured ground, where a blue prefix on blue
 *     says nothing — `tone="solid"` sets the whole word in white, which §2
 *     allows. Never the whole word in the accent: that reads as a link.
 *   · **It is a name, not decoration.** The container carries the label and the
 *     glyph is hidden, or a screen reader announces "e enori".
 *
 * Sizes are the reference's: 28px minimum in a top navigation, 22px in a
 * compact sidebar, 18px floor. Below that the wordmark stops being legible as
 * itself and the micro mark takes over.
 */

/** The `e` in a squircle. For favicons, avatars, and anything under 18px. */
export function MicroMark({ size = 26, tone }: { size?: number; tone?: "solid" }) {
  return (
    <span
      aria-hidden
      className={`enori-mark shrink-0 ${tone === "solid" ? "enori-mark-solid" : ""}`}
      style={{
        width: size,
        height: size,
        // The reference's ratio. A glyph sized to the box rather than to the
        // optical weight of the letter reads as a letter in a box.
        fontSize: Math.round(size * 0.58),
        // …and it sits on the optical centre, which is a shade above the
        // geometric one.
        paddingBottom: Math.max(1, Math.round(size * 0.02)),
      }}
    >
      e
    </span>
  );
}

export function Wordmark({
  size = 22,
  tone,
}: {
  size?: number;
  /** "solid" for a coloured ground, where the split has nothing to split on. */
  tone?: "solid";
}) {
  return (
    <span
      className={`enori-wordmark ${tone === "solid" ? "enori-solid" : ""}`}
      style={{ fontSize: size, lineHeight: `${size}px` }}
    >
      <span className="enori-prefix">en</span>ori
    </span>
  );
}

/**
 * Mark and wordmark together, as one named thing.
 *
 * Note what this does NOT take: a tenant's name. §8 of the reference is blunt
 * about it — a customer's name under the product mark reads as a lockup, as
 * though the product belonged to that customer, and the next prospect to see it
 * is looking at a competitor's branding inside software they are being asked to
 * buy. Whose data you are looking at belongs in the account area, under a
 * neutral label.
 */
export function Lockup({
  size = 22,
  tone,
  withMark = true,
}: {
  size?: number;
  tone?: "solid";
  withMark?: boolean;
}) {
  return (
    <span className="enori-lockup" aria-label="enori" role="img">
      {withMark && <MicroMark size={Math.round(size * 1.15)} tone={tone} />}
      <Wordmark size={size} tone={tone} />
    </span>
  );
}
