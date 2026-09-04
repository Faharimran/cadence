/**
 * Creates the non-owner database role the application connects as.
 *
 * This is the role every row-level-security policy is written against. Postgres
 * exempts a table's OWNER from its own policies, so an app connected as the
 * owner has isolation that looks configured and does nothing — which is why
 * lib/env.ts refuses to boot in production unless DATABASE_APP_URL is set to
 * something different from DATABASE_URL.
 *
 * scripts/applyRls.ts grants privileges to this role but has never created it;
 * on a developer machine it already existed. On a fresh database it does not,
 * and every grant fails. Hence this.
 *
 * Idempotent: safe to run on every deploy. It creates the role if missing,
 * updates the password if given one, and grants only what the application needs
 * — connect, schema usage, and sequence access. Table privileges stay in
 * applyRls.ts, next to the policies they belong with.
 *
 * Run: npm run db:approle -- <password>
 *      (or set CADENCE_APP_DB_PASSWORD)
 *
 * Prints the DATABASE_APP_URL to set. It never logs the owner URL.
 */
import { PrismaClient } from "@prisma/client";

const ROLE = "cadence_app";

async function main() {
  const password = process.argv[2] ?? process.env.CADENCE_APP_DB_PASSWORD;

  // Whether a human is watching, which decides whether the finished connection
  // string may be printed.
  //
  // It is useful on a terminal — it saves assembling the URL by hand and
  // getting it subtly wrong. It is a leak on a deploy: this runs inside
  // `npm start` on every boot, and Railway keeps build logs, so printing the
  // password there writes the application's database credentials into a record
  // that outlives the deploy and is visible to everyone with project access.
  const interactive = Boolean(process.argv[2]);
  if (!password) {
    console.error("Usage: npm run db:approle -- <password>");
    console.error("   or: CADENCE_APP_DB_PASSWORD=… npm run db:approle");
    process.exit(1);
  }
  if (password.length < 16) {
    console.error("Use at least 16 characters — this role can read every tenant's rows.");
    process.exit(1);
  }

  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    // Quoted with dollar-quoting so a password containing quotes cannot break
    // out of the statement.
    const literal = `$cadence_pw$${password}$cadence_pw$`;

    const [existing] = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') AS exists`,
    );

    if (existing.exists) {
      await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD ${literal}`);
      console.log(`· role ${ROLE} already existed — password updated`);
    } else {
      await prisma.$executeRawUnsafe(`CREATE ROLE ${ROLE} WITH LOGIN PASSWORD ${literal}`);
      console.log(`✓ created role ${ROLE}`);
    }

    // Explicitly NOT superuser and NOT bypassrls. Either would silently disable
    // every policy while the setup still looked correct; scripts/applyRls.ts
    // --verify checks for exactly this and refuses.
    await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);

    const db = new URL(ownerUrl).pathname.replace(/^\//, "").split("?")[0];
    await prisma.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${ROLE}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await prisma.$executeRawUnsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`,
    );
    // Tables created by future migrations need the same treatment, or the next
    // model added silently 500s for the app while working fine for the owner.
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`,
    );
    console.log("✓ granted connect, schema usage and sequences");

    if (interactive) {
      const appUrl = new URL(ownerUrl);
      appUrl.username = ROLE;
      appUrl.password = password;
      console.log(`\nSet this as DATABASE_APP_URL:\n\n${appUrl.toString()}\n`);
      console.log("Then run: npm run db:rls");
    } else {
      console.log(`· ${ROLE} ready (connection string not printed — this is a deploy log)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
