import Link from "next/link";
import { requireUser, asTenant, can } from "@/lib/auth/guard";
import { LocationForm, ExceptionTypeForm, VoiceForm } from "./forms";
import { Empty, PageHeader, Pill, Row, Section } from "../ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();

  const { locations, types, channel, users, tenant } = await asTenant(user, async (db) => {
    const [locations, types, channel, users, tenant] = await Promise.all([
      db.location.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: "asc" } }),
      db.exceptionType.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { defaultPriority: "desc" },
      }),
      db.channelAccount.findFirst({ where: { tenantId: user.tenantId, channel: "whatsapp" } }),
      db.user.findMany({ where: { tenantId: user.tenantId }, orderBy: { email: "asc" } }),
      db.tenant.findFirstOrThrow({ where: { id: user.tenantId } }),
    ]);
    return { locations, types, channel, users, tenant };
  });

  // The owner-only check moved with the WhatsApp form to its own page.
  const isManager = can(user, "manager");

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Settings"
        lede={`${user.tenantName} · ${user.tenantTimezone} · ${user.tenantCurrency}`}
      />

      {/* ── Voice ─────────────────────────────────────────────────── */}
      <Section title="How the assistant speaks for you" boxed>
        <p className="mb-4 max-w-[66ch] text-sm text-ink-2">
          The assistant knows your services, your hours and what you&apos;ve written down — and
          nothing else. These three fields tell it what kind of business it is answering for, how
          to sound, and what it must never attempt on its own.
        </p>
        {isManager ? (
          <VoiceForm tenant={tenant} />
        ) : (
          <Empty>Only managers and owners can change this.</Empty>
        )}
      </Section>

      {/* ── Locations ─────────────────────────────────────────────── */}
      <Section title="Locations" boxed>
        {isManager ? (
          <LocationForm suggested={user.tenantTimezone} />
        ) : (
          <Empty>Only managers and owners can change locations.</Empty>
        )}
      </Section>

      <Section title="Where you operate">
        {locations.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {locations.map((l) => (
              <Row key={l.id}>
                <span className="font-mono text-sm font-semibold">{l.name}</span>
                {l.code && <Pill>{l.code}</Pill>}
                <span className="font-mono text-xs text-ink-2">{l.timezone}</span>
                {!l.active && <Pill tone="bad">inactive</Pill>}
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Exception types ───────────────────────────────────────── */}
      <Section title="Your words for time off" boxed>
        <p className="mb-4 max-w-[66ch] text-sm text-ink-2">
          Name these however your business talks — “OT day”, “camp Sunday”, “study leave”. What
          you cannot invent is the <em>effect</em>: every type either removes bookable time or
          adds it, and those two are all the engine understands.
        </p>
        {isManager ? (
          <ExceptionTypeForm />
        ) : (
          <Empty>Only managers and owners can change these.</Empty>
        )}
      </Section>

      <Section title="Types in use">
        {types.length === 0 ? (
          <Empty>None yet — leave and closures cannot be recorded until one exists.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {types.map((t) => (
              <Row key={t.id}>
                <span className="font-mono text-sm font-semibold">{t.label}</span>
                <span className="font-mono text-[11px] text-ink-3">{t.code}</span>
                <Pill tone={t.effect === "add" ? "ok" : "bad"}>
                  {t.effect === "add" ? "adds time" : "removes time"}
                </Pill>
                <span className="font-mono text-[11px] text-ink-3">
                  priority {t.defaultPriority}
                </span>
                {t.requiresApproval && <Pill tone="warn">needs approval</Pill>}
                {t.publicVisible ? (
                  <span className="text-xs text-ink-2">
                    customers hear: “{t.defaultPublicReason}”
                  </span>
                ) : (
                  <span className="text-xs text-ink-3">reason never shared</span>
                )}
                {t.systemLocked && <Pill>built in</Pill>}
              </Row>
            ))}
          </ul>
        )}
      </Section>

      {/* ── WhatsApp ──────────────────────────────────────────────── */}
      {/* The form lives on its own page alongside the instructions. Connecting
          WhatsApp means copying three secrets out of Meta's developer console,
          and a bare set of fields with no explanation is where non-technical
          people give up — so the fields and the steps are never separated. */}
      <Section title="WhatsApp" boxed>
        <div className="flex flex-wrap items-center gap-3">
          {channel?.accessToken && channel.active ? (
            <Pill tone="ok">connected</Pill>
          ) : channel ? (
            <Pill tone="warn">started, not finished</Pill>
          ) : (
            <Pill tone="warn">not connected</Pill>
          )}
          {channel?.displayNumber && (
            <span className="font-mono text-xs text-ink-2">{channel.displayNumber}</span>
          )}
        </div>

        <p className="mt-3 max-w-[66ch] text-sm text-ink-2">
          {channel?.accessToken
            ? "Customers can message you and the assistant will answer."
            : "Until this is connected, everything else works — customers just cannot message you."}
        </p>

        <Link
          href="/admin/settings/whatsapp"
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {channel ? "Open the setup guide" : "Connect WhatsApp — step by step"}
        </Link>
      </Section>

      {/* ── People ────────────────────────────────────────────────── */}
      <Section title="Who can sign in">
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <Row key={u.id}>
              <span className="font-mono text-sm">{u.email}</span>
              <Pill>{u.role}</Pill>
              {!u.active && <Pill tone="bad">disabled</Pill>}
              {u.id === user.id && <span className="text-xs text-ink-3">that&apos;s you</span>}
            </Row>
          ))}
        </ul>
        <p className="text-[11px] text-ink-3">
          Adding colleagues is still a command:{" "}
          <code className="font-mono">
            npm run user -- {user.tenantSlug} someone@example.com &lt;password&gt; staff
          </code>
        </p>
      </Section>
    </div>
  );
}
