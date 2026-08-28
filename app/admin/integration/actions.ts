"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Capability, CapabilityMode } from "@prisma/client";
import { asTenant, requireRole, requireUser } from "@/lib/auth/guard";
import { generateApiKey } from "@/lib/api/auth";
import { newSigningSecret, sealSecret } from "@/lib/webhooks/deliver";

export type IntegrationFormState =
  | { error?: string; ok?: string; /** Shown once, never retrievable again. */ secret?: string }
  | null;

/**
 * Issues an API key.
 *
 * The plaintext is returned exactly once and then unrecoverable — only a
 * peppered hash is stored. That is the whole reason this returns a `secret`
 * field the UI has to display prominently rather than quietly saving somewhere.
 */
export async function createKey(
  _previous: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const user = await requireRole("owner");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name it, so you know what to revoke later." };

  const scopes = formData.getAll("scopes").map(String).filter(Boolean);
  if (scopes.length === 0) return { error: "Pick at least one scope." };

  const { prefix, secret, hash } = generateApiKey();

  return asTenant(user, async (db) => {
    await db.apiKey.create({
      data: { tenantId: user.tenantId, name, prefix, hash, scopes },
    });
    revalidatePath("/admin/integration");
    return { ok: `${name} created.`, secret: `${prefix}.${secret}` };
  });
}

export async function revokeKey(formData: FormData): Promise<void> {
  const user = await requireRole("owner");
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    // Revoked rather than deleted: the row is how you explain a 401 in someone's
    // logs three weeks later.
    await db.apiKey.updateMany({
      where: { id, tenantId: user.tenantId },
      data: { revokedAt: new Date() },
    });
    revalidatePath("/admin/integration");
  });
}

const CreateEndpoint = z.object({
  url: z.string().url("That doesn't look like a URL."),
  events: z.array(z.string()).default([]),
});

export async function createEndpoint(
  _previous: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const user = await requireRole("owner");

  const parsed = CreateEndpoint.safeParse({
    url: formData.get("url"),
    events: formData.getAll("events").map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  if (!parsed.data.url.startsWith("https://") && !parsed.data.url.includes("localhost")) {
    return { error: "Use https — these payloads carry customer names and times." };
  }

  const secret = newSigningSecret();

  return asTenant(user, async (db) => {
    await db.webhookEndpoint.create({
      data: {
        tenantId: user.tenantId,
        url: parsed.data.url,
        secret: sealSecret(secret),
        // Empty means every event, which is the sane default for a first
        // integration — you can narrow it once you know what you use.
        events: parsed.data.events,
      },
    });
    revalidatePath("/admin/integration");
    return { ok: "Endpoint added.", secret };
  });
}

export async function toggleEndpoint(formData: FormData): Promise<void> {
  const user = await requireRole("owner");
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const endpoint = await db.webhookEndpoint.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { active: true },
    });
    if (!endpoint) return;
    await db.webhookEndpoint.update({
      where: { id },
      // Re-enabling clears the auto-disable note, otherwise the UI keeps
      // accusing an endpoint that has since been fixed.
      data: { active: !endpoint.active, disabledReason: null },
    });
    revalidatePath("/admin/integration");
  });
}

/** Queues a real event through the real pipeline, so the test proves the pipeline. */
export async function sendTestEvent(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const endpoint = await db.webhookEndpoint.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!endpoint) return;

    await db.webhookDelivery.create({
      data: {
        tenantId: user.tenantId,
        endpointId: endpoint.id,
        event: "booking.created",
        payload: {
          event: "booking.created",
          occurredAt: new Date().toISOString(),
          test: true,
          data: {
            bookingId: "test_booking",
            customerId: "test_customer",
            startsAt: new Date(Date.now() + 86_400_000).toISOString(),
            status: "held",
          },
        } as never,
      },
    });
    revalidatePath("/admin/integration");
  });
}

const SetCapability = z.object({
  capability: z.string().min(1),
  mode: z.enum(["hosted", "brokered"]),
  connector: z.string().max(60),
});

export async function setCapability(formData: FormData): Promise<void> {
  const user = await requireRole("owner");

  const parsed = SetCapability.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;
  const { capability, mode, connector } = parsed.data;

  await asTenant(user, async (db) => {
    await db.tenantCapability.upsert({
      where: {
        tenantId_capability: {
          tenantId: user.tenantId,
          capability: capability as Capability,
        },
      },
      create: {
        tenantId: user.tenantId,
        capability: capability as Capability,
        mode: mode as CapabilityMode,
        connector: connector.trim() || null,
      },
      update: { mode: mode as CapabilityMode, connector: connector.trim() || null },
    });
    revalidatePath("/admin/integration");
  });
}
