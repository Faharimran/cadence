import { requireUser, asTenant } from "@/lib/auth/guard";
import { buildKnowledgeContext } from "@/lib/knowledge";
import {
  approveDoc,
  archiveDoc,
  restoreDoc,
  deleteSource,
  approveAllFromSource,
  approveByTag,
} from "./actions";
import { NewDocForm, EditDocForm, UploadForm, WebsiteForm } from "./DocForms";
import { Button, Empty, PageHeader, Pill, Row, Section } from "../ui";

export const dynamic = "force-dynamic";

/**
 * What the business knows, and what it is willing to have repeated.
 *
 * The screen is organised by APPROVAL rather than by subject, because approval
 * is the thing a manager comes here to act on. Drafts sit at the top with a
 * button; everything live sits below, quiet.
 */
export default async function KnowledgePage() {
  const user = await requireUser();

  const { docs, context, sources } = await asTenant(user, async (db) => ({
    docs: await db.knowledgeDoc.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: { source: { select: { filename: true } } },
    }),
    context: await buildKnowledgeContext(db, user.tenantId),
    sources: await db.knowledgeSource.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
    }),
  }));

  const working = sources.filter((s) => s.status === "extracting");

  const drafts = docs.filter((d) => d.status === "draft");

  // Subjects present across the drafts, commonest first — the ones worth
  // approving together are the ones there are several of.
  const draftTags = [...
    drafts
      .flatMap((d) => d.tags)
      .reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>())
  ]
    .map(([tag, count]) => ({ tag, count }))
    .filter((t) => t.count > 1)
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const live = docs.filter((d) => d.status === "approved");
  const archived = docs.filter((d) => d.status === "archived");

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="What you tell customers"
        lede="The assistant can only repeat what is written here. Anything else — how a treatment works, what to expect, how to prepare — it hands to a colleague rather than guessing. Nothing goes live until someone approves it."
      />

      {/* The website first, because it is the one every business already has.
          A brochure has to be found and exported; the address is on their card. */}
      <Section title="Read my website" boxed>
        <WebsiteForm />
      </Section>

      <Section title="Upload a document" boxed>
        <UploadForm />
      </Section>

      {sources.length > 0 && (
        <Section title="Where your answers came from">
          <ul className="flex flex-col gap-2">
            {sources.map((s) => (
              <Row key={s.id}>
                <span className="font-mono text-sm font-semibold">{s.filename}</span>
                {/* A website has no file size, and "0 KB" beside a domain name
                    reads as something having gone wrong. */}
                <span className="font-mono text-[11px] tabular-nums text-ink-3">
                  {s.kind === "web"
                    ? `website${s.pageCount ? ` · ${s.pageCount} pages read` : ""}`
                    : `${(s.byteSize / 1024).toFixed(0)} KB${s.pageCount ? ` · ${s.pageCount} pages` : ""}`}
                </span>

                {s.status === "extracting" && <Pill tone="warn">reading…</Pill>}
                {s.status === "review" && (
                  <Pill tone="warn">{s.chunkCount} draft{s.chunkCount === 1 ? "" : "s"} to check</Pill>
                )}
                {s.status === "done" && <Pill tone="ok">reviewed</Pill>}
                {s.status === "failed" && <Pill tone="bad">couldn&apos;t read it</Pill>}

                {s.failureNote && (
                  <span className="w-full text-sm text-ink-2">{s.failureNote}</span>
                )}

                <div className="ml-auto flex items-center gap-4">
                  {s.status === "review" && s.chunkCount > 0 && (
                    <form action={approveAllFromSource}>
                      <input type="hidden" name="id" value={s.id} />
                      <Button type="submit" variant="quiet">
                        approve all {s.chunkCount}
                      </Button>
                    </form>
                  )}
                  <form action={deleteSource}>
                    <input type="hidden" name="id" value={s.id} />
                    <Button type="submit" variant="quiet">
                      delete
                    </Button>
                  </form>
                </div>
              </Row>
            ))}
          </ul>
          {working.length > 0 && (
            <p className="text-[11px] text-ink-3">
              Reading a document takes a minute or two. Refresh the page to see the drafts.
            </p>
          )}
        </Section>
      )}

      <Section title="Or write one by hand" boxed>
        <NewDocForm />
      </Section>

      {drafts.length > 0 && (
        <Section title={`Waiting for approval (${drafts.length})`}>
          <p className="mb-1 text-sm text-ink-2">
            The assistant cannot see any of these. Read each one as though a customer were reading
            it, then approve.
          </p>

          {/* Approving a subject at a time.
              A website read produces drafts across the whole site at once, and
              they group by subject rather than by page. Forty drafts approved
              one at a time is how an import ends up half-done and abandoned;
              the six about parking are a decision somebody can actually make.
              Counts are shown because the number going live is the thing worth
              knowing before pressing it. */}
          {draftTags.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-2 p-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3">
                approve a subject
              </span>
              {draftTags.map(({ tag, count }) => (
                <form key={tag} action={approveByTag}>
                  <input type="hidden" name="tag" value={tag} />
                  <button
                    type="submit"
                    className="rounded-full border border-line px-3 py-1 font-mono text-[11px] transition-colors hover:border-accent hover:text-accent"
                  >
                    {tag} <span className="text-ink-3">({count})</span>
                  </button>
                </form>
              ))}
              <span className="text-[11px] text-ink-3">
                Approves only drafts — never brings back anything you retired.
              </span>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {drafts.map((d) => (
              <Row key={d.id}>
                <div className="flex w-full flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="font-display text-[15px] font-semibold tracking-tight">{d.title}</span>
                    <Pill tone="warn">draft</Pill>
                    {d.source && (
                      <span className="font-mono text-[11px] text-ink-3">
                        {d.source.filename}
                        {d.sourcePage ? ` · p${d.sourcePage}` : ""}
                      </span>
                    )}
                    {d.tags.map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                    <div className="ml-auto flex items-center gap-4">
                      <EditDocForm doc={d} />
                      <form action={approveDoc}>
                        <input type="hidden" name="id" value={d.id} />
                        <Button type="submit">Approve</Button>
                      </form>
                    </div>
                  </div>
                  <p className="max-w-[80ch] whitespace-pre-wrap text-sm text-ink-2">{d.body}</p>
                </div>
              </Row>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Live — the assistant may say these (${live.length})`}>
        {live.length === 0 ? (
          <Empty>
            Nothing approved yet, so the assistant knows only what you offer, how long it takes and
            when it is free. Every question about how something works goes to a colleague.
          </Empty>
        ) : (
          <>
            <p className="mb-1 text-sm text-ink-2">
              {context.mode === "inline"
                ? "All of these are given to the assistant in full, every conversation."
                : "There are now enough articles that the assistant is given the titles and looks up the ones it needs."}
            </p>
            <ul className="flex flex-col gap-2">
              {live.map((d) => (
                <Row key={d.id}>
                  <div className="flex w-full flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <span className="font-display text-[15px] font-semibold tracking-tight">{d.title}</span>
                      <Pill tone="ok">live · v{d.version}</Pill>
                      {d.tags.map((t) => (
                        <Pill key={t}>{t}</Pill>
                      ))}
                      <div className="ml-auto flex items-center gap-4">
                        <EditDocForm doc={d} />
                        <form action={archiveDoc}>
                          <input type="hidden" name="id" value={d.id} />
                          <Button type="submit" variant="quiet">
                            retire
                          </Button>
                        </form>
                      </div>
                    </div>
                    <p className="max-w-[80ch] whitespace-pre-wrap text-sm text-ink-2">{d.body}</p>
                  </div>
                </Row>
              ))}
            </ul>
          </>
        )}
      </Section>

      {archived.length > 0 && (
        <Section title={`Retired (${archived.length})`}>
          <p className="mb-1 text-sm text-ink-2">
            Kept, because conversations from before they were retired still refer to them.
          </p>
          <ul className="flex flex-col gap-2">
            {archived.map((d) => (
              <Row key={d.id}>
                <span className="font-mono text-sm text-ink-2">{d.title}</span>
                <Pill>retired</Pill>
                <form action={restoreDoc} className="ml-auto">
                  <input type="hidden" name="id" value={d.id} />
                  <Button type="submit" variant="quiet">
                    bring back as draft
                  </Button>
                </form>
              </Row>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
