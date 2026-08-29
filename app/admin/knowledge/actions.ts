"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asTenant } from "@/lib/auth/guard";
import { logger } from "@/lib/logger";

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
