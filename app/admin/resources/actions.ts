"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asTenant, requireRole } from "@/lib/auth/guard";

/**
 * People, rooms and equipment.
 *
 * One model for all three, because the availability maths is identical and a
 * booking routinely needs several at once — a stylist AND a chair, a surgeon AND
 * a theatre.
 */

const CreateResource = z.object({
  name: z.string().min(1, "Give them a name.").max(120),
  kind: z.enum(["person", "room", "equipment"]),
  /** Free text, comma separated. Services match against these. */
  tags: z.string().max(300),
  locationIds: z.array(z.string()).default([]),
});

export type ResourceFormState = { error?: string; ok?: string } | null;

export async function createResource(
  _previous: ResourceFormState,
  formData: FormData,
): Promise<ResourceFormState> {
  const user = await requireRole("manager");

  const parsed = CreateResource.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind"),
    tags: formData.get("tags") ?? "",
    locationIds: formData.getAll("locationIds").map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  const { name, kind, locationIds } = parsed.data;
  const tags = parsed.data.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return asTenant(user, async (db) => {
    const resource = await db.resource.create({
      data: { tenantId: user.tenantId, name: name.trim(), kind, tags },
    });

    if (locationIds.length > 0) {
      // Re-read inside the tenant scope; an id from elsewhere simply is not found.
      const valid = await db.location.findMany({
        where: { id: { in: locationIds }, tenantId: user.tenantId },
        select: { id: true },
      });
      await db.resourceLocation.createMany({
        data: valid.map((l) => ({
          tenantId: user.tenantId,
          resourceId: resource.id,
          locationId: l.id,
        })),
      });
    }

    revalidatePath("/admin/resources");
    revalidatePath("/admin/schedules");
    return {
      ok:
        locationIds.length === 0
          ? `${resource.name} added — assign hours to make them bookable.`
          : `${resource.name} added.`,
    };
  });
}

export async function toggleResource(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const resource = await db.resource.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { active: true },
    });
    if (!resource) return;

    // Deactivating is not deleting: existing bookings keep their resource, and
    // the audit trail survives. It only stops new ones being made.
    await db.resource.update({ where: { id }, data: { active: !resource.active } });
    revalidatePath("/admin/resources");
  });
}
