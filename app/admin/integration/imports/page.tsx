import { requireUser, asTenant, can } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { KINDS, type ImportKind } from "@/lib/imports/fields";
import { syncNow, undoRun, pauseLink, disconnectLink } from "./actions";
import { ConnectForm } from "./forms";
import { BackLink, Button, Empty, PageHeader, Pill, Section } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * Bringing in what the business already has.
 *
 * The premise: a salon that has priced its services in the same spreadsheet for
 * six years is not going to retype it here and then maintain two copies. One of
 * the two becomes the real one and it will not be ours. So the sheet stays
 * theirs and cadence follows it.
 *
 * Nothing on this page is Google-specific except the sharing instructions. The
 * pipeline takes rows and columns, so an export from Zoho, Zenoti, Fresha or a
 * till system lands in exactly the same place — which matters, because
 * businesses arrive from software we have never heard of and all of it exports
 * a table.
 */
export default async function ImportsPage() {
  const user = await requireUser();
  const isManager = can(user, "manager");

  const { links, runs } = await asTenant(user, async (db) => {
    const [links, runs] = await Promise.all([
      db.sheetLink.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { createdAt: "desc" },
      }),
      db.importRun.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { startedAt: "desc" },
        take: 15,
      }),
    ]);
    return { links, runs };
  });

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <BackLink href="/admin/integration">connecting other software</BackLink>
        <PageHeader
          title="Bring in what you already have"
          lede="Point cadence at the spreadsheet you already keep. It reads it, and re-reads it every fifteen minutes, so the sheet stays the copy you edit."
        />
      </div>

      {/* ── Connected sheets ───────────────────────────────────────── */}
      {links.length > 0 && (
        <Section title="Sheets you have connected">
          <ul className="flex flex-col gap-3">
            {links.map((l) => {
              const kind = KINDS[l.kind as ImportKind];
              return (
                <li key={l.id} className="rounded-2xl border border-rule p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-semibold">{kind?.label ?? l.kind}</span>
                    {l.status === "active" && <Pill tone="ok">in sync</Pill>}
                    {l.status === "paused" && <Pill>paused</Pill>}
                    {l.status === "error" && <Pill tone="bad">cannot read it</Pill>}
                    {l.removeMissing && <Pill tone="warn">removes missing rows</Pill>}
                    <span className="num ml-auto text-[11px] text-ink-3">
                      {l.lastSyncAt
                        ? `read ${describeInstant(l.lastSyncAt, user.tenantTimezone)}`
                        : "not read yet"}
                    </span>
                  </div>

                  <a
                    href={l.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block max-w-full truncate font-mono text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
                  >
                    {l.sourceUrl}
                  </a>

                  {l.lastError && (
                    <p className="txt-bad mt-3 max-w-[70ch] text-[13px]">
                      {l.lastError}
                    </p>
                  )}

                  {isManager && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <form action={syncNow.bind(null, l.id)}>
                        <Button type="submit">Read it now</Button>
                      </form>
                      <form action={pauseLink.bind(null, l.id, l.status !== "paused")}>
                        <button
                          type="submit"
                          className="font-mono text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
                        >
                          {l.status === "paused" ? "resume" : "pause"}
                        </button>
                      </form>
                      <form action={disconnectLink.bind(null, l.id)}>
                        <button
                          type="submit"
                          className="txt-bad text-[11px] underline underline-offset-2"
                        >
                          disconnect
                        </button>
                      </form>
                      <span className="text-[11px] text-ink-3">
                        Disconnecting stops the syncing. What it already imported stays.
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* ── Connect one ────────────────────────────────────────────── */}
      <Section title={links.length > 0 ? "Connect another sheet" : "Connect a sheet"} boxed>
        {isManager ? (
          <ConnectForm />
        ) : (
          <Empty>Only managers and owners can connect a spreadsheet.</Empty>
        )}
      </Section>

      {/* ── History, with the undo ─────────────────────────────────── */}
      <Section title="What each read changed">
        {runs.length === 0 ? (
          <Empty>Nothing has been imported yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-rule px-4 py-3 text-sm"
              >
                <span className="num text-[11px] text-ink-3">
                  {describeInstant(r.startedAt, user.tenantTimezone)}
                </span>
                <span className="num text-[11px] text-ink-3">{r.trigger}</span>

                {r.status === "failed" ? (
                  <span className="txt-bad">{r.error}</span>
                ) : r.status === "reverted" ? (
                  <Pill>undone</Pill>
                ) : (
                  <span className="text-ink-2">
                    {r.created > 0 && `${r.created} added`}
                    {r.created > 0 && (r.updated > 0 || r.skipped > 0) && ", "}
                    {r.updated > 0 && `${r.updated} updated`}
                    {r.updated > 0 && r.skipped > 0 && ", "}
                    {r.skipped > 0 && `${r.skipped} skipped`}
                    {r.created === 0 && r.updated === 0 && r.skipped === 0 && "nothing had changed"}
                  </span>
                )}

                {Array.isArray(r.issues) && r.issues.length > 0 && (
                  <details className="w-full">
                    <summary className="cursor-pointer font-mono text-[11px] text-ink-3 hover:text-ink">
                      {r.issues.length} row{r.issues.length === 1 ? "" : "s"} needed attention
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1 pl-4">
                      {(r.issues as { row: number; column?: string; problem: string }[]).map(
                        (issue, i) => (
                          <li key={i} className="text-[12px] text-ink-2">
                            <span className="text-ink-3">
                              row {issue.row}
                              {issue.column ? ` · ${issue.column}` : ""}
                            </span>{" "}
                            {issue.problem}
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                )}

                {/* The undo. Imports apply immediately, which is only a
                    reasonable trade because this is here and complete. */}
                {isManager &&
                  r.status === "ok" &&
                  (r.created > 0 || r.updated > 0) && (
                    <form action={undoRun.bind(null, r.id)} className="ml-auto">
                      <button
                        type="submit"
                        className="txt-bad text-[11px] underline underline-offset-2 hover:opacity-70"
                      >
                        undo this
                      </button>
                    </form>
                  )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Coming from other software ─────────────────────────────── */}
      <Section title="Coming from Zoho, Zenoti, Fresha or something else">
        <p className="max-w-[72ch] text-sm text-ink-2">
          All of them can export a spreadsheet. Export your services or customers to CSV or Excel,
          put that file in Google Sheets — <em>File → Import</em> — and connect it here the same
          way. The columns do not need renaming first; that is what the step above is for.
        </p>
        <p className="mt-3 max-w-[72ch] text-sm text-ink-2">
          A one-off export stops being true the moment someone changes a price in the old system.
          If you are still running both, keep the sheet as the copy you edit and let both follow
          it, rather than exporting again each week.
        </p>
      </Section>
    </div>
  );
}
