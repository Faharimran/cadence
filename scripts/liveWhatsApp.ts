/**
 * Drives one real WhatsApp conversation end to end, against Meta.
 *
 * Why this exists: everything about receiving a message is provable locally and
 * is (scripts/proveWebhook.ts, 22 assertions). What is NOT provable that way is
 * the last leg — `sendText` calling Meta's Graph API with a genuine token and a
 * genuine number, which either works or does not and cannot be mocked into
 * telling the truth.
 *
 * So this synthesises the inbound half and lets the real half be real:
 *
 *   1. builds the exact payload Meta posts for a text message
 *   2. signs it with the tenant's stored app secret, so the receiving code path
 *      is the same one Meta's traffic takes — signature check included
 *   3. posts it to the LOCAL webhook endpoint
 *   4. the worker picks it up, runs a real agent turn, and sends a real reply
 *
 * What it does NOT do is change any webhook subscription. That matters when the
 * credentials belong to a live business: repointing `whatsapp_business_account`
 * would divert real customers' messages away from wherever they currently go.
 * This test needs none of that.
 *
 * It DOES send a real WhatsApp message to the number you name, from the
 * business's real number. Only run it against a phone you own.
 *
 * Meta's 24-hour rule applies: a business may only send a free-form message
 * within 24 hours of that person's last message to it. If nothing arrives and
 * the log shows a 131047, that is why — message the business number first.
 *
 * Run: npm run live:whatsapp -- <your-number-in-international-format> ["message"]
 *      npm run live:whatsapp -- 919820011223 "what are your opening hours?"
 */
import { createHmac } from "node:crypto";
import { adminDb, withTenant } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { decrypt } from "@/lib/crypto";

const TENANT_SLUG = process.env.CADENCE_TENANT ?? "cara-clinic";
const BASE = process.env.CADENCE_TEST_URL ?? "http://localhost:3200";

async function main() {
  const to = (process.argv[2] ?? "").replace(/[^\d]/g, "");
  const text = process.argv[3] ?? "what are your opening hours?";

  if (!to) {
    console.error("Usage: npm run live:whatsapp -- <number> [message]");
    console.error('  e.g. npm run live:whatsapp -- 919820011223 "do you do PRP?"');
    process.exit(1);
  }

  const tenant = await adminDb.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
  const account = await adminDb.channelAccount.findFirst({
    where: { tenantId: tenant.id, channel: "whatsapp", active: true },
  });

  if (!account?.accessToken || !account.appSecret) {
    console.error(
      `${tenant.name} has no WhatsApp credentials saved. Add them at /admin/settings/whatsapp.`,
    );
    process.exit(1);
  }

  const appSecret = decrypt(account.appSecret);

  // Confirm the token is alive before sending anything, so an expired one
  // reports itself rather than surfacing as "no reply arrived".
  const probe = await fetch(
    `https://graph.facebook.com/v21.0/${account.externalAccountId}?fields=display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${decrypt(account.accessToken)}` } },
  );
  const probeBody = (await probe.json()) as { display_phone_number?: string; verified_name?: string };
  if (probe.status !== 200) {
    console.error(`Meta rejected the stored access token (HTTP ${probe.status}).`);
    console.error(JSON.stringify(probeBody));
    console.error("Get a fresh one from API Setup and save it at /admin/settings/whatsapp.");
    process.exit(1);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(`${probeBody.verified_name} · ${probeBody.display_phone_number}`);
  console.log(`sending as if +${to} had written: "${text}"`);
  console.log("─".repeat(66));

  // Exactly the shape Meta posts for an inbound text.
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: probeBody.display_phone_number,
                phone_number_id: account.externalAccountId,
              },
              contacts: [{ profile: { name: "Live test" }, wa_id: to }],
              messages: [
                {
                  from: to,
                  id: `wamid.live.${Date.now()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const signature = `sha256=${createHmac("sha256", appSecret).update(payload).digest("hex")}`;

  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: payload,
  });
  console.log(`\nwebhook accepted it: HTTP ${res.status}`);
  if (res.status !== 200) {
    console.error(await res.text());
    process.exit(1);
  }

  // The worker debounces before replying, then makes several model round-trips.
  console.log("waiting for the assistant (debounce + model)…");

  const conversation = await withTenant(tenant.id, (db) =>
    db.conversation.findFirst({
      where: { tenantId: tenant.id, channel: "whatsapp", externalThreadId: to },
    }),
  );
  if (!conversation) {
    console.error("No conversation was created — check the dev server log.");
    process.exit(1);
  }

  // Only a reply NEWER than the message just sent counts.
  //
  // This originally looked for any outbound message on the thread and reported
  // the newest, which meant an earlier reply was presented as if it were the
  // answer to this one — a passing test on a thread where nothing had happened.
  // The bug it hid was real: turns had stopped queueing entirely.
  const sentAt = new Date();

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const reply = await adminDb.conversationMessage.findFirst({
      where: {
        conversationId: conversation.id,
        direction: "outbound",
        createdAt: { gt: sentAt },
      },
      orderBy: { createdAt: "desc" },
    });
    if (reply) {
      console.log(`\n  assistant  ${reply.body}`);
      console.log(
        `\n  delivery: ${reply.status ?? "sent to Meta with no error"}${
          reply.externalId ? ` · ${reply.externalId}` : ""
        }`,
      );
      if (reply.sources.length > 0) console.log(`  read: ${reply.sources.join(", ")}`);
      console.log(
        reply.status === "failed"
          ? "\n→ Meta refused the send. The dev server log has its reason."
          : `\n→ Sent. Check WhatsApp on +${to}.`,
      );
      console.log("─".repeat(66));
      return;
    }
    process.stdout.write(".");
  }

  console.error("\nNo reply was produced within two minutes. Check the worker log.");
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminDb.$disconnect();
    redis.disconnect();
  });
