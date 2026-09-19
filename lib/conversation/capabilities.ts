import type { Capability, CapabilityMode } from "@prisma/client";
import type { TenantDb } from "@/lib/prisma";

/**
 * What this tenant can actually do, and where the data lives.
 *
 * This is the hinge the whole product turns on. A salon with no CRM runs every
 * capability `hosted` against enori's own tables; a clinic on an existing PMS
 * runs availability and bookings `brokered` through a connector. Both get the
 * identical engine interface and — critically — the identical agent.
 *
 * The conversation layer reads this to ASSEMBLE ITS TOOLSET. A capability the
 * tenant does not have yields no tool, so the agent cannot offer something the
 * business cannot deliver. That is a stronger guarantee than instructing a model
 * not to: there is nothing to call.
 */

export type ResolvedCapability = {
  mode: CapabilityMode;
  connector: string | null;
  snapshotTtlSeconds: number;
};

export type CapabilitySet = {
  has(capability: Capability): boolean;
  mode(capability: Capability): CapabilityMode | null;
  ttl(capability: Capability): number;
  /** Capabilities present, for logging and for the system prompt's honesty. */
  list(): Capability[];
};

/** Fallback TTLs, used only when a tenant row omits one. */
const DEFAULT_TTL: Partial<Record<Capability, number>> = {
  availability: 60,
  booking_read: 60,
  booking_write: 60,
  promotions: 900,
  customers: 300,
  catalog: 21_600,
  knowledge: 21_600,
};

export async function resolveCapabilities(
  db: TenantDb,
  tenantId: string,
): Promise<CapabilitySet> {
  const rows = await db.tenantCapability.findMany({ where: { tenantId } });

  const map = new Map<Capability, ResolvedCapability>();
  for (const row of rows) {
    map.set(row.capability, {
      mode: row.mode,
      connector: row.connector,
      snapshotTtlSeconds: row.snapshotTtlSeconds,
    });
  }

  return {
    has: (c) => map.has(c),
    mode: (c) => map.get(c)?.mode ?? null,
    ttl: (c) => map.get(c)?.snapshotTtlSeconds ?? DEFAULT_TTL[c] ?? 300,
    list: () => [...map.keys()].sort(),
  };
}

/**
 * True when this capability is served by enori's own tables.
 *
 * Every tool checks this before writing. Brokered writes must go through the
 * connector so the tenant's system stays the system of record — writing to our
 * copy instead would leave two calendars disagreeing, and the receptionist's
 * would be the one customers actually turn up for.
 */
export function isHosted(caps: CapabilitySet, capability: Capability): boolean {
  return caps.mode(capability) === "hosted";
}
