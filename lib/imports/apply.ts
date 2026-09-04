/**
 * Writing a sheet into cadence, and being able to take it back.
 *
 * Imports here apply immediately — no preview, no approval queue. That is a
 * deliberate choice and it is only defensible because of the second half: every
 * run records the previous value of every field it changes and the id of every
 * row it creates, BEFORE changing anything, so `revert` is complete rather than
 * best-effort.
 *
 * Three rules the whole file is arranged around:
 *
 *   1. Matching is by identity, not by position. A row is found by its own
 *      reference if the sheet has one, otherwise by name (services) or by phone
 *      or email (customers). Re-ordering a spreadsheet must not rewrite the
 *      business.
 *   2. A bad cell costs its own row and nothing else. One unreadable price in
 *      row 40 does not abandon rows 41 to 300; it imports them and says which
 *      cell to look at.
 *   3. Absence is not deletion, unless asked. A row missing from the sheet is
 *      left alone by default — a filtered view or a half-loaded fetch would
 *      otherwise retire an entire price list, and unlike a wrong value, an
 *      absent row leaves nothing to notice.
 */
import type { Prisma } from "@prisma/client";
import type { TenantDb } from "@/lib/prisma";
import { fieldsFor, isBlank } from "./fields";
import type { SheetData } from "./sheet";
import type { Mapping } from "./map";

export type RowIssue = { row: number; column?: string; problem: string };

/**
 * What a run did, in enough detail to undo it.
 *
 * `before: null` marks a row this run created — reverting deletes it. Otherwise
 * `before` holds only the fields this run actually changed, so a revert restores
 * exactly those and leaves later edits by other means alone.
 */
export type UndoLog = {
  table: "service" | "customer";
  changes: { id: string; before: Record<string, unknown> | null }[];
};

export type ApplyResult = {
  rowsRead: number;
  created: number;
  updated: number;
  skipped: number;
  issues: RowIssue[];
  undo: UndoLog;
};

/** Reads one sheet row into our field names, collecting complaints as it goes. */
function readRow(
  raw: Record<string, string>,
  mapping: Mapping,
  kind: string,
  currency: string,
  rowNumber: number,
): { values: Record<string, unknown>; issues: RowIssue[] } {
  const specs = new Map(fieldsFor(kind).map((f) => [f.key, f]));
  const values: Record<string, unknown> = {};
  const issues: RowIssue[] = [];

  for (const [header, field] of Object.entries(mapping)) {
    const spec = specs.get(field);
    if (!spec) continue;
    const cell = raw[header] ?? "";

    if (isBlank(cell) && !spec.required) {
      const parsed = spec.parse(cell, { currency });
      if (parsed.ok) values[field] = parsed.value;
      continue;
    }

    const parsed = spec.parse(cell, { currency });
    if (parsed.ok) values[field] = parsed.value;
    else issues.push({ row: rowNumber, column: header, problem: parsed.why });
  }

  return { values, issues };
}

/** Only the keys that differ, with their PREVIOUS values. */
function diff(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (existing[k] !== v) {
      before[k] = existing[k] ?? null;
      after[k] = v;
    }
  }
  return { before, after };
}

// ── Services ──────────────────────────────────────────────────────────

async function applyServices(
  db: TenantDb,
  args: { tenantId: string; currency: string; sheet: SheetData; mapping: Mapping; removeMissing: boolean },
): Promise<ApplyResult> {
  const existing = await db.service.findMany({ where: { tenantId: args.tenantId } });
  const byExternal = new Map(existing.filter((s) => s.externalId).map((s) => [s.externalId!, s]));
  const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s]));

  const result: ApplyResult = {
    rowsRead: args.sheet.rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    issues: [],
    undo: { table: "service", changes: [] },
  };

  const seen = new Set<string>();

  for (const [i, raw] of args.sheet.rows.entries()) {
    // +2: one for the header row, one because spreadsheets count from 1. This
    // number is read by someone looking at their own sheet, so it has to be the
    // number they see in the margin.
    const rowNumber = i + 2;
    const { values, issues } = readRow(raw, args.mapping, "services", args.currency, rowNumber);

    if (issues.length > 0) {
      result.issues.push(...issues);
      result.skipped++;
      continue;
    }

    const name = values.name as string | null;
    if (!name) {
      result.issues.push({ row: rowNumber, problem: "No service name in this row." });
      result.skipped++;
      continue;
    }
    if (values.durationMinutes == null) {
      result.issues.push({ row: rowNumber, problem: `“${name}” has no length, so it cannot be booked.` });
      result.skipped++;
      continue;
    }

    const externalId = values.externalId as string | null;
    const match = (externalId && byExternal.get(externalId)) || byName.get(name.trim().toLowerCase());

    if (match) {
      if (seen.has(match.id)) {
        result.issues.push({ row: rowNumber, problem: `“${name}” appears more than once in the sheet.` });
        result.skipped++;
        continue;
      }
      seen.add(match.id);

      const { before, after } = diff(match as unknown as Record<string, unknown>, values);
      if (Object.keys(after).length === 0) {
        result.skipped++;
        continue;
      }
      // Recorded before the write, not after. A crash between the two must
      // leave an undo that is too generous rather than one that is missing.
      result.undo.changes.push({ id: match.id, before });
      await db.service.update({ where: { id: match.id }, data: after as Prisma.ServiceUpdateInput });
      result.updated++;
    } else {
      const created = await db.service.create({
        data: {
          tenantId: args.tenantId,
          name,
          durationMinutes: values.durationMinutes as number,
          category: (values.category as string | null) ?? null,
          description: (values.description as string | null) ?? null,
          priceMinor: (values.priceMinor as number | null) ?? null,
          bufferAfterMinutes: (values.bufferAfterMinutes as number | undefined) ?? 0,
          active: (values.active as boolean | undefined) ?? true,
          externalId: externalId ?? null,
        },
      });
      seen.add(created.id);
      result.undo.changes.push({ id: created.id, before: null });
      result.created++;
    }
  }

  // Retiring, never deleting: a service with bookings against it must keep
  // existing, or the history of those bookings loses what they were for.
  if (args.removeMissing) {
    for (const s of existing) {
      if (seen.has(s.id) || !s.active) continue;
      result.undo.changes.push({ id: s.id, before: { active: true } });
      await db.service.update({ where: { id: s.id }, data: { active: false } });
      result.updated++;
    }
  }

  return result;
}

// ── Customers ─────────────────────────────────────────────────────────

async function applyCustomers(
  db: TenantDb,
  args: { tenantId: string; currency: string; sheet: SheetData; mapping: Mapping },
): Promise<ApplyResult> {
  const existing = await db.customer.findMany({ where: { tenantId: args.tenantId } });
  const byExternal = new Map(existing.filter((c) => c.externalId).map((c) => [c.externalId!, c]));
  const byPhone = new Map(
    existing.filter((c) => c.phone).map((c) => [c.phone!.replace(/[^\d]/g, ""), c]),
  );
  const byEmail = new Map(
    existing.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]),
  );

  const result: ApplyResult = {
    rowsRead: args.sheet.rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    issues: [],
    undo: { table: "customer", changes: [] },
  };

  const seen = new Set<string>();

  for (const [i, raw] of args.sheet.rows.entries()) {
    const rowNumber = i + 2;
    const { values, issues } = readRow(raw, args.mapping, "customers", args.currency, rowNumber);

    if (issues.length > 0) {
      result.issues.push(...issues);
      result.skipped++;
      continue;
    }

    const phone = values.phone as string | null;
    const email = values.email as string | null;
    if (!phone && !email) {
      // A customer with no way to reach them cannot be messaged, which is the
      // entire point of having them here.
      result.issues.push({ row: rowNumber, problem: "No phone number and no email." });
      result.skipped++;
      continue;
    }

    const externalId = values.externalId as string | null;
    const match =
      (externalId && byExternal.get(externalId)) ||
      (phone && byPhone.get(phone.replace(/[^\d]/g, ""))) ||
      (email && byEmail.get(email.toLowerCase())) ||
      null;

    if (match) {
      if (seen.has(match.id)) {
        result.skipped++;
        continue;
      }
      seen.add(match.id);
      const { before, after } = diff(match as unknown as Record<string, unknown>, values);
      if (Object.keys(after).length === 0) {
        result.skipped++;
        continue;
      }
      result.undo.changes.push({ id: match.id, before });
      await db.customer.update({ where: { id: match.id }, data: after as Prisma.CustomerUpdateInput });
      result.updated++;
    } else {
      const created = await db.customer.create({
        data: {
          tenantId: args.tenantId,
          name: (values.name as string | null) ?? null,
          phone: phone ?? null,
          email: email ?? null,
          externalId: externalId ?? null,
        },
      });
      seen.add(created.id);
      // Guards against the same phone appearing twice further down the sheet.
      if (phone) byPhone.set(phone.replace(/[^\d]/g, ""), created);
      if (email) byEmail.set(email.toLowerCase(), created);
      result.undo.changes.push({ id: created.id, before: null });
      result.created++;
    }
  }

  return result;
}

export async function applySheet(
  db: TenantDb,
  args: {
    tenantId: string;
    kind: string;
    currency: string;
    sheet: SheetData;
    mapping: Mapping;
    removeMissing: boolean;
  },
): Promise<ApplyResult> {
  if (args.kind === "services") return applyServices(db, args);
  if (args.kind === "customers") return applyCustomers(db, args);
  throw new Error(`Unknown import kind: ${args.kind}`);
}

/**
 * Puts everything back the way it was.
 *
 * Created rows are deleted; changed rows have exactly the changed fields
 * restored. Fields edited by other means since the run are untouched, because
 * `before` only ever held what this run itself changed.
 *
 * A created row that has since acquired a booking is kept and deactivated
 * instead. Deleting it would take the booking with it — cascade — and an undo
 * that removes a real appointment is worse than the import it was undoing.
 */
export async function revertRun(
  db: TenantDb,
  args: { tenantId: string; undo: UndoLog },
): Promise<{ restored: number; deleted: number; kept: number }> {
  let restored = 0;
  let deleted = 0;
  let kept = 0;

  for (const change of args.undo.changes) {
    if (change.before === null) {
      if (args.undo.table === "service") {
        const bookings = await db.booking.count({
          where: { tenantId: args.tenantId, serviceId: change.id },
        });
        if (bookings > 0) {
          await db.service.updateMany({
            where: { id: change.id, tenantId: args.tenantId },
            data: { active: false },
          });
          kept++;
          continue;
        }
        await db.service.deleteMany({ where: { id: change.id, tenantId: args.tenantId } });
      } else {
        const bookings = await db.booking.count({
          where: { tenantId: args.tenantId, customerId: change.id },
        });
        if (bookings > 0) {
          kept++;
          continue;
        }
        await db.customer.deleteMany({ where: { id: change.id, tenantId: args.tenantId } });
      }
      deleted++;
      continue;
    }

    if (args.undo.table === "service") {
      await db.service.updateMany({
        where: { id: change.id, tenantId: args.tenantId },
        data: change.before as Prisma.ServiceUpdateManyMutationInput,
      });
    } else {
      await db.customer.updateMany({
        where: { id: change.id, tenantId: args.tenantId },
        data: change.before as Prisma.CustomerUpdateManyMutationInput,
      });
    }
    restored++;
  }

  return { restored, deleted, kept };
}
