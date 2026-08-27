import { z } from "zod";
import { route } from "@/lib/api/handler";
import { confirmHold, holdSlot } from "@/lib/engine/booking";
import { CadenceError } from "@/lib/api/errors";

const BookingBody = z.union([
  /** Confirm an existing hold — the conversational path. */
  z.object({ holdId: z.string().min(1) }),
  /** Book outright — for staff UIs and integrations that don't need a hold. */
  z.object({
    customerId: z.string().min(1),
    serviceId: z.string().min(1),
    locationId: z.string().min(1),
    startsAt: z.iso.datetime({ offset: true }),
    resourceIds: z.array(z.string().min(1)).optional(),
  }),
]);

/**
 * POST /v1/bookings
 *
 * Two shapes on purpose. A conversational agent holds first and confirms once
 * the customer says yes; a staff UI or a batch import already has the customer
 * in front of it and books in one step. The direct path still takes a hold
 * internally, so both routes share exactly one concurrency story.
 */
export const POST = route(
  { scope: "write", body: BookingBody, idempotent: true },
  async ({ db, auth, body }) => {
    const bookingId =
      "holdId" in body
        ? body.holdId
        : (
            await holdSlot(db, {
              tenantId: auth.tenantId,
              customerId: body.customerId,
              serviceId: body.serviceId,
              locationId: body.locationId,
              startsAt: new Date(body.startsAt),
              resourceIds: body.resourceIds,
              ttlSeconds: 60,
              source: "api",
            })
          ).bookingId;

    const booking = await confirmHold(db, { tenantId: auth.tenantId, bookingId });

    const full = await db.booking.findFirst({
      where: { id: booking.id, tenantId: auth.tenantId },
      include: {
        location: true,
        service: true,
        resources: { include: { resource: true } },
      },
    });
    if (!full) throw new CadenceError("internal", "Booking vanished after confirmation.");

    return serializeBooking(full);
  },
);

type BookingWithRelations = {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  customerId: string;
  service: { id: string; name: string };
  location: { id: string; name: string; timezone: string };
  resources: { resource: { id: string; name: string } }[];
};

export function serializeBooking(b: BookingWithRelations) {
  return {
    id: b.id,
    status: b.status,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    timezone: b.location.timezone,
    customerId: b.customerId,
    service: { id: b.service.id, name: b.service.name },
    location: { id: b.location.id, name: b.location.name },
    resources: b.resources.map((r) => ({ id: r.resource.id, name: r.resource.name })),
  };
}
