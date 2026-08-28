import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { adminDb, withTenant, type TenantDb } from "@/lib/prisma";
import { readSession } from "@/lib/auth/session";

/**
 * THE authorization check. Every admin page and every Server Action calls this.
 *
 * Not the proxy. Next's own documentation is explicit that Server Functions are
 * reachable by direct POST, not only through the UI you rendered — so route
 * gating in `proxy.ts` is an optimistic redirect for humans, and this is the
 * thing that actually decides. A Server Action that omits this call is
 * unauthenticated no matter what the URL looked like.
 *
 * The user is re-read from the database on every request rather than trusted
 * from the cookie, so deactivating someone or changing their role takes effect
 * immediately instead of when their session happens to expire.
 */

export type AuthedUser = {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: UserRole;
  tenantName: string;
  tenantSlug: string;
  tenantTimezone: string;
  tenantCurrency: string;
};

export async function currentUser(): Promise<AuthedUser | null> {
  const claims = await readSession();
  if (!claims) return null;

  // Cross-tenant by necessity: resolving who the caller is happens before any
  // tenant context exists. It returns exactly one row, by primary key.
  const user = await adminDb.user.findUnique({
    where: { id: claims.userId },
    include: { tenant: true },
  });

  if (!user || !user.active) return null;
  // A cookie minted for a different tenant than the user now belongs to is
  // either stale or forged; either way it is not usable.
  if (user.tenantId !== claims.tenantId) return null;
  if (user.tenant.status !== "active") return null;

  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantName: user.tenant.name,
    tenantSlug: user.tenant.slug,
    tenantTimezone: user.tenant.timezone,
    tenantCurrency: user.tenant.currency,
  };
}

/** Redirects to sign-in when there is no valid session. */
export async function requireUser(): Promise<AuthedUser> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  return user;
}

const RANK: Record<UserRole, number> = { staff: 0, manager: 1, owner: 2 };

export function can(user: AuthedUser, minimum: UserRole): boolean {
  return RANK[user.role] >= RANK[minimum];
}

/**
 * Requires a minimum role. Throws rather than redirects, because this guards
 * mutations — a Server Action that a staff member is not allowed to run should
 * fail loudly, not bounce them to a page as though they had merely browsed
 * somewhere they shouldn't.
 */
export async function requireRole(minimum: UserRole): Promise<AuthedUser> {
  const user = await requireUser();
  if (!can(user, minimum)) {
    throw new Error(`This action needs the ${minimum} role.`);
  }
  return user;
}

/**
 * Runs `fn` inside the signed-in user's tenant scope, with RLS active.
 *
 * The single door between the admin UI and the database. Because the tenant id
 * comes from the verified session and never from a form field or a URL, no
 * request can act on another tenant's data even if every id in the payload is
 * swapped.
 */
export async function asTenant<T>(
  user: AuthedUser,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  return withTenant(user.tenantId, fn);
}
