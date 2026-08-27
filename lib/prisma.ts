import { PrismaClient, type Prisma } from "@prisma/client";
import { env, isolationEnforced } from "@/lib/env";

/**
 * Two clients, because they have different privileges on purpose.
 *
 *   adminDb — connects as the table owner. Bypasses row-level security. Used
 *             only by migrations, the RLS bootstrap, seeds, and the small number
 *             of genuinely cross-tenant operations (resolving an API key to a
 *             tenant before any tenant context exists).
 *
 *   appDb   — connects as `cadence_app`, a non-owner. RLS applies. Everything
 *             that serves a request goes through `withTenant()` below.
 *
 * If DATABASE_APP_URL is unset (fresh clone, before scripts/applyRls.ts has run)
 * appDb falls back to the owner connection so the project still boots. That is a
 * development affordance only — lib/env.ts refuses to start in production
 * without a distinct app role.
 */

declare global {
  var __cadenceAdminDb: PrismaClient | undefined;
  var __cadenceAppDb: PrismaClient | undefined;
}

function createClient(url: string) {
  return new PrismaClient({
    datasources: { db: { url } },
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const adminDb =
  globalThis.__cadenceAdminDb ?? createClient(env.DATABASE_URL);

export const appDb =
  globalThis.__cadenceAppDb ??
  createClient(env.DATABASE_APP_URL ?? env.DATABASE_URL);

if (env.NODE_ENV !== "production") {
  globalThis.__cadenceAdminDb = adminDb;
  globalThis.__cadenceAppDb = appDb;
}

/** The tenant-scoped client handed to engine functions. */
export type TenantDb = Prisma.TransactionClient;

/**
 * Runs `fn` with the connection pinned to one tenant.
 *
 * `set_config(..., true)` is TRANSACTION-local, which is why this opens a
 * transaction rather than setting a session variable: with a connection pool, a
 * session-scoped setting would leak to whichever request borrows that connection
 * next — a tenant-isolation bug that only appears under load, which is the worst
 * kind to find.
 *
 * The cost is that every tenant-scoped read runs inside a transaction. That is
 * the intended trade: correctness of isolation over saving a BEGIN.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (!tenantId) throw new Error("withTenant requires a tenantId");

  return appDb.$transaction(
    async (tx) => {
      // Parameterised: tenantId reaches Postgres as a bound value, never
      // interpolated into SQL text.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: options?.timeoutMs ?? 15_000 },
  );
}

/**
 * Reports whether isolation is actually active, for the health endpoint. Says
 * "configured but inert" rather than "on" when the app role can bypass RLS —
 * a silent false sense of security is the thing this whole file exists to avoid.
 */
export async function isolationStatus(): Promise<{
  enforced: boolean;
  reason?: string;
}> {
  if (!isolationEnforced()) {
    return { enforced: false, reason: "DATABASE_APP_URL is unset or equals DATABASE_URL" };
  }
  const rows = await appDb.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `;
  const role = rows[0];
  if (!role) return { enforced: false, reason: "current_user not found in pg_roles" };
  if (role.rolsuper || role.rolbypassrls) {
    return { enforced: false, reason: "application role is superuser or has BYPASSRLS" };
  }
  return { enforced: true };
}
