/**
 * Creates or updates an admin user.
 *
 * The bootstrap path: a fresh install has no way to sign in until someone runs
 * this. Every later user is invited from Settings.
 *
 * Run: npm run user -- <tenant-slug> <email> <password> [role]
 */
import { adminDb } from "@/lib/prisma";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import type { UserRole } from "@prisma/client";

async function main() {
  const [slug, email, password, role = "owner"] = process.argv.slice(2);

  if (!slug || !email || !password) {
    console.error("Usage: npm run user -- <tenant-slug> <email> <password> [owner|manager|staff]");
    process.exit(1);
  }
  if (!["owner", "manager", "staff"].includes(role)) {
    console.error(`Unknown role '${role}'. Use owner, manager or staff.`);
    process.exit(1);
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const tenant = await adminDb.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    const known = await adminDb.tenant.findMany({ select: { slug: true } });
    console.error(
      `No tenant '${slug}'.${known.length ? ` Try: ${known.map((t) => t.slug).join(", ")}` : ""}`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const normalised = email.trim().toLowerCase();

  const user = await adminDb.user.upsert({
    where: { email: normalised },
    create: {
      tenantId: tenant.id,
      email: normalised,
      passwordHash,
      role: role as UserRole,
      active: true,
    },
    // Re-running this is how you reset a forgotten password, so it updates
    // rather than failing on a duplicate.
    update: { passwordHash, role: role as UserRole, active: true, tenantId: tenant.id },
  });

  console.log(`${user.email} — ${user.role} at ${tenant.name}`);
  console.log("Sign in at /signin");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => adminDb.$disconnect());
