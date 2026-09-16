"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { asTenant, requireRole } from "@/lib/auth/guard";
import { assertValidTimezone } from "@/lib/engine/time";
import { encrypt, decrypt } from "@/lib/crypto";
import { isKnownModel, isKnownEffort } from "@/lib/conversation/models";
import {
  findVendor,
  isProviderFailure,
  recordProviderFailure,
  recordProviderOk,
  unsafeEndpointReason,
} from "@/lib/conversation/providers";
import { pingProvider } from "@/lib/conversation/drivers";
import { explainSendFailure, describeTokenLifetime } from "@/lib/channels/whatsapp";

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
    revalidatePath("/admin/settings/agent");
    return { ok: "Saved. It applies to the next message a customer sends." };
  });
}

/**
 * Everything else about how the assistant behaves.
 *
 * `agentInstructions` is the field owners mean when they ask to edit the prompt.
 * It goes high in the system prompt under a heading naming them as its author —
 * but ABOVE the correctness rules, deliberately, so a house rule and a safety
 * rule in conflict resolve toward the safety rule. What a tenant controls is
 * what the assistant says and does. What they cannot remove is the short list
 * that stops it inventing a price, re-rendering a time into the wrong timezone,
 * or announcing a slot it is itself holding as lost.
 *
 * Model and effort are checked against lib/conversation/models.ts rather than
 * taken as text. An unknown id would not fail here; it would fail later, on
 * every message, for one tenant, which is the hardest kind of fault to notice.
 */
const SaveAgent = z.object({
  agentInstructions: z.string().max(8000),
  agentModel: z.string().refine(isKnownModel, "That is not a model we offer."),
  agentEffort: z.string().refine(isKnownEffort, "Choose how carefully it should think."),
});

export async function saveAgent(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireRole("manager");

  const parsed = SaveAgent.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  return asTenant(user, async (db) => {
    await db.tenant.update({
      where: { id: user.tenantId },
      data: {
        agentInstructions: parsed.data.agentInstructions.trim() || null,
        agentModel: parsed.data.agentModel,
        agentEffort: parsed.data.agentEffort,
      },
    });

    // Recorded because this is the setting most able to change what customers
    // are told, and "who widened what the assistant may say, and when" is a
    // question that only gets asked after something has already gone wrong.
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "tenant.agent_updated",
        subject: `Tenant:${user.tenantId}`,
        after: {
          model: parsed.data.agentModel,
          effort: parsed.data.agentEffort,
          instructionChars: parsed.data.agentInstructions.trim().length,
        },
      },
    });

    revalidatePath("/admin/settings/agent");
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
      // The phone number id is editable after the fact, and has to be.
      //
      // It used to be create-only, and the form rendered it read-only to match.
      // But it is the single easiest value to get wrong — Meta shows the
      // WhatsApp Business Account id immediately beside it — and getting it
      // wrong is invisible: verification still succeeds, and inbound messages
      // are then silently dropped as "unknown account". Being unable to correct
      // it without database access made a typo unrecoverable.
      await db.channelAccount.update({
        where: { id: existing.id },
        data: { ...data, externalAccountId: input.externalAccountId.trim() },
      });
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

/**
 * Asks Meta whether the saved credentials still work. Sends no message.
 *
 * The failure this exists for is silent by construction: Meta's test-app access
 * tokens expire a day after they are issued, and the only symptom is customers
 * not being answered. The assistant keeps writing good replies; Meta keeps
 * refusing them; the server log is the only place it shows. Nobody running a
 * business is reading the server log.
 *
 * So there is a button. It answers the two questions in order — is the token
 * still good, and is the phone number id the right one — and says what to do
 * about each, in the words used on the rest of this page.
 */
export async function testWhatsAppConnection(): Promise<SettingsFormState> {
  const user = await requireRole("manager");

  return asTenant(user, async (db) => {
    const account = await db.channelAccount.findFirst({
      where: { tenantId: user.tenantId, channel: "whatsapp" },
    });

    if (!account?.accessToken) {
      return { error: "No access token has been saved yet, so nothing can be sent." };
    }

    let res: Response;
    try {
      res = await fetch(
        `https://graph.facebook.com/v21.0/${account.externalAccountId}` +
          `?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${decrypt(account.accessToken)}` } },
      );
    } catch {
      return { error: "We could not reach WhatsApp just now. Try again in a moment." };
    }

    const body = (await res.json().catch(() => ({}))) as {
      display_phone_number?: string;
      verified_name?: string;
      error?: { code?: number };
    };

    if (res.status === 200) {
      const who = `WhatsApp knows this number as ${body.verified_name} · ${body.display_phone_number}.`;
      const life = await describeTokenLifetime(decrypt(account.accessToken));

      // Said now, while it still works, because the alternative is finding out
      // from a customer who never got a reply.
      if (life?.neverExpires) return { ok: `Working, and this token never expires. ${who}` };
      if (life && life.hoursLeft !== null) {
        return life.hoursLeft <= 24
          ? {
              ok:
                `Working — but this token runs out in about ${Math.max(0, life.hoursLeft)} hours, ` +
                `and replies stop silently when it does. ${who} See “Stop having to do this every day” below.`,
            }
          : { ok: `Working. This token has about ${life.hoursLeft} hours left. ${who}` };
      }
      return { ok: `Working. ${who}` };
    }

    return { error: explainSendFailure(body.error?.code, res.status) };
  });
}

/**
 * Which API key answers customers: cadence's, or the business's own.
 *
 * Owner-only, like the WhatsApp credentials and for the same two reasons — it is
 * a secret, and it spends money. A manager can change how the assistant sounds;
 * whose account pays for it is the owner's decision.
 *
 * Two shapes in one action, because they are one choice on one form. Choosing
 * cadence's key does NOT delete what was saved: it sets `active` false, so
 * switching back next week does not mean finding the key again. A key that is
 * genuinely finished with is removed by the button that says so.
 */
const SaveProvider = z.object({
  source: z.enum(["cadence", "own"]),
  // Everything below defaults to empty rather than being required, because the
  // form legitimately submits without them: choosing cadence's key renders no
  // fields at all, and a preset vendor supplies its own address.
  vendor: z.string().max(40).default(""),
  baseUrl: z.string().max(400).default(""),
  apiKey: z
    .string()
    .max(500, "That key is unusually long — check you pasted only the key.")
    // A pasted key with a space in it is a truncated paste or two values at
    // once, and the error it causes at the provider is a flat 401 that names
    // nothing.
    .refine((v) => !/\s/.test(v.trim()), "That key contains a space. Paste just the key.")
    .default(""),
  model: z
    .string()
    .max(120)
    .refine((v) => !/\s/.test(v.trim()), "A model id has no spaces in it.")
    .default(""),
});

export async function saveModelProvider(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await requireRole("owner");

  const parsed = SaveProvider.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const input = parsed.data;

  return asTenant(user, async (db) => {
    const existing = await db.modelProvider.findFirst({ where: { tenantId: user.tenantId } });

    // ── Back to cadence's key ────────────────────────────────────────
    if (input.source === "cadence") {
      if (existing?.active) {
        await db.modelProvider.update({ where: { id: existing.id }, data: { active: false } });
        await audit(db, user, "tenant.model_provider_disabled", { vendor: existing.vendor });
      }
      revalidatePath("/admin/settings/model");
      revalidatePath("/admin/settings/agent");
      return { ok: "Answers now run on cadence's key. Your own is kept, not deleted." };
    }

    // ── Their own key ────────────────────────────────────────────────
    const vendor = findVendor(input.vendor);
    if (!vendor) return { error: "Choose who provides the model." };

    const model = input.model.trim();
    if (!model) {
      return {
        error: `Enter the model id to use${
          vendor.exampleModels.length > 0 ? ` — for example ${vendor.exampleModels[0]}` : ""
        }.`,
      };
    }

    // A preset's address is ours to supply; "anything else" has to be told.
    const baseUrl = vendor.customBaseUrl ? input.baseUrl.trim() : vendor.baseUrl;
    if (vendor.protocol === "openai") {
      if (!baseUrl) return { error: "Enter the address of the API you want to use." };
      const unsafe = unsafeEndpointReason(baseUrl);
      if (unsafe) return { error: unsafe };
    }

    // Blank means "leave the key alone", so changing only the model does not
    // wipe a credential nobody retyped. There has to be one already, though.
    const key = input.apiKey.trim();
    if (!key && !existing) return { error: `Paste the API key from ${vendor.keySource}.` };
    if (key && vendor.keyPrefix && !key.startsWith(vendor.keyPrefix)) {
      return {
        error: `${vendor.label} keys start with "${vendor.keyPrefix}". Check you copied the key itself and not an id.`,
      };
    }

    const data = {
      protocol: vendor.protocol,
      vendor: vendor.id,
      baseUrl: baseUrl ?? null,
      model,
      active: true,
      // Anything saved is a change worth re-testing, so a failure recorded
      // against the previous key is cleared rather than left to accuse the new
      // one.
      lastFailureAt: null,
      lastFailureNote: null,
    };

    if (existing) {
      await db.modelProvider.update({
        where: { id: existing.id },
        // A blank key field leaves the stored one alone.
        data: { ...data, ...(key ? { apiKey: encrypt(key) } : {}) },
      });
    } else {
      // Unreachable without a key: the check above returns first.
      await db.modelProvider.create({
        data: { tenantId: user.tenantId, ...data, apiKey: encrypt(key) },
      });
    }

    await audit(db, user, "tenant.model_provider_updated", {
      vendor: vendor.id,
      protocol: vendor.protocol,
      model,
      // Never the key, and never enough of it to be one.
      keyChanged: Boolean(key),
    });

    revalidatePath("/admin/settings/model");
    revalidatePath("/admin/settings/agent");
    return {
      ok: `Saved. Customers are now answered on your own ${vendor.label} key — check it works below.`,
    };
  });
}

/**
 * Asks the provider two questions, in one request, before a customer does.
 *
 * Does the key work, and does this model call tools. The second is the one that
 * catches the expensive mistake: plenty of OpenAI-compatible endpoints
 * authenticate perfectly and ignore the tools entirely, and the symptom is an
 * assistant that chats beautifully and never books anything — a fault that looks
 * like a bad model rather than a bad setup, and that otherwise gets found by a
 * customer.
 */
export async function testModelProvider(): Promise<SettingsFormState> {
  const user = await requireRole("manager");

  return asTenant(user, async (db) => {
    const row = await db.modelProvider.findFirst({ where: { tenantId: user.tenantId } });
    if (!row) return { error: "No key of your own is saved, so there is nothing to check." };

    const vendorLabel = findVendor(row.vendor)?.label ?? row.vendor;

    let result;
    try {
      result = await pingProvider({
        protocol: row.protocol === "anthropic" ? "anthropic" : "openai",
        apiKey: decrypt(row.apiKey),
        baseUrl: row.baseUrl,
        model: row.model,
        vendorLabel,
      });
    } catch (err) {
      const note = isProviderFailure(err)
        ? err.note
        : `Something went wrong reaching ${vendorLabel}.`;
      await recordProviderFailure(db, user.tenantId, note);
      revalidatePath("/admin/settings/model");
      return { error: note };
    }

    await recordProviderOk(db, user.tenantId);
    revalidatePath("/admin/settings/model");

    if (!result.toolsWork) {
      // Not an error — the key is fine. But this model cannot do the part of
      // the job that matters, and saying "working" here would be a lie that
      // holds until someone tries to book.
      return {
        error:
          `${vendorLabel} answered, so the key is good — but ${row.model} did not call the tool it was given. ` +
          `A model that ignores tools can chat, and cannot check availability or book. ` +
          `Try a model your provider lists as supporting function calling.`,
      };
    }

    return { ok: `Working. ${vendorLabel} answered on ${row.model}, and it uses tools correctly.` };
  });
}

/** Deletes the saved key. The business goes back to cadence's on the next message. */
export async function forgetModelProvider(): Promise<SettingsFormState> {
  const user = await requireRole("owner");

  return asTenant(user, async (db) => {
    const deleted = await db.modelProvider.deleteMany({ where: { tenantId: user.tenantId } });
    if (deleted.count === 0) return { error: "There was nothing saved." };

    await audit(db, user, "tenant.model_provider_removed", {});
    revalidatePath("/admin/settings/model");
    revalidatePath("/admin/settings/agent");
    return { ok: "Removed. Customers are answered on cadence's key again." };
  });
}

/**
 * Who changed whose key, and when.
 *
 * Recorded for every branch above, because this is the setting that decides
 * where a business's customer conversations are sent — and "when did we start
 * sending these somewhere else" is a question that only ever gets asked late.
 */
async function audit(
  db: Parameters<Parameters<typeof asTenant>[1]>[0],
  user: { id: string; tenantId: string },
  action: string,
  after: Prisma.InputJsonObject,
) {
  await db.auditLog.create({
    data: {
      tenantId: user.tenantId,
      actor: `user:${user.id}`,
      action,
      subject: `Tenant:${user.tenantId}`,
      after,
    },
  });
}
