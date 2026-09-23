/**
 * Money, formatted once.
 *
 * Every amount in this database is an integer in the minor unit of some tenant's
 * currency — paise, pence, fils — because no float may ever touch a price. That
 * makes rendering a two-part problem: how many minor units go to the major one,
 * and how the result is written.
 *
 * Both answers belong to the currency, and this file is the only place that
 * knows them. It replaces two near-identical copies (one in the conversation
 * snapshot, one on the services page) that had already drifted apart on
 * fraction digits.
 *
 * ## The /100 that was wrong
 *
 * Both copies divided by 100. That is right for INR, GBP and AED — every
 * currency enori has a tenant in today — and wrong the moment one signs up in
 * Tokyo. JPY and KRW have no minor unit at all, so a ¥4,000 haircut stored as
 * 4000 would have rendered as ¥40; KWD and BHD have three places, so a price
 * would have come out ten times too large.
 *
 * `Intl` already knows the exponent for every currency, so it is asked rather
 * than assumed. This is the same rule the rest of the codebase applies to
 * timezones: resolve it from the data, never default it.
 */

/**
 * How many decimal places this currency actually has. 2 for most, 0 for JPY,
 * 3 for KWD.
 *
 * Falls back to 2 on an unrecognised code, which is the commonest case and the
 * least surprising wrong answer — but an unknown code is a tenant configured
 * with something we cannot price, so it is worth noticing rather than hiding.
 */
export function minorUnitDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Minor units → major, at the currency's own exponent. */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** minorUnitDigits(currency);
}

/**
 * The amount as a person in this business would write it.
 *
 * Fraction digits are left to the currency: a price that happens to be whole
 * prints as ₹1,200 rather than ₹1,200.00, and one with paise keeps them.
 */
export function formatMoney(minor: number, currency: string): string {
  const major = toMajor(minor, currency);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: minorUnitDigits(currency),
    }).format(major);
  } catch {
    // An unknown or malformed currency code. Still print the number — a figure
    // with an unfamiliar suffix is readable; a blank cell is not.
    return `${major.toFixed(2)} ${currency}`;
  }
}

/**
 * Compact, for a chart axis or a dense table: ₹1.2L-style shortening is locale
 * territory we are not in, so this stays with k/M and the currency symbol.
 */
export function formatMoneyCompact(minor: number, currency: string): string {
  const major = toMajor(minor, currency);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(major);
  } catch {
    return `${major.toFixed(0)} ${currency}`;
  }
}
