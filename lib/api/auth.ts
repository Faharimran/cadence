import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb } from "@/lib/prisma";
import { env } from "@/lib/env";
import { CadenceError } from "@/lib/api/errors";

/**
 * API keys are `<prefix>.<secret>`.
 *
 * The prefix is stored in clear and indexed, so lookup is a single indexed read;
 * the secret is only ever stored as a peppered hash. Splitting them this way
 * means a key can be identified in a log or an admin list without that record
 * being usable to authenticate.
 *
 * Resolution runs on the admin connection because it happens BEFORE any tenant
 * context exists — it is the one query that legitimately crosses tenants, and it
 * returns exactly one row.
 */

export type AuthContext = {
  tenantId: string;
  tenantSlug: string;
  timezone: string;
  currency: string;
  apiKeyPrefix: string;
  scopes: string[];
};

function hashSecret(secret: string): string {
  return createHash("sha256").update(`${secret}${env.CADENCE_SECRET}`).digest("hex");
}

export function generateApiKey(): { prefix: string; secret: string; hash: string } {
  const prefix = `cdn_live_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  return { prefix, secret, hash: hashSecret(secret) };
}

export async function authenticate(request: Request): Promise<AuthContext> {
  const header = request.headers.get("authorization") ?? "";
  const raw = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : (request.headers.get("x-api-key") ?? "").trim();

  if (!raw) throw new CadenceError("unauthorized", "Missing API key.");

  const sep = raw.indexOf(".");
  if (sep < 1) throw new CadenceError("unauthorized", "Malformed API key.");

  const prefix = raw.slice(0, sep);
  const secret = raw.slice(sep + 1);

  const key = await adminDb.apiKey.findUnique({
    where: { prefix },
    include: { tenant: true },
  });

  // Hash unconditionally, even when the prefix is unknown, so a wrong prefix and
  // a wrong secret take the same time. Otherwise the response time leaks which
  // prefixes exist.
  const candidate = hashSecret(secret);
  const expected = key?.hash ?? hashSecret("never-matches");

  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  if (!key || !ok) throw new CadenceError("unauthorized", "Invalid API key.");
  if (key.revokedAt) throw new CadenceError("unauthorized", "This API key was revoked.");
  if (key.tenant.status !== "active") {
    throw new CadenceError("forbidden", `Tenant is ${key.tenant.status}.`);
  }

  // Fire-and-forget: a failed usage stamp must never fail the request.
  void adminDb.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    tenantId: key.tenantId,
    tenantSlug: key.tenant.slug,
    timezone: key.tenant.timezone,
    currency: key.tenant.currency,
    apiKeyPrefix: key.prefix,
    scopes: key.scopes,
  };
}

export function requireScope(auth: AuthContext, scope: string): void {
  if (!auth.scopes.includes(scope)) {
    throw new CadenceError("forbidden", `This key lacks the '${scope}' scope.`);
  }
}
