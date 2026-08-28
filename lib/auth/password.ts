import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt.
 *
 * scrypt rather than a bare SHA: it is deliberately slow and memory-hard, so a
 * stolen table cannot be brute-forced at GPU speed. Node ships it, which avoids
 * a native bcrypt/argon2 dependency that breaks on every platform change.
 *
 * Stored as `scrypt$<salt-hex>$<hash-hex>` — the algorithm is recorded in the
 * string so a future migration to argon2 can verify old hashes and re-hash on
 * next sign-in, rather than locking everyone out.
 */

const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltHex, hashHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Minimum viable policy. Length beats character classes; say so in the message. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That's too long — 200 characters maximum.";
  return null;
}
