import { randomBytes } from "node:crypto";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

/**
 * The guard rails on the one endpoint in enori that anybody can call.
 *
 * Everything else that reaches a model sits behind a signed-in session or a
 * verified webhook signature. The demo does not, by design — a sales page that
 * asks you to create an account before you can see the product has not
 * demonstrated anything. What replaces authentication is this file: an identity
 * that is only good for its own thread, and three ceilings that bound what a
 * stranger can spend.
 *
 * The ceilings are layered because they fail differently:
 *
 *   · **per session** — the honest visitor's limit. Generous enough to explore
 *     all three businesses, small enough that a bored one gets bored first.
 *   · **per IP** — catches someone clearing their cookie in a loop.
 *   · **global per day** — the only one that actually bounds the bill. An IP
 *     limit is worthless against a botnet; this is the number that means a bad
 *     day costs a known amount rather than an unknown one.
 */

/** Opaque, httpOnly, and the only thing tying a visitor to their transcript. */
export const DEMO_COOKIE = "cadence_demo";

/** A day. Long enough to come back to after lunch, short enough not to be a profile. */
export const DEMO_COOKIE_MAX_AGE = 24 * 3600;

export const LIMITS = {
  session: { limit: 20, windowSeconds: 3600 },
  ip: { limit: 45, windowSeconds: 3600 },
  global: { limit: 800, windowSeconds: 24 * 3600 },
} as const;

export type LimitScope = keyof typeof LIMITS;

export function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * A session id is only ever read back from our own cookie, but it is still
 * attacker-controlled input — it becomes a Redis key and a conversation's
 * `externalThreadId`. Anything that is not the shape we issue is treated as
 * absent and replaced, rather than trusted.
 */
export function isValidSessionId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export type LimitResult = { ok: true } | { ok: false; scope: LimitScope | "unavailable" };

/**
 * Counts this turn against all three ceilings.
 *
 * Increments first and compares afterwards, which is what makes it safe under
 * concurrency: two requests arriving together both get their own number from
 * `INCR` rather than both reading the same count and both deciding there is
 * room. The expiry is set only on the first increment of a window, so the
 * window is fixed rather than sliding forward on every request — a sliding
 * expiry would let a steady trickle hold a counter alive forever.
 */
export async function consumeDemoBudget(args: {
  sessionId: string;
  ip: string;
}): Promise<LimitResult> {
  const day = new Date().toISOString().slice(0, 10);
  const keys: [LimitScope, string][] = [
    ["session", `cadence:demo:s:${args.sessionId}`],
    ["ip", `cadence:demo:ip:${args.ip}`],
    ["global", `cadence:demo:all:${day}`],
  ];

  try {
    for (const [scope, key] of keys) {
      const { limit, windowSeconds } = LIMITS[scope];
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
      if (count > limit) return { ok: false, scope };
    }
    return { ok: true };
  } catch (err) {
    // Fails CLOSED. Everywhere else in enori a Redis outage costs latency and
    // never correctness — the snapshot layer degrades to a fresh read and
    // carries on. Here the thing Redis is holding is the spending limit itself,
    // so degrading to "allow" would turn an outage into an unmetered public
    // endpoint that bills per token. A demo that is briefly unavailable is a
    // much smaller problem.
    logger.error("demo: rate limiter unavailable, refusing", { err: String(err) });
    return { ok: false, scope: "unavailable" };
  }
}

/**
 * Best-effort client address.
 *
 * `x-forwarded-for` is trivially spoofed when nothing terminates in front of the
 * app, which is exactly why it is not the only ceiling — see the note above. It
 * is worth having anyway: it stops the ordinary case of one person hammering
 * the endpoint from becoming the global limit's problem.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

export function sessionCookie(sessionId: string, secure: boolean): string {
  return [
    `${DEMO_COOKIE}=${sessionId}`,
    "Path=/",
    `Max-Age=${DEMO_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
