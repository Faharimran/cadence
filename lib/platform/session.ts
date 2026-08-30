import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * Sessions for people who run cadence, kept structurally separate from the ones
 * for people who run a business on it.
 *
 * Three separations, and each closes a different door:
 *
 *  1. **A different cookie name.** A tenant session and a platform session can
 *     coexist in one browser without either overwriting the other, so signing in
 *     to a customer's admin to reproduce a bug does not silently log you out of
 *     the console — or worse, leave one cookie standing in for the other.
 *
 *  2. **A different HMAC domain.** The payload is prefixed with a context string
 *     before signing. Even if the two claim shapes converged, a token minted for
 *     a tenant cannot verify here and vice versa: the MAC is over different
 *     bytes. This is the guarantee that survives a future refactor of the claims.
 *
 *  3. **A shorter life.** This session reads across every tenant on the
 *     platform, so it expires in two hours rather than twelve.
 *
 * The claims deliberately carry NO tenantId. There is no tenant to scope to, and
 * an optional one would invite code that treats its absence as "all tenants".
 */

export const PLATFORM_COOKIE = "cadence_platform";
const MAX_AGE_SECONDS = 2 * 3600;

/** Prefixed into the signed payload so the two token families cannot cross. */
const DOMAIN = "cadence.platform.v1";

export type PlatformClaims = {
  platformUserId: string;
  iat: number;
  exp: number;
};

function sign(payload: string): string {
  return createHmac("sha256", env.CADENCE_SECRET).update(`${DOMAIN}.${payload}`).digest("base64url");
}

function encode(claims: PlatformClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(token: string): PlatformClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = Buffer.from(sign(payload), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims?.platformUserId !== "string") return null;
    // A token carrying a tenantId is a tenant token, whatever else it looks
    // like. Refuse it rather than ignoring the field.
    if ("tenantId" in claims) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims as PlatformClaims;
  } catch {
    return null;
  }
}

/** Exported so the harness can mint a genuine cookie without a browser. */
export function mintPlatformToken(
  platformUserId: string,
  ttlSeconds = MAX_AGE_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  return encode({ platformUserId, iat: now, exp: now + ttlSeconds });
}

export async function createPlatformSession(platformUserId: string): Promise<void> {
  const jar = await cookies();
  jar.set(PLATFORM_COOKIE, mintPlatformToken(platformUserId), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    // Scoped to /platform so the cookie is not attached to tenant admin
    // requests at all — it cannot be confused for one if it is never sent.
    path: "/platform",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readPlatformSession(): Promise<PlatformClaims | null> {
  const jar = await cookies();
  const token = jar.get(PLATFORM_COOKIE)?.value;
  return token ? decode(token) : null;
}

export async function destroyPlatformSession(): Promise<void> {
  const jar = await cookies();
  jar.delete({ name: PLATFORM_COOKIE, path: "/platform" });
}

/** Used by proxy.ts, which cannot use next/headers. */
export function readPlatformTokenValue(token: string | undefined): PlatformClaims | null {
  return token ? decode(token) : null;
}
