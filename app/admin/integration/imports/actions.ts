"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { asTenant, requireRole } from "@/lib/auth/guard";
import { resolveSheetUrl, readSheet, SheetError } from "@/lib/imports/sheet";
import { proposeMapping, type Mapping } from "@/lib/imports/map";
import { fieldsFor, KINDS } from "@/lib/imports/fields";
import { syncLink, revertImportRun } from "@/lib/imports";

export type ImportFormState =
  | { error?: string; ok?: string }
  | {
      /** The mapping step: what we read, and what we think each column is. */
      preview: {
        sourceUrl: string;
        fetchUrl: string;
        gid: string | null;
        kind: string;
        headers: string[];
        sample: Record<string, string>[];
        rowCount: number;
        mapping: Mapping;
        uncertain: { header: string; field: string; note: string }[];
        missing: string[];
        source: "model" | "headers";
      };
    }
  | null;

const Connect = z.object({
  sourceUrl: z.string().min(1, "Paste the link to your spreadsheet."),
  kind: z.string().refine((k) => k in KINDS, "Choose what this sheet holds."),
});

/**
 * Reads the sheet and proposes what each column is. Writes nothing.
 *
 * Separate from saving on purpose. The owner has to see that we read *their*
 * sheet — their own service names, in their own spelling — before agreeing to
 * anything. A flow that jumps straight from a pasted URL to "imported 240 rows"
 * gives them no moment to notice it read the wrong tab.
 */
export async function previewSheet(
  _previous: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const user = await requireRole("manager");

  const parsed = Connect.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  try {
    const { fetchUrl, gid } = resolveSheetUrl(parsed.data.sourceUrl);
    const sheet = await readSheet(fetchUrl);

    if (sheet.rows.length === 0) {
      return { error: "That sheet has headings but no rows underneath them." };
    }

    const tenant = await asTenant(user, (db) =>
      db.tenant.findFirstOrThrow({ where: { id: user.tenantId } }),
    );

    const proposal = await proposeMapping({
      kind: parsed.data.kind,
      headers: sheet.headers,
      sample: sheet.rows,
      currency: tenant.currency,
    });

    return {
      preview: {
        sourceUrl: parsed.data.sourceUrl.trim(),
        fetchUrl,
        gid,
        kind: parsed.data.kind,
        headers: sheet.headers,
        sample: sheet.rows.slice(0, 5),
        rowCount: sheet.rows.length,
        ...proposal,
      },
    };
  } catch (err) {
    if (err instanceof SheetError) return { error: `${err.message} ${err.remedy}` };
    return { error: "Something went wrong reading that sheet." };
  }
}

/**
 * Saves the link with the agreed mapping and runs it once, immediately.
 *
 * The mapping arrives as one form field per column, so an owner who disagreed
 * with the proposal has already corrected it by the time this runs — what is
 * stored is what they saw and changed, not what a model said.
 */
export async function saveLink(
  _previous: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const user = await requireRole("manager");

  const sourceUrl = String(formData.get("sourceUrl") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const removeMissing = formData.get("removeMissing") === "on";

  if (!(kind in KINDS)) return { error: "Choose what this sheet holds." };

  let fetchUrl: string;
  let gid: string | null;
  try {
    ({ fetchUrl, gid } = resolveSheetUrl(sourceUrl));
  } catch (err) {
    return { error: err instanceof SheetError ? `${err.message} ${err.remedy}` : "Bad link." };
  }

  // Columns come back as map:<header>. Reconstructed here rather than trusted as
  // a blob, so a field name that is not one of ours cannot reach the writer.
  const allowed = new Set(fieldsFor(kind).map((f) => f.key));
  const mapping: Mapping = {};
  const claimed = new Set<string>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("map:")) continue;
    const header = key.slice(4);
    const field = String(value);
    if (field === "ignore" || !allowed.has(field)) continue;
    if (claimed.has(field)) {
      return { error: `Two columns are both set to ${field}. Each can only be filled once.` };
    }
    claimed.add(field);
    mapping[header] = field;
  }

  const missing = fieldsFor(kind).filter((f) => f.required && !claimed.has(f.key));
  if (missing.length > 0) {
    return {
      error: `Still need a column for: ${missing.map((f) => f.label.toLowerCase()).join(", ")}.`,
    };
  }

  return asTenant(user, async (db) => {
    const link = await db.sheetLink.create({
      data: {
        tenantId: user.tenantId,
        sourceUrl: sourceUrl.trim(),
        fetchUrl,
        gid,
        kind,
        mapping,
        removeMissing,
      },
    });

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "import.link_created",
        subject: `SheetLink:${link.id}`,
        after: { kind, removeMissing, columns: Object.keys(mapping).length },
      },
    });

    const result = await syncLink(db, {
      tenantId: user.tenantId,
      linkId: link.id,
      trigger: "manual",
    });

    revalidatePath("/admin/integration/imports");
    revalidatePath("/admin/services");
    return result.ok ? { ok: `Connected. ${result.message}` } : { error: result.message };
  });
}

export async function syncNow(linkId: string): Promise<void> {
  const user = await requireRole("manager");
  await asTenant(user, (db) =>
    syncLink(db, { tenantId: user.tenantId, linkId, trigger: "manual" }),
  );
  revalidatePath("/admin/integration/imports");
  revalidatePath("/admin/services");
}

export async function undoRun(runId: string): Promise<void> {
  const user = await requireRole("manager");
  await asTenant(user, async (db) => {
    const result = await revertImportRun(db, { tenantId: user.tenantId, runId });
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "import.run_reverted",
        subject: `ImportRun:${runId}`,
        after: { message: result.message },
      },
    });
  });
  revalidatePath("/admin/integration/imports");
  revalidatePath("/admin/services");
}

export async function pauseLink(linkId: string, paused: boolean): Promise<void> {
  const user = await requireRole("manager");
  await asTenant(user, (db) =>
    db.sheetLink.updateMany({
      where: { id: linkId, tenantId: user.tenantId },
      data: { status: paused ? "paused" : "active" },
    }),
  );
  revalidatePath("/admin/integration/imports");
}

export async function disconnectLink(linkId: string): Promise<void> {
  const user = await requireRole("manager");
  await asTenant(user, async (db) => {
    // The rows it imported stay. Disconnecting a sheet means "stop following
    // this", not "undo everything you ever read from it" — that is what the
    // per-run undo is for, and conflating the two would delete a working
    // catalogue because somebody tidied up their Drive.
    await db.sheetLink.deleteMany({ where: { id: linkId, tenantId: user.tenantId } });
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "import.link_removed",
        subject: `SheetLink:${linkId}`,
      },
    });
  });
  revalidatePath("/admin/integration/imports");
}
