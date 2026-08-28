"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asTenant, requireRole } from "@/lib/auth/guard";
import { isValidLocalTime } from "@/lib/engine/time";

/**
 * Opening hours — Layer 1 of availability.
 *
 * These are wall-clock times, deliberately: "Mondays from 09:00" is a fact about
 * a place, and only becomes an instant once you know the location's timezone and
 * a specific date. Storing them as instants would make the schedule drift by an
 * hour every time the clocks changed.
 */

const AddRule = z.object({
  resourceId: z.string().min(1),
  locationId: z.string().min(1),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).min(1),
  startTime: z.string().refine(isValidLocalTime, "Use HH:MM, e.g. 09:00"),
  endTime: z.string().refine(isValidLocalTime, "Use HH:MM, e.g. 17:00"),
  slotMinutes: z.coerce.number().int().min(5).max(240),
});

export type ScheduleFormState = { error?: string; ok?: string } | null;

export async function addScheduleRule(
  _previous: ScheduleFormState,
  formData: FormData,
): Promise<ScheduleFormState> {
  const user = await requireRole("manager");

  const parsed = AddRule.safeParse({
    resourceId: formData.get("resourceId"),
    locationId: formData.get("locationId"),
    weekdays: formData.getAll("weekdays"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    slotMinutes: formData.get("slotMinutes"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  const input = parsed.data;
  if (input.endTime <= input.startTime) {
    return { error: "The closing time must be after the opening time." };
  }

  return asTenant(user, async (db) => {
    const [resource, location] = await Promise.all([
      db.resource.findFirst({ where: { id: input.resourceId, tenantId: user.tenantId } }),
      db.location.findFirst({ where: { id: input.locationId, tenantId: user.tenantId } }),
    ]);
    if (!resource || !location) return { error: "That person or location no longer exists." };

    // Working somewhere implies being assigned there. Creating the link here
    // rather than making it a separate chore removes the most common way a
    // schedule silently produces no availability.
    await db.resourceLocation.upsert({
      where: { resourceId_locationId: { resourceId: resource.id, locationId: location.id } },
      create: { tenantId: user.tenantId, resourceId: resource.id, locationId: location.id },
      update: {},
    });

    const existing = await db.scheduleRule.findMany({
      where: {
        tenantId: user.tenantId,
        resourceId: resource.id,
        locationId: location.id,
        weekday: { in: input.weekdays },
        effectiveTo: null,
      },
    });

    // Overlapping rules on one day would generate the same slot twice. Replacing
    // is what the person means by re-entering a day they already set.
    const replaced = existing.filter(
      (r) => input.startTime < r.endTime && r.startTime < input.endTime,
    );
    if (replaced.length > 0) {
      await db.scheduleRule.updateMany({
        where: { id: { in: replaced.map((r) => r.id) } },
        data: { effectiveTo: new Date() },
      });
    }

    await db.scheduleRule.createMany({
      data: input.weekdays.map((weekday) => ({
        tenantId: user.tenantId,
        resourceId: resource.id,
        locationId: location.id,
        weekday,
        startTime: input.startTime,
        endTime: input.endTime,
        slotMinutes: input.slotMinutes,
      })),
    });

    revalidatePath("/admin/schedules");
    return {
      ok:
        replaced.length > 0
          ? `Saved, replacing ${replaced.length} overlapping entr${replaced.length === 1 ? "y" : "ies"}.`
          : "Saved.",
    };
  });
}

export async function removeScheduleRule(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    // Closed off rather than deleted, so availability computed for a past date
    // still reflects the hours that actually applied then.
    await db.scheduleRule.updateMany({
      where: { id, tenantId: user.tenantId },
      data: { effectiveTo: new Date() },
    });
    revalidatePath("/admin/schedules");
  });
}
