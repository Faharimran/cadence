import { z } from "zod";
import { route } from "@/lib/api/handler";
import { cancelBooking } from "@/lib/engine/booking";
import { CadenceError } from "@/lib/api/errors";
import { serializeBooking } from "@/app/api/v1/bookings/route";

const INCLUDE = {
  location: true,
  service: true,
  resources: { include: { resource: true } },
} as const;

/** GET /v1/bookings/:id */
export const GET = route({ scope: "read" }, async ({ db, auth, params }) => {
  const booking = await db.booking.findFirst({
    where: { id: params.id, tenantId: auth.tenantId },
    include: INCLUDE,
  });
  // RLS would already hide another tenant's booking; this turns that into an
  // honest 404 rather than a confusing empty result.
  if (!booking) throw new CadenceError("not_found", "Unknown booking.");
  return serializeBooking(booking);
});

const CancelBody = z.object({
  reason: z.string().max(500).optional(),
  /**
   * `no_show` and `needs_rebooking` are cancellations with different meanings —
   * all three free the slot, but only one of them is the customer's fault and
   * only one of them implies we owe them a new time.
   */
  status: z.enum(["cancelled", "no_show", "needs_rebooking"]).optional(),
});

/** DELETE /v1/bookings/:id — cancel, freeing the slot immediately. */
export const DELETE = route(
  { scope: "write", body: CancelBody },
  async ({ db, auth, body, params }) => {
    await cancelBooking(db, {
      tenantId: auth.tenantId,
      bookingId: params.id,
      reason: body.reason,
      status: body.status,
    });

    const booking = await db.booking.findFirst({
      where: { id: params.id, tenantId: auth.tenantId },
      include: INCLUDE,
    });
    if (!booking) throw new CadenceError("not_found", "Unknown booking.");
    return serializeBooking(booking);
  },
);
