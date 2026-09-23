import type { Capability } from "@prisma/client";
import type { TenantDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import type { CapabilitySet } from "@/lib/conversation/capabilities";
import { formatMoney } from "@/lib/money";

/**
 * A per-conversation cache of the slow, stable things the agent needs to talk:
 * who the customer is, what the business sells, what it costs, what is on offer.
 *
 * Two reasons it exists, and the second is the one that matters:
 *
 *   1. Latency. One batched read at the start of a turn instead of four
 *      round-trips inside it.
 *   2. Survivability. When a tenant's CRM is slow or down, the agent can still
 *      hold a fluent conversation from the snapshot instead of going silent
 *      mid-sentence in front of a customer.
 *
 * THE RULE, and it is not negotiable: **snapshots speak, the source of truth
 * promises.** Everything here may be used to talk. Nothing here may be used to
 * commit. Availability is deliberately absent — it changes on the timescale of
 * the conversation itself, so offering from a snapshot is fine only because
 * `hold_slot` re-checks against live data and the database settles ties.
 *
 * Stored in Redis rather than memory because successive messages in one
 * WhatsApp thread can land on different worker processes — an in-process cache
 * would miss on the customer's second message.
 */

export type SnapshotSection<T> = {
  data: T;
  fetchedAt: string;
  stale: boolean;
};

export type ConversationSnapshot = {
  conversationId: string;
  tenantId: string;
  /** Absent (not empty) when a lookup failed — see the note on caching errors. */
  customer?: SnapshotSection<CustomerSummary>;
  services?: SnapshotSection<ServiceSummary[]>;
  offers?: SnapshotSection<OfferSummary[]>;
  locations?: SnapshotSection<LocationSummary[]>;
  /** True when any section had to be served past its TTL because a refresh failed. */
  degraded: boolean;
};

export type CustomerSummary = {
  id: string;
  name: string | null;
  locale: string | null;
  optedOut: boolean;
  upcoming: { id: string; startsAt: string; serviceName: string; locationName: string }[];
};

export type ServiceSummary = {
  id: string;
  name: string;
  category: string | null;
  durationMinutes: number;
  /** Null when the tenant does not publish a price, or forbids quoting one. */
  price: string | null;
  quotable: boolean;
};

export type OfferSummary = { name: string; description: string | null; endsAt: string };
export type LocationSummary = { id: string; name: string; timezone: string };

const KEY = (conversationId: string) => `cadence:snap:${conversationId}`;
const HARD_TTL_SECONDS = 24 * 3600;

export async function getSnapshot(
  db: TenantDb,
  caps: CapabilitySet,
  args: { tenantId: string; conversationId: string; customerId: string },
): Promise<ConversationSnapshot> {
  const cached = await readCache(args.conversationId);
  const now = Date.now();

  const snapshot: ConversationSnapshot = {
    conversationId: args.conversationId,
    tenantId: args.tenantId,
    degraded: false,
    ...cached,
  };

  const fresh = <T>(section: SnapshotSection<T> | undefined, capability: Capability) =>
    section !== undefined &&
    now - Date.parse(section.fetchedAt) < caps.ttl(capability) * 1000;

  // Each section refreshes on its own clock. A catalog is hours-stable; a
  // promotion can start at midnight; a customer's bookings change whenever they
  // talk to anyone. One global TTL would be wrong for all three.
  await Promise.all([
    (async () => {
      if (!caps.has("customers") || fresh(snapshot.customer, "customers")) return;
      const data = await loadCustomer(db, args.tenantId, args.customerId).catch((err) => {
        logger.warn("snapshot: customer refresh failed", { err: String(err) });
        return null;
      });
      if (data) snapshot.customer = mark(data);
      else if (snapshot.customer) {
        snapshot.customer.stale = true;
        snapshot.degraded = true;
      }
    })(),

    (async () => {
      if (!caps.has("catalog") || fresh(snapshot.services, "catalog")) return;
      const data = await loadServices(db, args.tenantId).catch((err) => {
        logger.warn("snapshot: catalog refresh failed", { err: String(err) });
        return null;
      });
      if (data) {
        snapshot.services = mark(data.services);
        snapshot.locations = mark(data.locations);
      } else if (snapshot.services) {
        snapshot.services.stale = true;
        snapshot.degraded = true;
      }
    })(),

    (async () => {
      if (!caps.has("promotions") || fresh(snapshot.offers, "promotions")) return;
      const data = await loadOffers(db, args.tenantId).catch((err) => {
        logger.warn("snapshot: promotions refresh failed", { err: String(err) });
        return null;
      });
      if (data) snapshot.offers = mark(data);
      else if (snapshot.offers) {
        snapshot.offers.stale = true;
        snapshot.degraded = true;
      }
    })(),
  ]);

  await writeCache(args.conversationId, snapshot);
  return snapshot;
}

/** Drops the cache for one conversation — used after a booking changes state. */
export async function invalidateSnapshot(conversationId: string): Promise<void> {
  await redis.del(KEY(conversationId)).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════════
//  Loaders
// ══════════════════════════════════════════════════════════════════════

function mark<T>(data: T): SnapshotSection<T> {
  return { data, fetchedAt: new Date().toISOString(), stale: false };
}

async function loadCustomer(
  db: TenantDb,
  tenantId: string,
  customerId: string,
): Promise<CustomerSummary> {
  const customer = await db.customer.findFirstOrThrow({
    where: { id: customerId, tenantId },
    include: {
      bookings: {
        where: { startsAt: { gte: new Date() }, status: { in: ["scheduled", "confirmed"] } },
        orderBy: { startsAt: "asc" },
        take: 5,
        include: { service: true, location: true },
      },
    },
  });

  return {
    id: customer.id,
    name: customer.name,
    locale: customer.locale,
    optedOut: customer.optedOut,
    upcoming: customer.bookings.map((b) => ({
      id: b.id,
      startsAt: b.startsAt.toISOString(),
      serviceName: b.service.name,
      locationName: b.location.name,
    })),
  };
}

async function loadServices(db: TenantDb, tenantId: string) {
  const [tenant, services, locations] = await Promise.all([
    db.tenant.findFirstOrThrow({ where: { id: tenantId } }),
    db.service.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" } }),
    db.location.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" } }),
  ]);

  return {
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      durationMinutes: s.durationMinutes,
      // A service the tenant marked non-quotable carries NO price into the
      // snapshot at all. Withholding it here rather than instructing the model
      // not to say it means there is no number in context to leak.
      price:
        s.priceQuotable && s.priceMinor !== null
          ? formatMoney(s.priceMinor, tenant.currency)
          : null,
      quotable: s.priceQuotable,
    })),
    locations: locations.map((l) => ({ id: l.id, name: l.name, timezone: l.timezone })),
  };
}

async function loadOffers(db: TenantDb, tenantId: string): Promise<OfferSummary[]> {
  const now = new Date();
  const promotions = await db.promotion.findMany({
    where: { tenantId, active: true, startsAt: { lte: now }, endsAt: { gte: now } },
    orderBy: { priority: "desc" },
  });

  return promotions.map((p) => ({
    name: p.name,
    // Only the tenant's own approved wording. A promotion without one is
    // mentioned as existing, never described in the model's words — inventing
    // the terms of a discount is a commitment the business has to honour.
    description: p.publicDescription,
    endsAt: p.endsAt.toISOString(),
  }));
}


// ══════════════════════════════════════════════════════════════════════
//  Redis
// ══════════════════════════════════════════════════════════════════════

async function readCache(conversationId: string): Promise<Partial<ConversationSnapshot>> {
  try {
    const raw = await redis.get(KEY(conversationId));
    return raw ? (JSON.parse(raw) as Partial<ConversationSnapshot>) : {};
  } catch (err) {
    // A Redis outage costs latency, never correctness — fall through to a fresh
    // read of everything.
    logger.warn("snapshot: cache read failed", { err: String(err) });
    return {};
  }
}

async function writeCache(conversationId: string, snapshot: ConversationSnapshot) {
  try {
    await redis.set(KEY(conversationId), JSON.stringify(snapshot), "EX", HARD_TTL_SECONDS);
  } catch (err) {
    logger.warn("snapshot: cache write failed", { err: String(err) });
  }
}
