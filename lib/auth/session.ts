import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * Sessions as signed cookies.
 *
 * No session table: the cookie carries the claims and an HMAC over them, so
 * reading a session costs nothing and there is no store to keep consistent.
 *
 * The trade is that a session cannot be revoked before it expires. That is why
 * the lifetime is short, and why `requireUser()` re-reads the user from the
 * database on every request — deactivating someone takes effect immediately even
 * though their cookie is still cryptographically valid.
 */

export const SESSION_COOKIE = "cadence_session";
const MAX_AGE_SECONDS = 12 * 3600;

export type SessionClaims = {
  userId: string;
  tenantId: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
};

function sign(payload: string): string {
  return createHmac("sha256", env.CADENCE_SECRET).update(payload).digest("base64url");
}

function encode(claims: SessionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(token: string): SessionClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = Buffer.from(sign(payload), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims?.userId !== "string" || typeof claims?.tenantId !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Mints a session token.
 *
 * Exported so tests can produce a genuine cookie without a browser — the
 * alternative is a test that re-implements the signing, which then passes even
 * when the real signing is wrong.
 */
export function mintToken(
  userId: string,
  tenantId: string,
  ttlSeconds = MAX_AGE_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  return encode({ userId, tenantId, iat: now, exp: now + ttlSeconds });
}

export async function createSession(userId: string, tenantId: string): Promise<void> {
  const token = mintToken(userId, tenantId);

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // not readable by script, so XSS cannot exfiltrate it
    sameSite: "lax", // blocks CSRF on the POST that Server Actions use
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? decode(token) : null;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** Used by proxy.ts, which cannot use next/headers. */
export function readTokenValue(token: string | undefined): SessionClaims | null {
  return token ? decode(token) : null;
}
