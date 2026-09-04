/**
 * One sync: read the sheet, write what changed, record enough to undo it.
 *
 * Everything that can fail records an ImportRun saying so. "It ran and did
 * nothing" and "it never ran" look identical the next morning and need
 * different responses, so a failure is a row here rather than only a log line.
 */
import type { TenantDb } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { readSheet, SheetError } from "./sheet";
import { applySheet, revertRun, type UndoLog } from "./apply";
import type { Mapping } from "./map";

export * from "./sheet";
export * from "./map";
export * from "./fields";
export { revertRun } from "./apply";
export type { UndoLog, RowIssue, ApplyResult } from "./apply";

export async function syncLink(
  db: TenantDb,
  args: { tenantId: string; linkId: string; trigger: "manual" | "scheduled" },
): Promise<{ runId: string; ok: boolean; message: string }> {
  const link = await db.sheetLink.findFirstOrThrow({
    where: { id: args.linkId, tenantId: args.tenantId },
  });
  const tenant = await db.tenant.findFirstOrThrow({ where: { id: args.tenantId } });

  const run = await db.importRun.create({
    data: { tenantId: args.tenantId, linkId: link.id, trigger: args.trigger },
  });

  try {
    const sheet = await readSheet(link.fetchUrl);

    const result = await applySheet(db, {
      tenantId: args.tenantId,
      kind: link.kind,
      currency: tenant.currency,
      sheet,
      mapping: link.mapping as Mapping,
      removeMissing: link.removeMissing,
    });

    await db.importRun.update({
      where: { id: run.id },
      data: {
        status: "ok",
        rowsRead: result.rowsRead,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        // Capped: a sheet with a wrong column produces one complaint per row,
        // and three hundred identical lines is not more informative than
        // twenty — it is just a page nobody scrolls.
        issues: result.issues.slice(0, 20),
        undo: result.undo as unknown as object,
        finishedAt: new Date(),
      },
    });

    await db.sheetLink.update({
      where: { id: link.id },
      data: { lastSyncAt: new Date(), status: "active", lastError: null },
    });

    const parts = [
      result.created ? `${result.created} added` : "",
      result.updated ? `${result.updated} updated` : "",
      result.skipped ? `${result.skipped} skipped` : "",
    ].filter(Boolean);

    return {
      runId: run.id,
      ok: true,
      message: parts.length ? parts.join(", ") + "." : "Nothing had changed.",
    };
  } catch (err) {
    // A SheetError already carries a remedy written for the owner. Anything else
    // is ours and is reported as such rather than dressed up as their mistake.
    const message =
      err instanceof SheetError
        ? `${err.message} ${err.remedy}`
        : "Something went wrong on our side reading the sheet.";

    if (!(err instanceof SheetError)) {
      logger.error("sheet sync failed", {
        linkId: link.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    await db.importRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message, finishedAt: new Date() },
    });
    await db.sheetLink.update({
      where: { id: link.id },
      data: { status: "error", lastError: message },
    });

    return { runId: run.id, ok: false, message };
  }
}

export async function revertImportRun(
  db: TenantDb,
  args: { tenantId: string; runId: string },
): Promise<{ ok: boolean; message: string }> {
  const run = await db.importRun.findFirstOrThrow({
    where: { id: args.runId, tenantId: args.tenantId },
  });

  if (run.revertedAt) return { ok: false, message: "That sync has already been undone." };
  if (!run.undo) return { ok: false, message: "That sync did not change anything to undo." };

  const outcome = await revertRun(db, {
    tenantId: args.tenantId,
    undo: run.undo as unknown as UndoLog,
  });

  await db.importRun.update({
    where: { id: run.id },
    data: { revertedAt: new Date(), status: "reverted" },
  });

  const parts = [
    outcome.restored ? `${outcome.restored} put back` : "",
    outcome.deleted ? `${outcome.deleted} removed` : "",
    outcome.kept ? `${outcome.kept} kept because they now have bookings` : "",
  ].filter(Boolean);

  return { ok: true, message: parts.length ? parts.join(", ") + "." : "Nothing to undo." };
}
