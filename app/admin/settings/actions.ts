"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { asTenant, requireRole } from "@/lib/auth/guard";
import { assertValidTimezone } from "@/lib/engine/time";
import { encrypt } from "@/lib/crypto";

export type SettingsFormState = { error?: string; ok?: string } | null;

/**
 * How the business wants to be spoken for.
 *
 * These three fields are the difference between a clinic's assistant and a
 * barber's. They used to be sentences hardcoded in the agent — which meant every
 * customer inherited a hair clinic's caution about anything "clinical", whether
 * they were a hair clinic or not. Moving them here is what lets one engine serve
 * businesses that have nothing in common.
 */
const SaveVoice = z.object({
  descriptor: z.string().max(1200),
  toneNote: z.string().max(600),
  escalationTopics: z.string().max(2000),
});

export async function saveVoice(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireRole("manager");

  const parsed = SaveVoice.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  // One topic per line — the field is a list of things a person typed, and
  // asking them to comma-separate sentences that contain commas is a trap.
  const topics = parsed.data.escalationTopics
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 25);

  return asTenant(user, async (db) => {
    await db.tenant.update({
      where: { id: user.tenantId },
      data: {
        descriptor: parsed.data.descriptor.trim() || null,
        toneNote: parsed.data.toneNote.trim() || null,
        escalationTopics: topics,
      },
    });

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "tenant.voice_updated",
        subject: `Tenant:${user.tenantId}`,
        after: { escalationTopics: topics.length },
      },
    });

    revalidatePath("/admin/settings");
    return { ok: "Saved. It applies to the next message a customer sends." };
  });
}

/**
 * Locations.
 *
 * Timezone is required and validated. There is no default anywhere in this
 * codebase — a location without one is an error, because inheriting silently is
 * how a schedule ends up an hour out for half the year.
 */
const CreateLocation = z.object({
  name: z.string().min(1, "Give it a name.").max(120),
  code: z.string().max(12),
  timezone: z.string().min(1, "Pick a timezone."),
});

export async function createLocation(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireRole("manager");

  const parsed = CreateLocation.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  try {
    assertValidTimezone(parsed.data.timezone);
  } catch {
    return { error: `'${parsed.data.timezone}' isn't a recognised IANA timezone.` };
  }

  return asTenant(user, async (db) => {
    await db.location.create({
      data: {
        tenantId: user.tenantId,
        name: parsed.data.name.trim(),
        code: parsed.data.code.trim() || null,
        timezone: parsed.data.timezone.trim(),
      },
    });
    revalidatePath("/admin/settings");
    return { ok: `${parsed.data.name} added.` };
  });
}

/**
 * Exception types — the tenant's own vocabulary.
 *
 * They choose the label, the priority, whether it needs approval, and whether a
 * customer may ever be told the reason. They do NOT choose the effect: `add` and
 * `subtract` are the only two verbs the engine understands, and keeping that
 * closed is what stops this becoming a rules language with no debugger.
 */
const CreateExceptionType = z.object({
  label: z.string().min(1, "Give it a name.").max(60),
  code: z
    .string()
    .min(1, "Give it a short code.")
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers and underscores only."),
  effect: z.enum(["subtract", "add"]),
  defaultPriority: z.coerce.number().int().min(0).max(1000),
  onConflict: z.enum(["block", "rebook"]),
  requiresApproval: z.string().optional(),
  publicVisible: z.string().optional(),
  defaultPublicReason: z.string().max(200),
});

export async function createExceptionType(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireRole("manager");

  const parsed = CreateExceptionType.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const input = parsed.data;

  const publicVisible = input.publicVisible === "on";
  if (publicVisible && !input.defaultPublicReason.trim()) {
    // Letting a type be customer-visible without wording means the assistant has
    // permission to explain but nothing approved to say — which is exactly when
    // it would improvise.
    return { error: "If customers may be told, write the wording they should hear." };
  }

  return asTenant(user, async (db) => {
    const clash = await db.exceptionType.findFirst({
      where: { tenantId: user.tenantId, code: input.code },
    });
    if (clash) return { error: `'${input.code}' is already used.` };

    await db.exceptionType.create({
      data: {
        tenantId: user.tenantId,
        code: input.code,
        label: input.label.trim(),
        effect: input.effect,
        defaultPriority: input.defaultPriority,
        onConflict: input.onConflict,
        requiresApproval: input.requiresApproval === "on",
        publicVisible,
        defaultPublicReason: publicVisible ? input.defaultPublicReason.trim() : null,
      },
    });

    revalidatePath("/admin/settings");
    revalidatePath("/admin/exceptions");
    return { ok: `${input.label} added.` };
  });
}

/**
 * WhatsApp credentials.
 *
 * ⚠️ Stored in plaintext. Encrypting these at rest is a go-live blocker, not a
 * refinement — a leaked row lets someone message this business's entire customer
 * list. The form says so, because a person entering a token deserves to know
 * where it lands.
 */
/**
 * Every limit names its own field.
 *
 * Zod's default is "Too big: expected string to have <=200 characters", which
 * is true and useless — it does not say which of four boxes is wrong, and the
 * most likely cause is an access token pasted into the app secret field, where
 * the length is the only clue anything is amiss.
 */
const SaveChannel = z.object({
  externalAccountId: z
    .string()
    .min(1, "Enter the phone number ID — the long number under the phone number, not the number itself.")
    .max(60, "That looks too long for a phone number ID. Check you copied the ID and not the access token."),
  displayNumber: z.string().max(30, "That is too long for a phone number."),
  accessToken: z
    .string()
    .max(500, "That access token is unusually long — check you pasted the right value."),
  appSecret: z
    .string()
    .max(200, "That is too long for an app secret. An app secret is about 32 characters; you may have pasted the access token."),
  verifyToken: z
    .string()
    .max(200, "That is too long for a verify token. It is the short password you chose, not one of Meta's values."),
});

export async function saveWhatsAppAccount(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireRole("owner");

  const parsed = SaveChannel.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const input = parsed.data;

  // The phone number id is globally unique — it routes inbound traffic to a
  // tenant, so two tenants claiming one number would make routing ambiguous.
  const { adminDb } = await import("@/lib/prisma");
  const owned = await adminDb.channelAccount.findUnique({
    where: { externalAccountId: input.externalAccountId },
    select: { tenantId: true },
  });
  if (owned && owned.tenantId !== user.tenantId) {
    return { error: "That number is already connected to another account." };
  }

  return asTenant(user, async (db) => {
    const existing = await db.channelAccount.findFirst({
      where: { tenantId: user.tenantId, channel: "whatsapp" },
    });

    const data = {
      displayNumber: input.displayNumber.trim() || null,
      // Blank means "leave what is there" — so re-saving the form to change the
      // display number does not wipe a token nobody retyped.
      ...(input.accessToken.trim() ? { accessToken: encrypt(input.accessToken.trim()) } : {}),
      ...(input.appSecret.trim() ? { appSecret: encrypt(input.appSecret.trim()) } : {}),
      ...(input.verifyToken.trim() ? { verifyToken: encrypt(input.verifyToken.trim()) } : {}),
    };

    if (existing) {
      await db.channelAccount.update({ where: { id: existing.id }, data });
    } else {
      await db.channelAccount.create({
        data: {
          tenantId: user.tenantId,
          channel: "whatsapp",
          externalAccountId: input.externalAccountId.trim(),
          ...data,
        },
      });
    }

    revalidatePath("/admin/settings");
    return { ok: "Saved." };
  });
}
