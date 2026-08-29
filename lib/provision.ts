import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/auth/password";
import { findPreset } from "@/lib/presets";
import { logger } from "@/lib/logger";

/**
 * Creating a business.
 *
 * Runs as the owner role rather than through `withTenant`, because there is no
 * tenant to scope to until this function has made one. That is the single
 * legitimate cross-tenant write in the product, which is why it lives in one
 * named place instead of being inlined into a route handler.
 *
 * What it produces is a tenant that already passes half its own readiness
 * checklist: a location, a couple of services, its own words for time off, and
 * one draft article showing what a good one looks like. The remaining steps —
 * who works there and when — are the ones only the business can answer, and
 * they are what the checklist then asks for.
 */

export type ProvisionInput = {
  businessName: string;
  timezone: string;
  currency: string;
  presetId: string;
  owner: { email: string; name?: string; password: string };
};

export type ProvisionResult = { tenantId: string; userId: string; slug: string };

export async function provisionTenant(
  db: PrismaClient,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const preset = findPreset(input.presetId);
  if (!preset) throw new Error(`Unknown preset: ${input.presetId}`);

  const email = input.owner.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw new Error("That email already has an account.");

  const slug = await uniqueSlug(db, input.businessName);
  const passwordHash = await hashPassword(input.owner.password);

  // One transaction: a half-created business — a tenant with no owner, say — is
  // unreachable and unfixable through the UI, since signing in is the only way
  // back to it.
  const result = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug,
        name: input.businessName,
        timezone: input.timezone,
        currency: input.currency,
        vertical: preset.id,
        descriptor: preset.descriptor || null,
        toneNote: preset.toneNote || null,
        escalationTopics: preset.escalationTopics,
      },
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email,
        name: input.owner.name?.trim() || null,
        passwordHash,
        role: "owner",
      },
    });

    await tx.tenantCapability.createMany({
      data: preset.capabilities.map((capability) => ({ tenantId: tenant.id, capability })),
    });

    await tx.exceptionType.createMany({
      data: preset.exceptionTypes.map((t) => ({
        tenantId: tenant.id,
        code: t.code,
        label: t.label,
        effect: t.effect,
        defaultPriority: t.priority,
        publicVisible: t.publicVisible ?? false,
        defaultPublicReason: t.publicReason ?? null,
        // "Closed" is the one every business needs and nobody should be able to
        // delete out from under the availability engine.
        systemLocked: t.code === "closed",
      })),
    });

    // The business's own name is a better first location than "Main branch":
    // single-site businesses never rename it, and multi-site ones immediately
    // see what the field is for.
    const location = await tx.location.create({
      data: { tenantId: tenant.id, name: input.businessName, timezone: input.timezone },
    });

    for (const service of preset.services) {
      await tx.service.create({
        data: {
          tenantId: tenant.id,
          name: service.name,
          category: service.category,
          durationMinutes: service.durationMinutes,
          requirements: {
            create: [{ tenantId: tenant.id, tags: service.requires, kind: "person", quantity: 1 }],
          },
        },
      });
    }

    // Draft, always. The point of the approval step is undermined the moment
    // something we wrote is live in a customer conversation on day one.
    await tx.knowledgeDoc.create({
      data: {
        tenantId: tenant.id,
        title: preset.starterDoc.title,
        body: preset.starterDoc.body,
        tags: preset.starterDoc.tags,
        status: "draft",
        authorId: user.id,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        actor: `user:${user.id}`,
        action: "tenant.provisioned",
        subject: `Tenant:${tenant.id}`,
        after: { slug, preset: preset.id, timezone: input.timezone, currency: input.currency },
      },
    });

    return { tenantId: tenant.id, userId: user.id, slug, locationId: location.id };
  });

  logger.info("tenant provisioned", { slug, preset: preset.id });
  return { tenantId: result.tenantId, userId: result.userId, slug: result.slug };
}

/**
 * A readable slug, deduplicated by suffix.
 *
 * Loops rather than trusting a single check because two people can sign up with
 * the same business name in the same second; the unique index is the real
 * guarantee and this just avoids hitting it in the common case.
 */
async function uniqueSlug(db: PrismaClient, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business";

  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const taken = await db.tenant.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
