import { route, parseInstant } from "@/lib/api/handler";
import { getAvailability } from "@/lib/engine/availability";
import { CadenceError } from "@/lib/api/errors";

/**
 * GET /v1/availability
 *   ?service=<id>&from=<iso>&to=<iso>[&location=<id>][&resource=<id>][&limit=n]
 *
 * The response is a discriminated union rather than a bare array, because
 * "nothing available" has several distinct causes and they lead to completely
 * different next actions:
 *
 *   closed               → say when we reopen; do not offer to keep looking
 *   fully_booked         → offer a different day
 *   no_matching_resource → nobody here does this; route to a human
 *
 * Collapsing all three into `[]` is what makes chat assistants say "there are no
 * appointments" when the honest answer is "we're shut for the holiday".
 */
export const GET = route({ scope: "read" }, async ({ db, auth, searchParams }) => {
  const serviceId = searchParams.get("service");
  if (!serviceId) throw new CadenceError("validation_failed", "Missing 'service'.");

  const limitRaw = searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new CadenceError("validation_failed", "'limit' must be an integer 1-200.");
  }

  const result = await getAvailability(db, {
    tenantId: auth.tenantId,
    serviceId,
    from: parseInstant(searchParams.get("from"), "from"),
    to: parseInstant(searchParams.get("to"), "to"),
    locationId: searchParams.get("location") ?? undefined,
    resourceId: searchParams.get("resource") ?? undefined,
    limit,
  });

  if (!result.available) {
    return {
      available: false,
      reason: result.reason,
      ...(result.publicNote ? { note: result.publicNote } : {}),
      ...(result.nextOpenAt ? { nextOpenAt: result.nextOpenAt.toISOString() } : {}),
      slots: [],
    };
  }

  return {
    available: true,
    slots: result.slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      label: s.label,
      timezone: s.timezone,
      location: { id: s.locationId, name: s.locationName },
      resources: s.resourceIds.map((id, i) => ({ id, name: s.resourceNames[i] })),
    })),
  };
});
