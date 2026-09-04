import Link from "next/link";
import { requireUser, asTenant, can } from "@/lib/auth/guard";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { buildKnowledgeContext } from "@/lib/knowledge";
import { systemPrompt } from "@/lib/conversation/agent";
import { resolveModel, MODELS, EFFORTS } from "@/lib/conversation/models";
import { VoiceForm } from "../forms";
import { AgentForm } from "./forms";
import { Empty, PageHeader, Pill, Section } from "../../ui";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const user = await requireUser();

  const { tenant, prompt } = await asTenant(user, async (db) => {
    const tenant = await db.tenant.findFirstOrThrow({ where: { id: user.tenantId } });
    const caps = await resolveCapabilities(db, user.tenantId);
    const knowledge = caps.has("knowledge")
      ? await buildKnowledgeContext(db, user.tenantId)
      : ({ mode: "empty" } as const);

    // Assembled exactly as a real turn assembles it, minus the clock. Rebuilding
    // a "preview" from the same fields separately would be a second
    // implementation that agrees with the first right up until it doesn't —
    // and the whole value of this panel is that it is not a description of the
    // prompt, it is the prompt.
    const prompt = systemPrompt(tenant, caps.list(), knowledge, { degraded: false })
      .map((b) => b.text)
      .join("\n\n");

    return { tenant, prompt };
  });

  const isManager = can(user, "manager");
  const { model, effort } = resolveModel(tenant);
  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;
  const effortLabel = EFFORTS.find((e) => e.id === effort)?.label;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="How the assistant behaves"
        lede={`Everything that decides what ${tenant.name}'s assistant says, and how it says it.`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Pill>{modelLabel}</Pill>
        {effortLabel && <Pill>{effortLabel}</Pill>}
        <Pill tone={tenant.agentInstructions ? "ok" : undefined}>
          {tenant.agentInstructions ? "your instructions are in use" : "no instructions written yet"}
        </Pill>
        <Link
          href="/admin/settings"
          className="ml-auto font-mono text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink"
        >
          back to settings
        </Link>
      </div>

      {/* ── Voice ─────────────────────────────────────────────────── */}
      <Section title="What you are, and how to sound" boxed>
        <p className="mb-4 max-w-[70ch] text-sm text-ink-2">
          The assistant knows your services, your hours and what you&apos;ve written down — and
          nothing else at all. These three tell it what kind of business it is answering for, how to
          sound, and what it must never attempt on its own.
        </p>
        {isManager ? <VoiceForm tenant={tenant} /> : <Empty>Only managers and owners can change this.</Empty>}
      </Section>

      {/* ── Instructions and model ────────────────────────────────── */}
      <Section title="Your instructions, and which model runs them" boxed>
        <p className="mb-6 max-w-[70ch] text-sm text-ink-2">
          Write here the way you&apos;d brief someone starting on the desk tomorrow: the things that
          aren&apos;t written down anywhere but that everyone who works here knows.
        </p>
        {isManager ? (
          <AgentForm tenant={tenant} />
        ) : (
          <Empty>Only managers and owners can change this.</Empty>
        )}
      </Section>

      {/* ── The prompt itself ─────────────────────────────────────── */}
      {/* Shown in full, including the parts nobody here can edit.
          A settings page that quietly assembles instructions you cannot read is
          one where an odd reply has no explanation — and the first question
          after an odd reply is always "what did you actually tell it?" */}
      <Section title="Everything the assistant is told">
        <p className="mb-4 max-w-[70ch] text-sm text-ink-2">
          The complete brief, assembled from the fields above plus your catalogue and articles.
          This is not a summary — it is the text itself, exactly as the assistant receives it before
          each reply. The only thing missing is the current date and time, which changes every turn.
        </p>
        <pre className="max-h-[36rem] overflow-auto rounded-2xl border border-line bg-surface-2 p-5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {prompt}
        </pre>
        <p className="mt-3 font-mono text-[11px] text-ink-3">
          {prompt.length.toLocaleString()} characters
        </p>
      </Section>
    </div>
  );
}
