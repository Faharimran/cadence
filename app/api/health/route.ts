import { adminDb, isolationStatus } from "@/lib/prisma";

/**
 * Unauthenticated liveness + posture check.
 *
 * It deliberately reports whether tenant isolation is actually *enforced*, not
 * merely configured. A deployment where the app connects as the table owner has
 * working policies that apply to nobody — everything looks healthy right up
 * until one tenant reads another's calendar. Better to fail this check loudly.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let healthy = true;

  try {
    await adminDb.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    healthy = false;
    checks.database = err instanceof Error ? err.message : "unreachable";
  }

  try {
    const isolation = await isolationStatus();
    checks.tenantIsolation = isolation.enforced ? "enforced" : `INERT: ${isolation.reason}`;
    if (!isolation.enforced) healthy = false;
  } catch (err) {
    healthy = false;
    checks.tenantIsolation = err instanceof Error ? err.message : "unknown";
  }

  try {
    const rows = await adminDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'booking_resource_no_overlap'
    `;
    const present = Number(rows[0]?.n ?? 0) > 0;
    checks.overlapConstraint = present ? "present" : "MISSING — run npm run db:rls";
    if (!present) healthy = false;
  } catch {
    healthy = false;
    checks.overlapConstraint = "unknown";
  }

  return Response.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
}
