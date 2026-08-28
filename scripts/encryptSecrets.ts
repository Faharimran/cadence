/**
 * Encrypts any stored secret still sitting in the clear.
 *
 * Safe to run repeatedly and safe to run against a live system: values already
 * encrypted are skipped, and the application reads both forms during the window
 * (see `decrypt`'s pass-through). So the order is: deploy the code, run this,
 * confirm zero remaining.
 *
 * Run: npm run db:encrypt          (report only)
 *      npm run db:encrypt -- --apply
 */
import { adminDb } from "@/lib/prisma";
import { encrypt, isEncrypted } from "@/lib/crypto";

const apply = process.argv.includes("--apply");

async function main() {
  const accounts = await adminDb.channelAccount.findMany({
    select: { id: true, accessToken: true, appSecret: true, verifyToken: true },
  });
  const endpoints = await adminDb.webhookEndpoint.findMany({
    select: { id: true, secret: true },
  });

  let plaintext = 0;
  let sealed = 0;

  for (const a of accounts) {
    const patch: Record<string, string> = {};
    for (const field of ["accessToken", "appSecret", "verifyToken"] as const) {
      const value = a[field];
      if (value && !isEncrypted(value)) {
        plaintext++;
        patch[field] = encrypt(value);
      }
    }
    if (Object.keys(patch).length > 0 && apply) {
      await adminDb.channelAccount.update({ where: { id: a.id }, data: patch });
      sealed += Object.keys(patch).length;
    }
  }

  for (const e of endpoints) {
    if (e.secret && !isEncrypted(e.secret)) {
      plaintext++;
      if (apply) {
        await adminDb.webhookEndpoint.update({
          where: { id: e.id },
          data: { secret: encrypt(e.secret) },
        });
        sealed++;
      }
    }
  }

  if (plaintext === 0) {
    console.log("Nothing in the clear — every stored secret is encrypted.");
    return;
  }

  if (apply) {
    console.log(`Encrypted ${sealed} value${sealed === 1 ? "" : "s"}.`);
  } else {
    console.log(
      `${plaintext} value${plaintext === 1 ? " is" : "s are"} still stored in plaintext.\n` +
        `Re-run with --apply to encrypt them.`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
