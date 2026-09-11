import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

/**
 * Ceilings on the one unauthenticated *write* in the product.
 *
 * The demo endpoint has had a limiter since the day it existed, because a
 * stranger calling it spends tokens. Sign-up is the second thing anybody can
 * call and it is the more expensive of the two: every accepted request
 * provisions a tenant, a location, services, exception types, tags, a draft
 * article and a user, and none of that is thrown away when the address turns
 * out to be nobody's. Rows are cheaper than tokens right up until there are a
 * hundred thousand of them.
 *
 * Two ceilings rather than the demo's three. There is no per-session limit
 * because there is no session — someone who has not signed up yet has no
 * identity to count against, and a cookie they control is not one.
 *
 *   · **per IP** — the ordinary case. A person creating their business does it
 *     once; five in an hour is already a retry loop or a test.
 *   · **global per day** — the only ceiling that bounds the damage, because an
 *     IP limit is worthless against a botnet. Set where a genuinely good launch
 *     day still fits underneath it. If this one ever trips for real reasons,
 *     that is a nice problem and the number moves.
 */

export const SIGNUP_LIMITS = {
  ip: { limit: 5, windowSeconds: 3600 },
  global: { limit: 100, windowSeconds: 24 * 3600 },
} as const;

export type SignupLimitScope = keyof typeof SIGNUP_LIMITS;

export type SignupLimitResult = { ok: true } | { ok: false; scope: SignupLimitScope | "unavailable" };

/**
 * Counts one provisioning attempt against both ceilings.
 *
 * Increments first and compares afterwards, which is what makes it correct
 * under concurrency: two requests arriving together each get their own number
 * from `INCR` rather than both reading the same count and both deciding there
 * is room. The expiry is set only on the first increment of a window, so the
 * window is fixed rather than sliding forward on every request — a sliding
 * expiry lets a steady trickle hold a counter alive forever.
 *
 * Call this *after* validation. A mistyped password should not cost somebody
 * their attempt, and rejecting bad input is cheap enough not to need metering.
 */
export async function consumeSignupBudget(ip: string): Promise<SignupLimitResult> {
  const day = new Date().toISOString().slice(0, 10);
  const keys: [SignupLimitScope, string][] = [
    ["ip", `cadence:signup:ip:${ip}`],
    ["global", `cadence:signup:all:${day}`],
  ];

  try {
    for (const [scope, key] of keys) {
      const { limit, windowSeconds } = SIGNUP_LIMITS[scope];
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
      if (count > limit) {
        logger.warn("signup: refused by limiter", { scope });
        return { ok: false, scope };
      }
    }
    return { ok: true };
  } catch (err) {
    // Fails CLOSED, for the same reason the demo limiter does: the thing Redis
    // is holding here IS the ceiling, so degrading to "allow" would turn an
    // outage into an unmetered public write endpoint.
    //
    // The cost of that choice is real — a Redis blip stops legitimate
    // businesses signing up — but it is the coherent one. Redis is already
    // load-bearing for the queue that runs agent turns, so a business that
    // signed up during the outage would be walking into a product whose
    // assistant cannot reply. Better an honest "try again shortly".
    logger.error("signup: rate limiter unavailable, refusing", { err: String(err) });
    return { ok: false, scope: "unavailable" };
  }
}

/** What to tell the person in front of the form, per ceiling. */
export function signupLimitMessage(scope: SignupLimitScope | "unavailable"): string {
  switch (scope) {
    case "ip":
      return "That's a lot of businesses from one connection. Try again in an hour.";
    case "global":
      return "We've taken more sign-ups than expected today. Please try again tomorrow.";
    case "unavailable":
      return "Sign-up is briefly unavailable. Please try again in a few minutes.";
  }
}
