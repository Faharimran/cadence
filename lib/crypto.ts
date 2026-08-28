import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Encryption at rest for the handful of secrets cadence stores on a tenant's
 * behalf: WhatsApp tokens, Meta app secrets, webhook signing keys.
 *
 * These are different in kind from API keys. An API key we only ever *verify*,
 * so a one-way hash is enough. These we have to *use* — sign a payload, call
 * Graph — so they must be recoverable, which means encryption rather than
 * hashing. A leaked row here would let someone message that business's entire
 * customer list.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding garbage that gets sent to Meta as a token.
 */

const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;

/**
 * The key is derived rather than used raw, so a hex/base64/passphrase env value
 * all work, and so the encryption key is cryptographically independent of the
 * same secret's other uses (the API-key pepper) even when both come from
 * CADENCE_SECRET in development.
 */
let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const material = env.CADENCE_ENCRYPTION_KEY || env.CADENCE_SECRET;
  if (!env.CADENCE_ENCRYPTION_KEY && env.NODE_ENV !== "production") {
    logger.warn(
      "CADENCE_ENCRYPTION_KEY is unset — deriving from CADENCE_SECRET. Set it explicitly so the two can be rotated independently.",
    );
  }

  cachedKey = Buffer.from(
    hkdfSync("sha256", material, "cadence-secret-box", "encryption-v1", KEY_BYTES),
  );
  return cachedKey;
}

/** True for a value this module produced. Anything else is legacy plaintext. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}.`);
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(
    ".",
  );
}

/**
 * Decrypts, passing through anything that was never encrypted.
 *
 * The pass-through is deliberate and temporary: it lets a table be migrated
 * while the application keeps running, rather than requiring a stop-the-world
 * backfill. `scripts/encryptSecrets.ts` closes the window, and the health check
 * reports how many rows are still in the clear.
 */
export function decrypt(value: string): string {
  if (!isEncrypted(value)) return value;

  const [, ivPart, tagPart, ctPart] = value.split(".");
  if (!ivPart || !tagPart || !ctPart) {
    throw new Error("Malformed ciphertext — expected v1.<iv>.<tag>.<ct>");
  }

  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Almost always the wrong key — someone rotated CADENCE_SECRET without
    // setting CADENCE_ENCRYPTION_KEY first. Say so, because the raw GCM error
    // ("unable to authenticate data") sends people looking in the wrong place.
    throw new Error(
      "Could not decrypt a stored secret. The encryption key has changed since it was written — restore the previous CADENCE_ENCRYPTION_KEY, or re-enter the credential.",
    );
  }
}

/** Encrypts when present, leaves null alone. For optional columns. */
export function encryptNullable(value: string | null | undefined): string | null {
  return value ? encrypt(value) : null;
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decrypt(value) : null;
}
