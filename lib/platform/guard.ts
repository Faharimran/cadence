import { redirect } from "next/navigation";
import type { PlatformRole } from "@prisma/client";
import { adminDb } from "@/lib/prisma";
import { readPlatformSession } from "./session";

/**
 * THE authorization check for the operator console.
 *
 * The same rule as the tenant guard: every page and every action calls this, not
 * just the layout, because a Server Action is reachable by direct POST whatever
 * UI was rendered. The proxy is a courtesy redirect for humans.
 *
 * The operator is re-read from the database on every request rather than trusted
 * from the cookie, so revoking someone takes effect immediately rather than
 * whenever their session happens to lapse. That matters more here than in a
 * tenant admin: this session can see every customer's operational data.
 */

export type PlatformOperator = {
  id: string;
  email: string;
  name: string | null;
  role: PlatformRole;
};

export async function currentOperator(): Promise<PlatformOperator | null> {
  const claims = await readPlatformSession();
  if (!claims) return null;

  const user = await adminDb.platformUser.findUnique({
    where: { id: claims.platformUserId },
  });
  if (!user || !user.active) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function requireOperator(): Promise<PlatformOperator> {
  const operator = await currentOperator();
  if (!operator) redirect("/platform/signin");
  return operator;
}

/**
 * `support` sees everything and changes nothing; `admin` may also act. Kept as
 * an explicit comparison rather than a rank table because there are two values
 * and a table would imply a hierarchy worth extending.
 */
export async function requirePlatformAdmin(): Promise<PlatformOperator> {
  const operator = await requireOperator();
  if (operator.role !== "admin") {
    throw new Error("This action needs a platform admin.");
  }
  return operator;
}
