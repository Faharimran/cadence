import { z } from "zod";
import { route } from "@/lib/api/handler";
import { holdSlot } from "@/lib/engine/booking";

const HoldBody = z.object({
  customerId: z.string().min(1),
  serviceId: z.string().min(1),
  locationId: z.string().min(1),
  /** Appointment start, exactly as returned by GET /v1/availability. */
  startsAt: z.iso.datetime({ offset: true }),
  resourceIds: z.array(z.string().min(1)).optional(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

/**
 * POST /v1/holds — reserve a slot briefly while the customer decides.
 *
 * This is the step that makes conversational booking safe. Offering a slot from
 * a cached snapshot is fine; committing to one is not, and the gap between
 * "3pm is free" and "yes please" is where double-bookings are born.
 *
 * On a lost race the 409 carries `details.alternatives`, so the caller can offer
 * another time in the same breath instead of apologising.
 */
export const POST = route(
  { scope: "write", body: HoldBody, idempotent: true },
  async ({ db, auth, body }) => {
    const held = await holdSlot(db, {
      tenantId: auth.tenantId,
      customerId: body.customerId,
      serviceId: body.serviceId,
      locationId: body.locationId,
      startsAt: new Date(body.startsAt),
      resourceIds: body.resourceIds,
      ttlSeconds: body.ttlSeconds,
      source: "api",
    });

    return {
      holdId: held.bookingId,
      status: "held",
      startsAt: held.startsAt.toISOString(),
      endsAt: held.endsAt.toISOString(),
      expiresAt: held.expiresAt.toISOString(),
      label: held.label,
      timezone: held.timezone,
      location: held.locationName,
      resources: held.resourceNames,
    };
  },
);
