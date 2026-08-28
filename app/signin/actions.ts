"use server";

import { redirect } from "next/navigation";
import { adminDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession } from "@/lib/auth/session";

const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 900;

/**
 * Throttles by email so a stolen password list cannot be sprayed at one account.
 *
 * Keyed on the email rather than the IP: an attacker rotates addresses trivially,
 * whereas the account under attack is fixed. Fails OPEN if Redis is unavailable —
 * a cache outage must not lock every customer out of their own admin.
 */
async function tooManyAttempts(email: string): Promise<boolean> {
  try {
    const key = `cadence:signin:${email.toLowerCase()}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count > MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

async function clearAttempts(email: string) {
  try {
    await redis.del(`cadence:signin:${email.toLowerCase()}`);
  } catch {
    /* best effort */
  }
}

/** Only ever a path on this site — an open redirect would let a phishing link
 *  bounce through a genuine sign-in page. */
function safeNext(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/admin";
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? "/admin"));

  const back = (reason: string) =>
    `/signin?error=${encodeURIComponent(reason)}&next=${encodeURIComponent(next)}`;

  if (!email || !password) redirect(back("Enter your email and password."));

  if (await tooManyAttempts(email)) {
    logger.warn("sign-in throttled", { email });
    redirect(back("Too many attempts. Try again in fifteen minutes."));
  }

  const user = await adminDb.user.findUnique({ where: { email } });

  // Hash even when the account does not exist, so response time does not reveal
  // which emails are registered.
  const stored = user?.passwordHash ?? "scrypt$00$00";
  const ok = await verifyPassword(password, stored);

  if (!user || !ok || !user.active) {
    logger.warn("sign-in rejected", { email, known: Boolean(user) });
    // One message for every failure mode — never "no such user" vs "wrong
    // password", which turns the form into an account enumerator.
    redirect(back("Email or password is incorrect."));
  }

  await clearAttempts(email);
  await adminDb.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id, user.tenantId);

  redirect(next);
}

export async function signOut() {
  await destroySession();
  redirect("/signin");
}
