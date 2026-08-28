"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asTenant, requireRole } from "@/lib/auth/guard";

/**
 * What the business sells.
 *
 * Two fields here have consequences well beyond this screen:
 *
 *   `priceQuotable` — when false the price is never loaded into the assistant's
 *   context at all, so there is no figure for it to repeat. Withholding beats
 *   instructing.
 *
 *   `requirements` — what a booking must occupy. Without at least one, a service
 *   is bookable against nothing, so the engine falls back to "one resource of
 *   any kind" rather than offering a slot no one can staff.
 */

const CreateService = z.object({
  name: z.string().min(1, "Give it a name.").max(120),
  category: z.string().max(60),
  durationMinutes: z.coerce.number().int().min(5).max(1440),
  bufferBeforeMinutes: z.coerce.number().int().min(0).max(240),
  bufferAfterMinutes: z.coerce.number().int().min(0).max(240),
  /** Major units as typed — "250" or "39.50". Converted to minor units below. */
  price: z.string().max(20),
  priceQuotable: z.string().optional(),
  requirementTags: z.string().max(200),
  requirementKind: z.enum(["any", "person", "room", "equipment"]),
  requirementQuantity: z.coerce.number().int().min(1).max(10),
});

export type ServiceFormState = { error?: string; ok?: string } | null;

export async function createService(
  _previous: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const user = await requireRole("manager");

  const parsed = CreateService.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const input = parsed.data;

  // Money is stored as an integer in minor units so no float rounding ever
  // touches a price. Parsed here, at the boundary, exactly once.
  let priceMinor: number | null = null;
  const trimmed = input.price.trim();
  if (trimmed) {
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return { error: "That price isn't a number." };
    priceMinor = Math.round(value * 100);
  }

  const tags = input.requirementTags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return asTenant(user, async (db) => {
    const service = await db.service.create({
      data: {
        tenantId: user.tenantId,
        name: input.name.trim(),
        category: input.category.trim() || null,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
        priceMinor,
        priceQuotable: input.priceQuotable === "on",
        requirements: {
          create: [
            {
              tenantId: user.tenantId,
              tags,
              kind: input.requirementKind === "any" ? null : input.requirementKind,
              quantity: input.requirementQuantity,
            },
          ],
        },
      },
    });

    revalidatePath("/admin/services");
    return { ok: `${service.name} added.` };
  });
}

export async function toggleService(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const service = await db.service.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { active: true },
    });
    if (!service) return;
    await db.service.update({ where: { id }, data: { active: !service.active } });
    revalidatePath("/admin/services");
  });
}

/** Flips whether the assistant may say this service's price out loud. */
export async function togglePriceQuotable(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const service = await db.service.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { priceQuotable: true },
    });
    if (!service) return;
    await db.service.update({
      where: { id },
      data: { priceQuotable: !service.priceQuotable },
    });
    revalidatePath("/admin/services");
  });
}
