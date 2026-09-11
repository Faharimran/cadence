"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { adminDb } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { assertValidTimezone } from "@/lib/engine/time";
import { createSession } from "@/lib/auth/session";
import { provisionTenant } from "@/lib/provision";
import { findPreset } from "@/lib/presets";
import { clientIp } from "@/lib/demo/session";
import { consumeSignupBudget, signupLimitMessage } from "@/lib/signupLimit";

/**
 * Creating a business and its first user.
 *
 * The only unauthenticated write in the product, which is why the checks are
 * spelled out rather than inherited: the signup flag is read here as well as in
 * the page, because a Server Action is reachable by direct POST whether or not
 * the page rendered — and the rate limit is applied here for the same reason.
 */

const SignUp = z.object({
  businessName: z.string().min(2, "What's the business called?").max(120),
  timezone: z.string().min(1, "Pick a timezone."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Currency is a three-letter code, like GBP or INR."),
  presetId: z.string().min(1, "Pick the closest kind of business."),
  email: z.string().email("That doesn't look like an email address."),
  name: z.string().max(120).optional(),
  // Long rather than complex: a length floor is the only password rule that
  // reliably helps, and the rest just produce Password1!.
  password: z.string().min(12, "Use at least 12 characters."),
});

export type SignUpState = { error?: string } | null;

export async function signUp(_previous: SignUpState, formData: FormData): Promise<SignUpState> {
  if (env.CADENCE_SIGNUP_OPEN !== "true") return { error: "Sign-up is closed." };

  const parsed = SignUp.safeParse({
    businessName: formData.get("businessName"),
    timezone: formData.get("timezone"),
    currency: formData.get("currency"),
    presetId: formData.get("presetId"),
    email: formData.get("email"),
    name: String(formData.get("name") ?? "") || undefined,
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  const input = parsed.data;

  if (!findPreset(input.presetId)) return { error: "Pick the closest kind of business." };

  try {
    assertValidTimezone(input.timezone);
  } catch {
    return { error: `'${input.timezone}' isn't a recognised timezone.` };
  }

  // Metered here rather than above, so a mistyped password does not cost
  // somebody their attempt. Everything before this point is cheap to reject.
  const budget = await consumeSignupBudget(clientIp(await headers()));
  if (!budget.ok) return { error: signupLimitMessage(budget.scope) };

  let provisioned;
  try {
    provisioned = await provisionTenant(adminDb, {
      businessName: input.businessName.trim(),
      timezone: input.timezone.trim(),
      currency: input.currency.toUpperCase(),
      presetId: input.presetId,
      owner: { email: input.email, name: input.name, password: input.password },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    logger.warn("signup failed", { err: message });
    // The duplicate-email message is safe to show: this form creates accounts,
    // so "already taken" is information the person needs and cannot be used to
    // enumerate anything they could not discover by trying to sign up.
    return { error: message };
  }

  await createSession(provisioned.userId, provisioned.tenantId);

  // Straight into the checklist, which now knows exactly which of its steps the
  // preset already completed and which still need this business's own answers.
  redirect("/admin");
}
