import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Webhook delivery.
 *
 * Signed the way Meta and Stripe sign theirs — HMAC over `timestamp.body`, not
 * over the body alone. Signing the body only lets an attacker who captures one
 * request replay it forever; including the timestamp lets the receiver reject
 * anything stale.
 */

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
/** Consecutive failures across an endpoint before it is switched off. */
const DISABLE_AFTER_FAILURES = 20;

export function newSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * The verification a receiver implements. Exported so the docs on the
 * integration screen can show working code rather than an approximation, and so
 * the harness proves the two halves agree.
 */
export function verifyPayload(
  secret: string,
  header: string | null,
  body: string,
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=").map((x) => x.trim()) as [string, string]),
  );
  const timestamp = Number(parts.t);
  const received = parts.v1;
  if (!Number.isFinite(timestamp) || !received) return false;

  // Reject anything outside the window, so a captured request cannot be replayed
  // tomorrow.
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(signPayload(secret, timestamp, body), "utf8");
  const actual = Buffer.from(received, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Exponential backoff with a ceiling: 30s, 2m, 8m, 32m. */
function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** (attempt - 1), 30 * 60_000);
}

export type DeliveryOutcome = "delivered" | "retrying" | "failed";

/**
 * Attempts one delivery and records what happened.
 *
 * Runs on the admin connection because it is platform plumbing driven by a
 * worker with no session — the row it operates on already carries its tenant.
 */
export async function attemptDelivery(deliveryId: string): Promise<DeliveryOutcome> {
  const delivery = await adminDb.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status === "delivered") return "delivered";

  const endpoint = delivery.endpoint;
  if (!endpoint.active) {
    await adminDb.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: "failed", lastError: "endpoint disabled" },
    });
    return "failed";
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(endpoint.secret, timestamp, body);
  const attempt = delivery.attempts + 1;

  let ok = false;
  let error: string | null = null;

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cadence-signature": `t=${timestamp},v1=${signature}`,
        "cadence-event": delivery.event,
        "cadence-delivery": delivery.id,
        // Present so a receiver can make its own handler idempotent — retries
        // carry the same id.
        "cadence-attempt": String(attempt),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    ok = res.ok;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const exhausted = !ok && attempt >= MAX_ATTEMPTS;

  await adminDb.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: attempt,
      status: ok ? "delivered" : exhausted ? "failed" : "pending",
      lastError: error,
      lastAttemptAt: new Date(),
      deliveredAt: ok ? new Date() : null,
    },
  });

  if (ok) {
    return "delivered";
  }

  // A permanently broken endpoint should stop being retried, or one customer's
  // dead URL burns worker capacity forever. Counted over recent deliveries
  // rather than a stored counter, so a single success naturally clears it.
  if (exhausted) {
    const recent = await adminDb.webhookDelivery.findMany({
      where: { endpointId: endpoint.id },
      orderBy: { createdAt: "desc" },
      take: DISABLE_AFTER_FAILURES,
      select: { status: true },
    });
    const allFailed =
      recent.length >= DISABLE_AFTER_FAILURES && recent.every((d) => d.status === "failed");

    if (allFailed) {
      await adminDb.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: {
          active: false,
          disabledReason: `Disabled automatically after ${DISABLE_AFTER_FAILURES} consecutive failures. Last error: ${error}`,
        },
      });
      logger.error("webhook endpoint auto-disabled", { endpointId: endpoint.id, error });
    }
    return "failed";
  }

  logger.warn("webhook delivery failed, will retry", {
    deliveryId: delivery.id,
    attempt,
    error,
    nextInMs: backoffMs(attempt),
  });
  return "retrying";
}

/**
 * Claims a batch of deliveries that are due.
 *
 * Due means never attempted, or last attempted longer ago than this attempt's
 * backoff. Reading the schedule from the row rather than a queue means a worker
 * restart loses nothing.
 */
export async function dueDeliveries(limit = 25): Promise<string[]> {
  const now = Date.now();
  const candidates = await adminDb.webhookDelivery.findMany({
    where: { status: "pending", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: limit * 4,
    select: { id: true, attempts: true, lastAttemptAt: true },
  });

  return candidates
    .filter((d) => {
      if (d.attempts === 0 || !d.lastAttemptAt) return true;
      return now - d.lastAttemptAt.getTime() >= backoffMs(d.attempts);
    })
    .slice(0, limit)
    .map((d) => d.id);
}
