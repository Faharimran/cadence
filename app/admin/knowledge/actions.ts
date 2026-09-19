"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { logger } from "@/lib/logger";
import { checksumOf, stashUpload } from "@/lib/knowledge/ingest";
import { createHash } from "node:crypto";
import { scheduleIngest } from "@/lib/queue";
import { normaliseSiteUrl, WebSourceError } from "@/lib/knowledge/web";

/**
 * Writing down what the business knows.
 *
 * The one rule the whole screen exists to enforce: **nothing reaches a customer
 * until a person has approved it.** Everything else here — the draft state, the
 * version bump, the revision row — is machinery in service of that.
 *
 * The consequence worth understanding is that editing an approved article does
 * NOT update what customers are told. It puts the article back into draft, and
 * the previously approved text stays live until someone signs the new one off.
 * That is deliberate. The alternative is someone tidying a sentence about
 * aftercare at 5pm and it being repeated to a patient at 5:01 unread.
 */

const DocInput = z.object({
  title: z.string().min(3, "Give it a title — phrase it the way a customer would ask.").max(200),
  body: z.string().min(10, "Write the answer.").max(50_000),
  tags: z.string().max(300).optional(),
});

export type KnowledgeFormState = { error?: string; ok?: string } | null;

function parseTags(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 12);
}

export async function createDoc(
  _previous: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  // A Server Action is reachable by direct POST regardless of what UI rendered,
  // so this is the check that counts.
  const user = await requireUser();

  const parsed = DocInput.safeParse({
    title: formData.get("title"),
    body: formData.get("body"),
    tags: formData.get("tags") ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  return asTenant(user, async (db) => {
    const clash = await db.knowledgeDoc.findFirst({
      where: { tenantId: user.tenantId, title: parsed.data.title },
      select: { id: true },
    });
    if (clash) return { error: "There is already an article with that title. Edit that one." };

    await db.knowledgeDoc.create({
      data: {
        tenantId: user.tenantId,
        title: parsed.data.title,
        body: parsed.data.body,
        tags: parseTags(parsed.data.tags),
        status: "draft",
        authorId: user.id,
      },
    });

    revalidatePath("/admin/knowledge");
    return { ok: "Saved as a draft. Approve it when you're happy — until then the assistant can't see it." };
  });
}

export async function updateDoc(
  _previous: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Nothing to save." };

  const parsed = DocInput.safeParse({
    title: formData.get("title"),
    body: formData.get("body"),
    tags: formData.get("tags") ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  return asTenant(user, async (db) => {
    const existing = await db.knowledgeDoc.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!existing) return { error: "That article no longer exists." };

    const wasApproved = existing.status === "approved";

    await db.knowledgeDoc.update({
      where: { id },
      data: {
        title: parsed.data.title,
        body: parsed.data.body,
        tags: parseTags(parsed.data.tags),
        // Back to draft on any edit to approved text. The live answer customers
        // get is the last APPROVED revision, which is untouched by this.
        status: "draft",
        authorId: user.id,
        ...(wasApproved ? { approvedById: null, approvedAt: null } : {}),
      },
    });

    revalidatePath("/admin/knowledge");
    return {
      ok: wasApproved
        ? "Saved as a draft. Customers still get the previously approved version until you approve this one."
        : "Draft saved.",
    };
  });
}

/**
 * Signing an article off.
 *
 * Snapshots the exact text at this version, because a reply recorded three
 * months ago cites "<title> v3" and that reference is worthless if v3 has since
 * been rewritten.
 */
export async function approveDoc(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const doc = await db.knowledgeDoc.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!doc || doc.status === "approved") return;

    // Only bump past the first approval, so a brand-new article approved once
    // is v1 rather than v2.
    const version = doc.approvedAt ? doc.version + 1 : doc.version;

    // Already inside a transaction — `asTenant` opens one so the RLS tenant
    // setting stays bound to the connection for its whole duration. These three
    // writes therefore commit or roll back together without nesting one.
    await db.knowledgeDoc.update({
      where: { id },
      data: { status: "approved", version, approvedById: user.id, approvedAt: new Date() },
    });
    await db.knowledgeRevision.create({
      data: {
        tenantId: user.tenantId,
        docId: id,
        version,
        title: doc.title,
        body: doc.body,
        authorId: doc.authorId,
        approvedById: user.id,
      },
    });
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "knowledge.approved",
        subject: `KnowledgeDoc:${id}`,
        after: { title: doc.title, version },
      },
    });

    logger.info("knowledge approved", { tenantId: user.tenantId, title: doc.title, version });
    revalidatePath("/admin/knowledge");
  });
}

/** Takes an article out of circulation without destroying what it said. */
export async function archiveDoc(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    await db.knowledgeDoc.updateMany({
      where: { id, tenantId: user.tenantId },
      data: { status: "archived" },
    });
    revalidatePath("/admin/knowledge");
  });
}

/**
 * Uploading a document.
 *
 * The request does the minimum that must be transactional — reject a duplicate,
 * bank a row, stash the bytes, queue the work — and returns. Extraction and
 * titling happen in the worker, because a real brochure takes tens of seconds
 * and nobody should be watching a spinner for it.
 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function uploadSource(
  _previous: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const user = await requireUser();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file first." };

  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — 15 MB is the limit.` };
  }
  // Checked by extension as well as type, because browsers report the type
  // inconsistently and a wrong answer here is a confusing failure much later.
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return { error: "PDFs only for now. Word documents need exporting to PDF first." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = checksumOf(bytes);

  const result = await asTenant(user, async (db) => {
    const existing = await db.knowledgeSource.findFirst({
      where: { tenantId: user.tenantId, checksum },
      select: { id: true, filename: true, status: true },
    });
    if (existing) {
      return {
        error:
          existing.status === "failed"
            ? `That's the same file as "${existing.filename}", which couldn't be read. Delete it below before trying again.`
            : `That file has already been uploaded as "${existing.filename}".`,
      };
    }

    const source = await db.knowledgeSource.create({
      data: {
        tenantId: user.tenantId,
        filename: file.name.slice(0, 200),
        mimeType: file.type || "application/pdf",
        byteSize: file.size,
        checksum,
        uploadedById: user.id,
      },
    });
    return { sourceId: source.id };
  });

  if ("error" in result) return result;

  await stashUpload(result.sourceId, bytes);
  await scheduleIngest({ tenantId: user.tenantId, sourceId: result.sourceId });

  revalidatePath("/admin/knowledge");
  return { ok: "Reading it now. Refresh in a moment — everything it finds arrives as a draft for you to check." };
}

/**
 * Removing a source removes the drafts that came out of it, but never anything
 * already approved — someone signed those off, and they are live answers now
 * regardless of where the text originally came from.
 */
export async function deleteSource(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const source = await db.knowledgeSource.findFirst({
      where: { id, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!source) return;

    await db.knowledgeDoc.deleteMany({
      where: { tenantId: user.tenantId, sourceId: id, status: "draft" },
    });
    await db.knowledgeSource.delete({ where: { id } });
    revalidatePath("/admin/knowledge");
  });
}

/** Approves every remaining draft from one document in a single action. */
export async function approveAllFromSource(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    const drafts = await db.knowledgeDoc.findMany({
      where: { tenantId: user.tenantId, sourceId: id, status: "draft" },
    });

    for (const doc of drafts) {
      const version = doc.approvedAt ? doc.version + 1 : doc.version;
      await db.knowledgeDoc.update({
        where: { id: doc.id },
        data: { status: "approved", version, approvedById: user.id, approvedAt: new Date() },
      });
      await db.knowledgeRevision.create({
        data: {
          tenantId: user.tenantId,
          docId: doc.id,
          version,
          title: doc.title,
          body: doc.body,
          authorId: doc.authorId,
          approvedById: user.id,
        },
      });
    }

    await db.knowledgeSource.updateMany({
      where: { id, tenantId: user.tenantId },
      data: { status: "done" },
    });

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "knowledge.bulk_approved",
        subject: `KnowledgeSource:${id}`,
        after: { approved: drafts.length },
      },
    });

    logger.info("knowledge bulk approved", { tenantId: user.tenantId, count: drafts.length });
    revalidatePath("/admin/knowledge");
  });
}

/** Back to draft — deliberately not straight to approved. */
export async function restoreDoc(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await asTenant(user, async (db) => {
    await db.knowledgeDoc.updateMany({
      where: { id, tenantId: user.tenantId, status: "archived" },
      data: { status: "draft" },
    });
    revalidatePath("/admin/knowledge");
  });
}

/**
 * Points enori at the business's own website.
 *
 * Validation happens here, before anything is queued, so a mistyped address or a
 * private URL is refused while the person is still looking at the form rather
 * than becoming a failed row they have to come back and read.
 *
 * The address is the identity: reading the same site twice updates that source
 * rather than creating a second one, which is what makes "read it again" a
 * sensible button. Hashing the fetched text instead would strand the old
 * articles under an orphaned source every time somebody fixed a typo on their
 * homepage.
 */
export async function addWebsiteSource(
  _previous: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const user = await requireUser();

  let url: URL;
  try {
    url = normaliseSiteUrl(String(formData.get("url") ?? ""));
  } catch (err) {
    return {
      error: err instanceof WebSourceError ? `${err.message} ${err.remedy}` : "That is not a web address.",
    };
  }

  const checksum = createHash("sha256").update(`web:${url.toString()}`).digest("hex");

  const result = await asTenant(user, async (db) => {
    const existing = await db.knowledgeSource.findFirst({
      where: { tenantId: user.tenantId, checksum },
      select: { id: true },
    });

    if (existing) {
      // Re-reading, not duplicating. Back to "extracting" so the screen shows
      // it working rather than showing last week's outcome.
      await db.knowledgeSource.update({
        where: { id: existing.id },
        data: { status: "extracting", failureNote: null },
      });
      return { sourceId: existing.id, again: true };
    }

    const source = await db.knowledgeSource.create({
      data: {
        tenantId: user.tenantId,
        kind: "web",
        sourceUrl: url.toString(),
        filename: url.hostname,
        mimeType: "text/html",
        byteSize: 0,
        checksum,
        uploadedById: user.id,
      },
    });
    return { sourceId: source.id, again: false };
  });

  await scheduleIngest({ tenantId: user.tenantId, sourceId: result.sourceId, kind: "web" });

  revalidatePath("/admin/knowledge");
  return {
    ok: result.again
      ? `Reading ${url.hostname} again. Anything new arrives as a draft; what you already approved stays as it is.`
      : `Reading ${url.hostname} now. It follows links within the site, up to twenty-five pages, and everything it finds arrives as a draft for you to check.`,
  };
}

/**
 * Approves every draft carrying one tag.
 *
 * The reason this is worth having: a website read produces drafts across the
 * whole site at once, and they sort naturally by subject rather than by page —
 * "parking", "pricing", "aftercare". Reading forty drafts one at a time is how
 * an import ends up half-approved and abandoned. Reading the six tagged
 * "parking" together is a decision somebody can actually make.
 *
 * Deliberately scoped to DRAFTS. It cannot touch an archived article, so it can
 * never quietly resurrect something a person retired on purpose — a subtlety
 * that matters, because "retired" and "not yet approved" look similar in a list
 * and are opposite intentions.
 *
 * Optionally scoped to one source too, so approving "pricing" from the website
 * does not also approve "pricing" drafts from a brochure uploaded last week and
 * never reviewed.
 */
export async function approveByTag(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tag = String(formData.get("tag") ?? "").trim().toLowerCase();
  const sourceId = String(formData.get("sourceId") ?? "").trim();
  if (!tag) return;

  await asTenant(user, async (db) => {
    const drafts = await db.knowledgeDoc.findMany({
      where: {
        tenantId: user.tenantId,
        status: "draft",
        tags: { has: tag },
        ...(sourceId ? { sourceId } : {}),
      },
    });
    if (drafts.length === 0) return;

    for (const doc of drafts) {
      const version = doc.approvedAt ? doc.version + 1 : doc.version;
      await db.knowledgeDoc.update({
        where: { id: doc.id },
        data: { status: "approved", version, approvedById: user.id, approvedAt: new Date() },
      });
      // Same revision trail as a single approval. A bulk action is still every
      // one of those approvals, and the history has to say who signed each off.
      await db.knowledgeRevision.create({
        data: {
          tenantId: user.tenantId,
          docId: doc.id,
          version,
          title: doc.title,
          body: doc.body,
          authorId: doc.authorId,
          approvedById: user.id,
        },
      });
    }

    // A source with nothing left to check is done being checked.
    const touched = [...new Set(drafts.map((d) => d.sourceId).filter(Boolean))] as string[];
    for (const id of touched) {
      const remaining = await db.knowledgeDoc.count({
        where: { tenantId: user.tenantId, sourceId: id, status: "draft" },
      });
      if (remaining === 0) {
        await db.knowledgeSource.updateMany({
          where: { id, tenantId: user.tenantId },
          data: { status: "done" },
        });
      }
    }

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actor: `user:${user.id}`,
        action: "knowledge.bulk_approved_by_tag",
        subject: sourceId ? `KnowledgeSource:${sourceId}` : `Tenant:${user.tenantId}`,
        after: { tag, approved: drafts.length },
      },
    });

    logger.info("knowledge approved by tag", {
      tenantId: user.tenantId,
      tag,
      count: drafts.length,
    });
    revalidatePath("/admin/knowledge");
  });
}
