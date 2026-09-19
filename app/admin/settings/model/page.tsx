import { requireUser, asTenant, can } from "@/lib/auth/guard";
import { describeInstant } from "@/lib/engine/time";
import { getProviderSummary, VENDORS } from "@/lib/conversation/providers";
import { MODELS, resolveModel } from "@/lib/conversation/models";
import { isAgentConfigured } from "@/lib/conversation/agent";
import { ProviderForm, ForgetKey, type VendorOption } from "./forms";
import { TestKey } from "./TestKey";
import { BackLink, Empty, Notice, PageHeader, Pill, Section } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * Whose API key answers customers.
 *
 * Written for a business that already pays for a model somewhere — an in-house
 * Claude account, a DeepSeek balance, a gateway their engineers run — and wants
 * this product to spend that instead of ours. Everyone else never opens this
 * page, which is why the default is on the left and needs no setup.
 *
 * Two things this page has to be honest about, because both are invisible until
 * they cost someone a booking: a model that ignores tools cannot book, and a key
 * that stops working hands conversations to a person rather than quietly
 * spending ours.
 */
export default async function ModelKeyPage() {
  const user = await requireUser();

  const { tenant, provider } = await asTenant(user, async (db) => {
    const tenant = await db.tenant.findFirstOrThrow({ where: { id: user.tenantId } });
    return { tenant, provider: await getProviderSummary(db, user.tenantId) };
  });

  const isOwner = can(user, "owner");
  const isManager = can(user, "manager");

  const { model: cadenceModel } = resolveModel(tenant);
  const cadenceModelLabel = MODELS.find((m) => m.id === cadenceModel)?.label ?? cadenceModel;

  // The list, flattened to what a browser needs. lib/conversation/providers.ts
  // reads the environment, so it stays on the server and only its data crosses.
  const vendors: VendorOption[] = VENDORS.map((v) => ({
    id: v.id,
    label: v.label,
    protocol: v.protocol,
    baseUrl: v.baseUrl,
    keySource: v.keySource,
    exampleModels: v.exampleModels,
    customBaseUrl: v.customBaseUrl,
    note: v.note,
  }));

  const onOwnKey = Boolean(provider?.active);
  const failing = Boolean(provider?.active && provider.lastFailureNote);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackLink href="/admin/settings">settings</BackLink>
        <PageHeader
          title="Which API key answers"
          lede="By default your customers are answered on enori's key and you never think about it. If you already pay a model provider — Claude, DeepSeek, OpenAI, or your own server — you can put that key in here instead, and the usage goes to that account."
        />
        <div className="flex flex-wrap items-center gap-2">
          {failing ? (
            <Pill tone="bad">your key is failing</Pill>
          ) : onOwnKey ? (
            <Pill tone="ok" exact>your own {provider?.vendorLabel} key</Pill>
          ) : (
            <Pill>enori&apos;s key</Pill>
          )}
          {onOwnKey && provider && (
            <span className="num text-[11px] text-ink-faint">
              {provider.model} · key {provider.keyHint}
            </span>
          )}
          {!onOwnKey && !isAgentConfigured() && (
            <Pill tone="warn">this deployment has no platform key</Pill>
          )}
        </div>
      </div>

      {/* Above the form, because somebody arriving here after their customers
          stopped being answered needs the reason first, not the explanation of a
          feature they have already set up. */}
      {failing && provider && (
        <Notice tone="bad" title="Conversations are being handed to a colleague">
          <p className="max-w-[75ch]">{provider.lastFailureNote}</p>
          <p className="mt-1.5 max-w-[75ch] opacity-80">
            {provider.lastFailureAt &&
              `Last failed ${describeInstant(provider.lastFailureAt, tenant.timezone)}. `}
            Until this is fixed, any customer who messages is answered by a person from your inbox
            rather than by the assistant. Fix the key below, or switch back to enori&apos;s — the
            assistant picks up again on the next message either way.
          </p>
        </Notice>
      )}

      <Section title="Whose key to use" boxed>
        {isOwner ? (
          <ProviderForm
            vendors={vendors}
            current={
              provider
                ? {
                    vendor: provider.vendor,
                    vendorLabel: provider.vendorLabel,
                    baseUrl: provider.baseUrl,
                    model: provider.model,
                    active: provider.active,
                    keyHint: provider.keyHint,
                  }
                : null
            }
            cadenceModelLabel={cadenceModelLabel}
          />
        ) : (
          <Empty>Only the owner can change whose key pays for this.</Empty>
        )}
      </Section>

      {provider && (
        <Section title="Check it works" boxed>
          <p className="mb-4 max-w-[70ch] text-sm text-ink-2">
            Asks your provider two things: whether the key is accepted, and whether the model
            actually calls the tools it is given. The second is the one that catches a setup which
            looks fine and cannot book.
          </p>
          {isManager ? (
            <TestKey />
          ) : (
            <Empty>Only managers and owners can run this check.</Empty>
          )}
          {provider.lastOkAt && (
            <p className="num mt-3 text-[11px] text-ink-faint">
              last worked {describeInstant(provider.lastOkAt, tenant.timezone)}
            </p>
          )}
        </Section>
      )}

      {/* The three things a person is entitled to know before handing us a key,
          and that nothing else on this page would tell them. */}
      <Section title="What changes, and what doesn't">
        <div className="flex max-w-[75ch] flex-col gap-4 text-sm leading-relaxed text-ink-2">
          <p>
            <strong className="text-ink">Your key answers customers; ours still reads documents.</strong>{" "}
            Turning an uploaded file into articles runs on enori&apos;s key and is included in what
            you pay us. It is a handful of requests when you upload something, against thousands a
            month for conversations — and it uses a feature not every provider implements the same
            way.
          </p>
          <p>
            <strong className="text-ink">If your key stops working, we do not quietly use ours.</strong>{" "}
            A revoked key, an empty balance or a model that no longer exists hands the conversation
            to a person and says so here. You are not billed by us for messages you thought were
            going to your own account, and a broken integration cannot hide behind a working one.
            Brief faults — a rate limit, a provider hiccup — are simply retried.
          </p>
          <p>
            <strong className="text-ink">Everything else about the assistant is unchanged.</strong>{" "}
            The same tools, the same catalogue, the same articles you approved, the same refusal to
            quote a price nothing gave it. What changes is which model reads that brief and who
            pays for it.
          </p>
        </div>
      </Section>

      {provider && isOwner && (
        <Section title="Remove it">
          <ForgetKey />
        </Section>
      )}
    </div>
  );
}
