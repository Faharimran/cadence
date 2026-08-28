import type { TenantDb } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Outbound events, written as an outbox.
 *
 * `recordEvent` does NOT send anything. It writes a WebhookDelivery row inside
 * the same transaction as the change that caused it, and a worker drains the
 * table afterwards.
 *
 * That ordering is the whole point. Sending inline would mean a slow or dead
 * endpoint holding a database transaction open, and enqueueing to Redis after
 * commit would mean a crash in between losing the event silently — the customer
 * gets an appointment and the tenant's CRM never hears about it. With an outbox,
 * if the booking committed the notification exists; the only question left is
 * when it gets delivered.
 *
 * Emission lives in the ENGINE rather than at each call site because three
 * different callers change bookings — the API, the agent, and the admin UI — and
 * three places to remember is three places to forget.
 */

export const EVENTS = [
  "booking.created",
  "booking.confirmed",
  "booking.cancelled",
  "booking.needs_rebooking",
  "conversation.escalated",
] as const;

export type EventName = (typeof EVENTS)[number];

export async function recordEvent(
  db: TenantDb,
  tenantId: string,
  event: EventName,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { tenantId, active: true },
      select: { id: true, events: true },
    });

    // An empty `events` array means "everything" — the common case, and less
    // surprising than an endpoint that silently receives nothing.
    const subscribed = endpoints.filter(
      (e) => e.events.length === 0 || e.events.includes(event),
    );
    if (subscribed.length === 0) return;

    await db.webhookDelivery.createMany({
      data: subscribed.map((e) => ({
        tenantId,
        endpointId: e.id,
        event,
        payload: {
          event,
          // Stamped at emission, not at delivery: a retry three minutes later
          // must still say when the thing actually happened.
          occurredAt: new Date().toISOString(),
          data: payload,
        } as never,
      })),
    });
  } catch (err) {
    // Never let notification bookkeeping fail a booking. A lost event is
    // recoverable by reconciliation; a lost appointment is not.
    logger.error("failed to record event", {
      event,
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
