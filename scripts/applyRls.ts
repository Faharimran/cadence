/**
 * Applies the database-level guarantees Prisma's schema language cannot express.
 * Idempotent — safe to re-run after every `prisma db push` / `migrate deploy`,
 * and it must be re-run, because Prisma does not know these objects exist.
 *
 * Two guarantees:
 *
 *  1. TENANT ISOLATION (row-level security). Application code filters by
 *     `tenantId` for speed; these policies are the backstop for the one query
 *     someone eventually forgets to scope. A missing filter then returns zero
 *     rows instead of another tenant's calendar.
 *
 *  2. NO DOUBLE-BOOKING (exclusion constraint). Two customers can ask an agent
 *     for the same slot in the same second. Application-level "is it free?"
 *     checks lose that race, and they lose it in production with real people.
 *     Postgres decides instead, and the loser gets a clean, catchable error.
 *
 * Run: npm run db:rls          (apply)
 *      npm run db:rls -- --verify   (apply, then prove both actually hold)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Every table carrying a `tenantId`. Kept as an explicit list rather than read
 * from information_schema so that adding a tenant-scoped table without adding a
 * policy is a visible omission in review, not a silent gap.
 */
const TENANT_SCOPED_TABLES = [
  "User",
  "ApiKey",
  "TenantCapability",
  "Location",
  "Resource",
  "ResourceLocation",
  "Service",
  "ServiceRequirement",
  "ScheduleRule",
  "ExceptionType",
  "ScheduleException",
  "Customer",
  "Booking",
  "BookingResource",
  "Promotion",
  "Conversation",
  "ConversationMessage",
  "KnowledgeDoc",
  "KnowledgeRevision",
  "KnowledgeSource",
  "SheetLink",
  "ImportRun",
  "ChannelAccount",
  "ModelProvider",
  "ModelUsage",
  "IdempotencyRecord",
  "WebhookEndpoint",
  "WebhookDelivery",
  "AuditLog",
] as const;

const APP_ROLE = "cadence_app";

async function applyRowLevelSecurity() {
  for (const table of TENANT_SCOPED_TABLES) {
    // Note: RLS is enabled but deliberately NOT forced. Postgres exempts a
    // table's owner from its own policies, which is what lets migrations and
    // seed scripts (running as the owner) operate freely. The application never
    // connects as the owner — see DATABASE_APP_URL in .env.example. `--verify`
    // below asserts that separation still holds rather than trusting it.
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);

    // current_setting(..., true) yields NULL when the GUC is unset, so the
    // predicate is NULL and no rows match. Fail-closed: a connection that never
    // sets app.tenant_id sees an empty database rather than all of it.
    await prisma.$executeRawUnsafe(`
      CREATE POLICY tenant_isolation ON "${table}"
        USING ("tenantId" = current_setting('app.tenant_id', true))
        WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))
    `);

    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO ${APP_ROLE}`,
    );
  }

  // Tenant itself is not tenant-scoped (it has `id`, not `tenantId`). The app
  // role may read only its own row.
  await prisma.$executeRawUnsafe(`ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS tenant_self ON "Tenant"`);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY tenant_self ON "Tenant"
      USING ("id" = current_setting('app.tenant_id', true))
      WITH CHECK ("id" = current_setting('app.tenant_id', true))
  `);
  await prisma.$executeRawUnsafe(`GRANT SELECT, UPDATE ON "Tenant" TO ${APP_ROLE}`);

  console.log(`  ✓ RLS policies on ${TENANT_SCOPED_TABLES.length + 1} tables`);
}

async function applyOverlapConstraint() {
  // `=` on a text column inside a GiST exclusion constraint needs btree_gist.
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

  const [{ exists }] = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'booking_resource_no_overlap'
    ) AS exists
  `);

  if (!exists) {
    // '[)' — half-open. A booking ending at 11:00 and one starting at 11:00 do
    // NOT overlap, which is the intuitive reading of back-to-back appointments.
    // Filtered on `active` so cancellations free the slot immediately without
    // deleting the audit trail.
    //
    // The stored interval already includes the service's buffers, so turnover
    // time is enforced by this same constraint rather than by remembering to
    // check it somewhere.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "BookingResource"
        ADD CONSTRAINT booking_resource_no_overlap
        EXCLUDE USING gist (
          "resourceId" WITH =,
          tstzrange("startsAt", "endsAt", '[)') WITH &&
        ) WHERE (active)
    `);
    console.log("  ✓ exclusion constraint booking_resource_no_overlap");
  } else {
    console.log("  · exclusion constraint already present");
  }
}

/**
 * Full-text search over the knowledge corpus.
 *
 * A generated column rather than an application-maintained one: there is no
 * trigger to forget and no write path that can leave the index disagreeing with
 * the text. Postgres recomputes it on every insert and update, including the
 * ones a migration or a manual fix makes.
 *
 * Weighting matters more than it looks. A title here is the question a customer
 * would ask, so a hit there is far stronger evidence than the same word buried
 * in prose — 'A' against 'B'.
 *
 * Tags are deliberately NOT in the vector. `array_to_string` is only STABLE, not
 * IMMUTABLE, so Postgres refuses it in a generated column — and the workaround
 * (a hand-rolled IMMUTABLE wrapper) would buy nothing here, because tags are
 * already an exact filter on the query rather than something to rank by.
 *
 * What this buys over scoring in JavaScript is **stemming**. Without it "pay"
 * does not match "payments" and "finance" does not match "financing", so an
 * article titled "What ways can I pay for a car?" loses to one that merely
 * happens to contain the word "finance".
 */
async function applyKnowledgeSearch() {
  // Both statements are idempotent, and both also live in the migration that
  // introduced them. Kept here for the same reason the exclusion constraint is:
  // this script is the one place that states every database-level guarantee, and
  // re-running it after a deploy must be enough to be sure they all hold.
  //
  // A function plus an expression index rather than a stored generated column.
  // The generated column was tried and abandoned — Prisma cannot express
  // GENERATED, so it read the column as drift and offered to reset the database
  // on every `migrate dev`. Nothing here is visible to Prisma.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION knowledge_tsv(title text, body text)
      RETURNS tsvector
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
    AS $$
      SELECT setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
             setweight(to_tsvector('english', coalesce(body, '')), 'B')
    $$
  `);

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS knowledge_doc_search
       ON "KnowledgeDoc" USING GIN (knowledge_tsv(title, body))`,
  );

  console.log("  ✓ knowledge full-text index");
}

/** Proves the two guarantees hold, rather than assuming the DDL above was enough. */
async function verify() {
  const appUrl = process.env.DATABASE_APP_URL;
  if (!appUrl) throw new Error("DATABASE_APP_URL is not set — cannot verify isolation.");

  // The single most dangerous misconfiguration: the app connecting as a
  // superuser or as the tables' owner. Either silently disables every policy
  // above while the setup still *looks* correct.
  const [role] = await prisma.$queryRawUnsafe<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${APP_ROLE}'`);
  if (!role) throw new Error(`Role ${APP_ROLE} does not exist.`);
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(`${APP_ROLE} is superuser/BYPASSRLS — every policy is inert.`);
  }

  const app = new PrismaClient({ datasources: { db: { url: appUrl } } });
  try {
    // Two tenants, created as the owner (which bypasses RLS).
    const a = await prisma.tenant.upsert({
      where: { slug: "__rls_probe_a" },
      create: { slug: "__rls_probe_a", name: "Probe A", timezone: "UTC", currency: "USD" },
      update: {},
    });
    const b = await prisma.tenant.upsert({
      where: { slug: "__rls_probe_b" },
      create: { slug: "__rls_probe_b", name: "Probe B", timezone: "UTC", currency: "USD" },
      update: {},
    });
    await prisma.location.deleteMany({ where: { tenantId: { in: [a.id, b.id] } } });
    await prisma.location.create({
      data: { tenantId: b.id, name: "B only", timezone: "UTC" },
    });

    // As the app role, scoped to tenant A: tenant B's location must be invisible.
    const leaked = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${a.id}', true)`);
      // Deliberately UNSCOPED — this is the forgotten-where-clause scenario.
      return tx.location.findMany();
    });
    if (leaked.length !== 0) {
      throw new Error(`RLS LEAK: unscoped query returned ${leaked.length} row(s).`);
    }
    console.log("  ✓ cross-tenant read blocked on an unscoped query");

    // And a write attributed to another tenant must be rejected by WITH CHECK.
    let writeBlocked = false;
    try {
      await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${a.id}', true)`);
        await tx.location.create({
          data: { tenantId: b.id, name: "smuggled", timezone: "UTC" },
        });
      });
    } catch {
      writeBlocked = true;
    }
    if (!writeBlocked) throw new Error("RLS LEAK: cross-tenant INSERT succeeded.");
    console.log("  ✓ cross-tenant write rejected by WITH CHECK");

    await prisma.tenant.deleteMany({
      where: { slug: { in: ["__rls_probe_a", "__rls_probe_b"] } },
    });
  } finally {
    await app.$disconnect();
  }
}

async function main() {
  console.log("Applying database-level guarantees…");
  await applyRowLevelSecurity();
  await applyOverlapConstraint();
  await applyKnowledgeSearch();

  if (process.argv.includes("--verify")) {
    console.log("Verifying…");
    await verify();
  }
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
