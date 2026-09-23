/**
 * What a model call costs, in one place.
 *
 * This table used to live inside scripts/costReport.ts, where it was read once a
 * quarter by whoever ran the report. It is here now because the operator console
 * prices every turn as it happens, and two copies of a rate card is two rate
 * cards — one of which is quietly wrong the first time a price changes.
 *
 * Prices are USD per million tokens, from the published table. The two
 * multipliers are the reason the system prompt is split the way it is: a cache
 * read is a tenth of the input price, a cache write is a quarter more than it,
 * and getting that split wrong re-bills the largest part of every prompt at full
 * price on every single message.
 *
 * **We price only our own key.** A tenant on DeepSeek, Groq or a model they host
 * themselves is spending money at a rate we do not know and are not shown. Their
 * tokens are counted; their bill is not guessed at. See `priceMicros`.
 */

/** USD per million tokens, for the models enori runs on its own key. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** A cache read costs a tenth of an input token. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Writing a cache entry costs a quarter more than reading the prompt cold. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Finds the rate card for a model id.
 *
 * Tolerates a dated suffix (`claude-haiku-4-5-20251001`) and a vendor prefix
 * (`anthropic/claude-sonnet-5`, which is how OpenRouter writes it) because both
 * are real strings that reach this function, and neither should silently price
 * at zero. An unknown model returns null rather than a guess — see `priceMicros`
 * for what that then means on the page.
 */
export function rateFor(model: string): { input: number; output: number } | null {
  if (PRICING[model]) return PRICING[model];

  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  if (PRICING[bare]) return PRICING[bare];

  // Longest match wins, so "claude-haiku-4-5-20251001" cannot match a shorter
  // family id that happens to be a prefix of it.
  const prefixed = Object.keys(PRICING)
    .filter((id) => bare.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return prefixed ? PRICING[prefixed] : null;
}

/**
 * What this call cost us, in millionths of a dollar.
 *
 * Returns null in the two cases where any number would be a fiction:
 *
 *   - the call ran on the tenant's own key, so it is not our bill and we have
 *     never seen their rate card;
 *   - the model is not one we price, which on our own key means someone added a
 *     model without adding it to PRICING. Null surfaces that on the console as
 *     "not priced" instead of burying a real spend inside a confident zero.
 *
 * Micros rather than cents because a single turn routinely costs a fraction of a
 * cent, and a per-call ledger that rounds each row to zero sums to zero.
 */
export function priceMicros(
  source: "platform" | "tenant",
  model: string,
  tokens: TokenCounts,
): number | null {
  if (source !== "platform") return null;
  return estimateMicros(model, tokens);
}

/**
 * What this many tokens would cost at list price, whoever paid.
 *
 * The difference from `priceMicros` is *whose question it answers*, and it is
 * worth keeping the two apart. `priceMicros` decides what goes in the ledger:
 * our bill, and null for anything we did not pay, because a stored number that
 * we invented is indistinguishable later from one we were charged.
 *
 * This one is for showing a business what their own key is costing *them* — a
 * question they are entitled to ask and we can only estimate. It is right when
 * they run a standard Anthropic account, because this table is Anthropic's
 * published rate card; it is wrong if they negotiated a discount, and it returns
 * null rather than guessing for DeepSeek, Groq or anything self-hosted, whose
 * prices we have never seen.
 *
 * Anything rendered from this must say "estimated" beside it. A figure a
 * business might reconcile against a real invoice has to admit which of the two
 * it is.
 */
export function estimateMicros(model: string, tokens: TokenCounts): number | null {
  const rate = rateFor(model);
  if (!rate) return null;

  const usd =
    (tokens.input * rate.input +
      tokens.cacheRead * rate.input * CACHE_READ_MULTIPLIER +
      tokens.cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
      tokens.output * rate.output) /
    1_000_000;

  return Math.round(usd * 1_000_000);
}

/** Micros → "$12.34", or "$0.0021" when rounding to cents would read as free. */
export function formatUsd(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** 1_234_567 → "1.23M". Token counts get large enough that digits stop reading. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
