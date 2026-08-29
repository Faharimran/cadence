import { requireUser, asTenant } from "@/lib/auth/guard";
import { buildKnowledgeContext } from "@/lib/knowledge";
import { approveDoc, archiveDoc, restoreDoc } from "./actions";
import { NewDocForm, EditDocForm } from "./DocForms";
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

  const { docs, context } = await asTenant(user, async (db) => ({
    docs: await db.knowledgeDoc.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    }),
    context: await buildKnowledgeContext(db, user.tenantId),
  }));

  const drafts = docs.filter((d) => d.status === "draft");
  const live = docs.filter((d) => d.status === "approved");
  const archived = docs.filter((d) => d.status === "archived");

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="What you tell customers"
        lede="The assistant can only repeat what is written here. Anything else — how a treatment works, what to expect, how to prepare — it hands to a colleague rather than guessing. Nothing goes live until someone approves it."
      />

      <Section title="Write an article" boxed>
        <NewDocForm />
      </Section>

      {drafts.length > 0 && (
        <Section title={`Waiting for approval (${drafts.length})`}>
          <p className="mb-1 text-sm text-ink-2">
            The assistant cannot see any of these. Read each one as though a customer were reading
            it, then approve.
          </p>
          <ul className="flex flex-col gap-2">
            {drafts.map((d) => (
              <Row key={d.id}>
                <div className="flex w-full flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="font-mono text-sm font-semibold">{d.title}</span>
                    <Pill tone="warn">draft</Pill>
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
                      <span className="font-mono text-sm font-semibold">{d.title}</span>
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
