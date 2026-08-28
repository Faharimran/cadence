"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { localToInstant } from "@/lib/engine/time";
import { logger } from "@/lib/logger";

/**
 * Recording leave, closures and extra sessions.
 *
 * This is the screen the rest of the product leans on. The availability engine
 * is only as truthful as what a receptionist types here, so the two things that
 * matter are that entering a closure is quick, and that entering one which
 * collides with existing bookings cannot happen silently.
 */

const CreateException = z.object({
  typeId: z.string().min(1),
  /** "" = the whole business. */
  locationId: z.string(),
  /** "" = everyone at that scope. */
  resourceId: z.string(),
  /** Local wall-clock, from <input type="datetime-local">: "2026-09-01T09:00". */
  startsAtLocal: z.string().min(1),
  endsAtLocal: z.string().min(1),
  serviceCategories: z.array(z.string()).default([]),
  internalReason: z.string().max(500).optional(),
  publicReason: z.string().max(300).optional(),
});

function splitLocal(value: string): { date: string; time: string } | null {
  const [date, time] = value.split("T");
  if (!date || !time) return null;
  return { date, time: time.slice(0, 5) };
}

export type ExceptionFormState = {
  error?: string;
  ok?: boolean;
  /** Bookings that fall inside the window, so whoever is entering it can act. */
  clashes?: { id: string; startsAt: string; who: string; what: string }[];
} | null;

export async function createException(
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  // Checked here, not only in the page — a Server Action is reachable by direct
  // POST regardless of what UI was rendered.
  const user = await requireUser();

  const parsed = CreateException.safeParse({
    typeId: formData.get("typeId"),
    locationId: formData.get("locationId") ?? "",
    resourceId: formData.get("resourceId") ?? "",
    startsAtLocal: formData.get("startsAtLocal"),
    endsAtLocal: formData.get("endsAtLocal"),
    serviceCategories: formData.getAll("serviceCategories").map(String).filter(Boolean),
    internalReason: String(formData.get("internalReason") ?? "") || undefined,
    publicReason: String(formData.get("publicReason") ?? "") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const input = parsed.data;

  return asTenant(user, async (db) => {
    // Every id from the form is re-read inside the tenant scope. RLS means a
    // swapped id from another tenant simply is not found, rather than being
    // trusted because it looked plausible.
    const type = await db.exceptionType.findFirst({
      where: { id: input.typeId, tenantId: user.tenantId, active: true },
    });
    if (!type) return { error: "Pick a type." };

    const location = input.locationId
      ? await db.location.findFirst({
          where: { id: input.locationId, tenantId: user.tenantId },
        })
      : null;
    if (input.locationId && !location) return { error: "That location no longer exists." };

    if (input.resourceId) {
      const resource = await db.resource.findFirst({
        where: { id: input.resourceId, tenantId: user.tenantId },
      });
      if (!resource) return { error: "That person or room no longer exists." };
    }

    // Wall-clock in, instants out. Resolved against the LOCATION's zone, falling
    // back to the tenant's for a business-wide entry — never the server's.
    const timezone = location?.timezone ?? user.tenantTimezone;
    const from = splitLocal(input.startsAtLocal);
    const to = splitLocal(input.endsAtLocal);
    if (!from || !to) return { error: "Enter both a start and an end." };

    const startsAt = localToInstant(from.date, from.time, timezone);
    const endsAt = localToInstant(to.date, to.time, timezone);

    // null means the clock never reaches that time on that date — the hour a
    // spring-forward skips.
    if (!startsAt) return { error: `${from.time} doesn't exist on ${from.date} in ${timezone}.` };
    if (!endsAt) return { error: `${to.time} doesn't exist on ${to.date} in ${timezone}.` };
    if (endsAt <= startsAt) return { error: "The end must be after the start." };

    // ── Collision check ──────────────────────────────────────────────
    // Only for exceptions that REMOVE availability; an extra session cannot
    // conflict with anything.
    if (type.effect === "subtract") {
      const clashes = await db.booking.findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: ["held", "scheduled", "confirmed"] },
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
          ...(location ? { locationId: location.id } : {}),
          ...(input.resourceId
            ? { resources: { some: { resourceId: input.resourceId, active: true } } }
            : {}),
          ...(input.serviceCategories.length
            ? { service: { category: { in: input.serviceCategories } } }
            : {}),
        },
        include: { customer: true, service: true },
        orderBy: { startsAt: "asc" },
        take: 20,
      });

      if (clashes.length > 0 && type.onConflict === "block") {
        // Refuse rather than silently stranding customers who are expecting to
        // be seen. The list is returned so whoever is entering this can call
        // them, or move the bookings first.
        return {
          error: `${clashes.length} booking${clashes.length === 1 ? "" : "s"} fall inside that window. Move or cancel them first.`,
          clashes: clashes.map((b) => ({
            id: b.id,
            startsAt: b.startsAt.toISOString(),
            who: b.customer.name ?? b.customer.phone ?? "a customer",
            what: b.service.name,
          })),
        };
      }
    }

    const created = await db.scheduleException.create({
      data: {
        tenantId: user.tenantId,
        typeId: type.id,
        locationId: location?.id ?? null,
        resourceId: input.resourceId || null,
        startsAt,
        endsAt,
        serviceCategories: input.serviceCategories,
        // Only stored when the type permits saying it. Otherwise a well-meaning
        // note becomes something the assistant can repeat to a customer.
        publicReason: type.publicVisible ? (input.publicReason ?? null) : null,
        internalReason: input.internalReason ?? null,
        status: type.requiresApproval ? "requested" : "approved",
        requestedById: user.id,
        approvedById: type.requiresApproval ? null : user.id,
        approvedAt: type.requiresApproval ? null : new Date(),
      },
    });

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "exception.created",
        subject: `ScheduleException:${created.id}`,
        after: {
          type: type.code,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
      },
    });

    logger.info("exception created", { tenantId: user.tenantId, type: type.code });
    revalidatePath("/admin/exceptions");
    return { ok: true };
  });
}

export async function deleteException(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const existing = await db.scheduleException.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    // Already gone is the desired end state, not an error worth surfacing.
    if (!existing) return;

    await db.scheduleException.delete({ where: { id } });
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "exception.deleted",
        subject: `ScheduleException:${id}`,
        before: {
          startsAt: existing.startsAt.toISOString(),
          endsAt: existing.endsAt.toISOString(),
        },
      },
    });

    revalidatePath("/admin/exceptions");
  });
}

export async function approveException(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    await db.scheduleException.updateMany({
      where: { id, tenantId: user.tenantId, status: "requested" },
      data: { status: "approved", approvedById: user.id, approvedAt: new Date() },
    });
    revalidatePath("/admin/exceptions");
  });
}
