/**
 * Creates or updates an operator — someone who runs cadence itself.
 *
 * There is deliberately no sign-up for this and no invite flow in the console.
 * Adding a person who can see every customer on the platform should require
 * shell access to the server, not a form. When that stops being practical, the
 * replacement is an invite from an existing `admin`, never an open route.
 *
 * Run: npm run operator -- <email> <password> [support|admin]
 */
import { adminDb } from "@/lib/prisma";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import type { PlatformRole } from "@prisma/client";

async function main() {
  const [email, password, role = "admin"] = process.argv.slice(2);

  if (!email || !password) {
    console.error("Usage: npm run operator -- <email> <password> [support|admin]");
    process.exit(1);
  }
  if (!["support", "admin"].includes(role)) {
    console.error(`Unknown role '${role}'. Use support or admin.`);
    process.exit(1);
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  // A tenant user and an operator with the same address would be two different
  // accounts with two different passwords, which is a trap rather than a
  // feature — refuse it.
  const clash = await adminDb.user.findUnique({ where: { email: email.toLowerCase() } });
  if (clash) {
    console.error(
      `${email} already signs in to a business admin. Use a different address for an operator.`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const operator = await adminDb.platformUser.upsert({
    where: { email: email.toLowerCase() },
    create: {
      email: email.toLowerCase(),
      passwordHash,
      role: role as PlatformRole,
      active: true,
    },
    update: { passwordHash, role: role as PlatformRole, active: true },
  });

  console.log(`Operator ${operator.email} (${operator.role}) ready.`);
  console.log(`Sign in at /platform/signin`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
