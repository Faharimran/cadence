"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { verifyPassword } from "@/lib/auth/password";
import { createPlatformSession, destroyPlatformSession } from "@/lib/platform/session";
import { requireOperator, requirePlatformAdmin } from "@/lib/platform/guard";

/**
 * Signing in to the operator console.
 *
 * Throttled harder than the tenant sign-in — four attempts rather than eight,
 * over the same window. There are a handful of these accounts and one of them
 * can see every customer on the platform, so the cost of being strict is a
 * colleague waiting fifteen minutes and the cost of being lax is everything.
 */
const MAX_ATTEMPTS = 4;
const WINDOW_SECONDS = 900;

async function tooManyAttempts(email: string): Promise<boolean> {
  try {
    const key = `cadence:platform-signin:${email.toLowerCase()}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count > MAX_ATTEMPTS;
  } catch {
    // Fails open, as the tenant sign-in does: a Redis outage must not lock the
    // operators out of their own console during what is probably an incident.
    return false;
  }
}

export async function platformSignIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const back = (reason: string) => `/platform/signin?error=${encodeURIComponent(reason)}`;

  if (!email || !password) redirect(back("Enter your email and password."));

  if (await tooManyAttempts(email)) {
    logger.warn("platform sign-in throttled", { email });
    redirect(back("Too many attempts. Try again in fifteen minutes."));
  }

  const user = await adminDb.platformUser.findUnique({ where: { email } });

  // Hash even when the account does not exist, so response time does not reveal
  // which addresses are operators.
  const stored = user?.passwordHash ?? "scrypt$00$00";
  const ok = await verifyPassword(password, stored);

  if (!user || !ok || !user.active) {
    logger.warn("platform sign-in rejected", { email, known: Boolean(user) });
    redirect(back("Email or password is incorrect."));
  }

  await redis.del(`cadence:platform-signin:${email}`).catch(() => {});
  await adminDb.platformUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  // Worth a log line at info: someone just gained cross-tenant visibility.
  logger.info("platform sign-in", { email, role: user.role });

  await createPlatformSession(user.id);
  redirect("/platform");
}

export async function platformSignOut() {
  await destroyPlatformSession();
  redirect("/platform/signin");
}

/**
 * Suspending a business.
 *
 * The one write the console has, and the heaviest: a suspended tenant answers
 * nobody. It is `admin` only, and it writes to the tenant's OWN audit log rather
 * than to a platform-side one — so the business can see that it happened, and
 * who did it, on the same trail as everything else about their account.
 */
export async function setTenantStatus(formData: FormData): Promise<void> {
  const operator = await requirePlatformAdmin();

  const tenantId = String(formData.get("tenantId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!tenantId || (status !== "active" && status !== "suspended")) return;

  const before = await adminDb.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true, name: true },
  });
  if (!before || before.status === status) return;

  await adminDb.tenant.update({ where: { id: tenantId }, data: { status } });
  await adminDb.auditLog.create({
    data: {
      tenantId,
      actor: `platform:${operator.email}`,
      action: status === "suspended" ? "tenant.suspended" : "tenant.reactivated",
      subject: `Tenant:${tenantId}`,
      before: { status: before.status },
      after: { status },
    },
  });

  logger.warn("tenant status changed by platform", {
    tenant: before.name,
    status,
    by: operator.email,
  });

  revalidatePath("/platform");
  revalidatePath(`/platform/tenants/${tenantId}`);
}

/** Exported so the layout can name whoever is looking. */
export async function whoAmI() {
  return requireOperator();
}
