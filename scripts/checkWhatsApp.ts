/**
 * Asks Meta whether the credentials we have stored still work. Sends nothing.
 *
 * This exists because "the assistant replied but nothing arrived" has exactly
 * one cause worth checking first and no way to see it from the admin console:
 * the access token. Meta's *test* app tokens expire 24 hours after they are
 * issued, silently, and the only symptom is every outbound message failing with
 * "Authentication Error" while the assistant carries on generating perfectly
 * good replies into the void.
 *
 * Distinguishing the three failures matters, because the fixes differ:
 *
 *   expired / invalid token  → get a new one from Meta's API Setup page
 *   wrong phone number id    → the WABA id was pasted instead; both sit on the
 *                              same screen and both look plausible
 *   number not registered    → finish setup on Meta's side
 *
 * Never prints a credential. The token's age and its last four characters are
 * enough to tell one token from another when checking whether a new one
 * actually got saved.
 *
 * Run locally:      npm run check:whatsapp
 * Against Railway:  railway run --service cadence-worker npm run check:whatsapp
 */
import { adminDb } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { decrypt } from "@/lib/crypto";

const SLUG = process.env.CADENCE_TENANT ?? "cara-clinic";

async function main() {
  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: SLUG } });
  const account = await adminDb.channelAccount.findFirst({
    where: { tenantId: tenant.id, channel: "whatsapp" },
  });

  console.log(`\n${"─".repeat(64)}`);
  console.log(`${tenant.name} · WhatsApp credentials`);
  console.log("─".repeat(64));

  if (!account) {
    console.log("\nNo WhatsApp account saved at all. Add one at /admin/settings/whatsapp.");
    return;
  }

  console.log(`phone number id   ${account.externalAccountId}`);
  console.log(`display number    ${account.displayNumber ?? "(not set)"}`);
  console.log(`active            ${account.active}`);
  console.log(`app secret        ${account.appSecret ? "saved" : "MISSING — inbound will 401"}`);

  if (!account.accessToken) {
    console.log("\nNo access token saved. Nothing can be sent.");
    return;
  }

  const token = decrypt(account.accessToken);
  const age = Math.round((Date.now() - account.updatedAt.getTime()) / 3_600_000);
  console.log(`access token      …${token.slice(-4)}, saved ${age}h ago`);

  // A test-app token is 24 hours old at most. Saying so before the API call
  // means the answer is already framed when it arrives.
  if (age >= 24) {
    console.log(
      `\n  ⚠ Saved ${age} hours ago. Meta's test-app tokens last 24 hours,\n` +
        `    so this one has very likely expired.`,
    );
  }

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${account.externalAccountId}` +
      `?fields=display_phone_number,verified_name,quality_rating,platform_type`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    platform_type?: string;
    error?: { message?: string; type?: string; code?: number };
  };

  console.log(`\nMeta answered HTTP ${res.status}`);

  if (res.status === 200) {
    console.log(`  ✓ ${body.verified_name} · ${body.display_phone_number}`);
    if (body.quality_rating) console.log(`  quality rating: ${body.quality_rating}`);
    if (body.platform_type) console.log(`  platform: ${body.platform_type}`);
    console.log(`\nThe token works and the phone number id is right.`);
    console.log(
      `If messages still are not arriving, the next thing to check is the\n` +
        `24-hour window: a business may only send free-form messages within\n` +
        `24 hours of that person's last message to it.`,
    );
  } else {
    console.log(`  ✗ ${body.error?.type ?? "error"}: ${body.error?.message ?? "(no message)"}`);
    const code = body.error?.code;
    if (code === 190 || res.status === 401) {
      console.log(
        `\nThe access token is expired or has been revoked.\n` +
          `Get a fresh one from Meta → your app → WhatsApp → API Setup, and save\n` +
          `it at /admin/settings/whatsapp. Nothing else needs changing.`,
      );
    } else if (code === 100) {
      console.log(
        `\nMeta does not recognise ${account.externalAccountId} as a phone number id.\n` +
          `The WhatsApp Business Account id sits right beside it on the same\n` +
          `screen and is the usual thing pasted here by mistake — it is the one\n` +
          `under the "From" number that you want.`,
      );
    }
  }
  console.log("─".repeat(64));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
