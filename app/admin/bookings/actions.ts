"use server";

import { revalidatePath } from "next/cache";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { cancelBooking } from "@/lib/engine/booking";
import { logger } from "@/lib/logger";

/**
 * Cancelling from the admin goes through the same engine function the API and
 * the assistant use — so the resource is freed, the slot reopens immediately,
 * and the audit trail survives, without this screen having to know how any of
 * that works.
 */
export async function cancelBookingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    try {
      await cancelBooking(db, {
        tenantId: user.tenantId,
        bookingId: id,
        reason: `cancelled by ${user.email}`,
      });
      await db.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actor: `user:${user.id}`,
          action: "booking.cancelled",
          subject: `Booking:${id}`,
        },
      });
    } catch (err) {
      // A booking that has already gone is the desired end state, not something
      // to shout about on a list screen.
      logger.warn("admin cancel failed", {
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  revalidatePath("/admin/bookings");
  revalidatePath("/admin");
}
