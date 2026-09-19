import { adminDb } from "@/lib/prisma";
import { findVendor } from "@/lib/conversation/providers";
import { rateFor } from "@/lib/conversation/pricing";

/**
 * What the operator console is allowed to know.
 *
 * This module is the single place in the product that reads across every tenant,
 * and it runs on the owner connection, which row-level security deliberately
 * does not constrain. That is the whole risk, so the rule is written here rather
 * than left to whoever writes the next screen:
 *
 *   **Counts and health. Never a customer.**
 *
 * No query below selects `Customer.name`, `Customer.phone`, `Customer.email`, or
 * `ConversationMessage.body`. Running enori means knowing that Cara Clinic had
 * forty conversations last week and two are waiting on a human; it does not mean
 * being able to read what a patient said. An operator who genuinely needs the
 * content of one thread should be asking the customer for access, and that
 * request should be visible to them.
 *
 * The same rule covers secrets, which is the other thing a cross-tenant reader
 * could trivially help itself to. A tenant's model credential is *spent*, not
 * verified, so unlike a password it is decryptable — which makes "don't select
 * it" the only thing standing between this console and a panel that hands an
 * operator every customer's API key. `loadTenantDetail` therefore never selects
 * `ModelProvider.apiKey` at all, not even to derive a last-four hint from it:
 * the tenant's own settings page shows that hint to the person who pasted the
 * key, and an operator is not that person. What the console gets instead is
 * whether the key works, which is the only part of it anyone here can act on.
 *
 * scripts/provePlatform.ts asserts this rather than trusting it: it seeds a
 * customer with a distinctive name and phone number, and a model provider with
 * a distinctive key, and fails if any of them appears in a rendered page.
 */

const DAY = 86_400_000;

export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  vertical: string | null;
  timezone: string;
  currency: string;
  createdAt: Date;
  /** Whether they could actually take a booking right now. */
  ready: boolean;
  whatsappConnected: boolean;
  conversations7d: number;
  bookings7d: number;
  escalations7d: number;
  approvedArticles: number;
  seats: number;
  /** Model spend over the last 30 days. See the note on `UsageTotals`. */
  usage30d: UsageTotals;
  /** Whose key answers for this business, and whether it is currently working. */
  key: KeySummary;
};

/**
 * Tokens, and what they cost us.
 *
 * `costMicros` is null-aware on purpose: it sums only the rows we actually paid
 * for. A tenant on their own key contributes tokens and no money, so a console
 * showing "4.1M tokens · $0.00" against them is reporting the truth rather than
 * failing to price something.
 */
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + both cache columns. The headline number. */
  total: number;
  roundTrips: number;
  /** USD micros, ours only. */
  costMicros: number;
  /** Tokens we spent but could not price — an unpriced model on our own key. */
  unpricedTokens: number;
};

export type KeySummary = {
  /** Whose bill a conversation lands on. No row at all means ours. */
  source: "platform" | "tenant";
  /** "enori's key", "their own DeepSeek key". Never a credential. */
  label: string;
  model: string | null;
  /** Saved but switched off — they are back on ours without having deleted it. */
  savedButInactive: boolean;
  lastOkAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureNote: string | null;
};

export type PlatformOverview = {
  tenants: TenantRow[];
  totals: {
    tenants: number;
    active: number;
    suspended: number;
    conversations7d: number;
    bookings7d: number;
    escalations7d: number;
    /** Percentage of conversations that ended up with a human, 0–100. */
    escalationRate7d: number;
  };
  /** Model spend across every tenant, last 30 days. */
  spend30d: {
    all: UsageTotals;
    /** What we paid for — the only part that is a bill. */
    platform: UsageTotals;
    /** What tenants paid for themselves. Volume we carry, money we don't. */
    tenant: UsageTotals;
    /** Businesses answering on their own credentials. */
    onOwnKey: number;
    /** True until the ledger has existed for the whole window. */
    partialWindow: boolean;
  };
  attention: AttentionItem[];
};

/**
 * Something a person should look at. Deliberately phrased as a consequence
 * rather than a metric — "cannot take bookings" is actionable, "readiness: 3/4"
 * is a number to interpret.
 */
export type AttentionItem = {
  severity: "bad" | "warn";
  tenantId: string | null;
  tenantName: string | null;
  what: string;
};

// ══════════════════════════════════════════════════════════════════════
//  Model spend
// ══════════════════════════════════════════════════════════════════════

/**
 * One row of the ledger, grouped. Deliberately grouped by model as well as by
 * tenant and payer: "which business is expensive" and "which model made it
 * expensive" are the same question asked twice, and one query answers both.
 */
type UsageGroup = {
  tenantId: string;
  source: string;
  model: string;
  kind?: string;
  _sum: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    roundTrips: number | null;
    costMicros: number | null;
  };
};

const USAGE_SUMS = {
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  roundTrips: true,
  costMicros: true,
} as const;

export const emptyUsageTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  roundTrips: 0,
  costMicros: 0,
  unpricedTokens: 0,
});

/**
 * Folds ledger groups into one set of totals.
 *
 * `unpricedTokens` is the number worth explaining: it counts tokens spent on
 * *our* key against a model that `pricing.ts` has no rate for. That is not a
 * tenant's problem and not a rounding error — it is a model somebody started
 * using without adding it to the rate card, and the only way anyone finds out is
 * if the console refuses to fold it silently into a total that looks complete.
 */
function foldUsage(groups: UsageGroup[]): UsageTotals {
  const t = emptyUsageTotals();

  for (const g of groups) {
    const input = g._sum.inputTokens ?? 0;
    const output = g._sum.outputTokens ?? 0;
    const cacheRead = g._sum.cacheReadTokens ?? 0;
    const cacheWrite = g._sum.cacheWriteTokens ?? 0;

    t.input += input;
    t.output += output;
    t.cacheRead += cacheRead;
    t.cacheWrite += cacheWrite;
    t.roundTrips += g._sum.roundTrips ?? 0;
    t.costMicros += g._sum.costMicros ?? 0;

    if (g.source === "platform" && !rateFor(g.model)) {
      t.unpricedTokens += input + output + cacheRead + cacheWrite;
    }
  }

  t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
  return t;
}

/**
 * Spend per model, keyed by model AND payer.
 *
 * Both halves of the key matter: the same model id run on our key and on a
 * tenant's is two different bills, and merging them would price ours against
 * tokens we never paid for.
 */
function groupBySourceAndModel(
  groups: UsageGroup[],
): { model: string; source: string; totals: UsageTotals }[] {
  const buckets = new Map<string, UsageGroup[]>();
  for (const g of groups) {
    const k = `${g.source}:${g.model}`;
    buckets.set(k, [...(buckets.get(k) ?? []), g]);
  }

  return [...buckets.values()]
    .map((rows) => ({
      model: rows[0].model,
      source: rows[0].source,
      totals: foldUsage(rows),
    }))
    .sort((a, b) => b.totals.total - a.totals.total);
}

/**
 * Whose key answers, without ever touching the key.
 *
 * `apiKey` is absent from the select above rather than selected and discarded,
 * so the ciphertext never enters this process. An operator learns that a
 * business is on their own DeepSeek account and that it last worked on Tuesday;
 * recovering the credential is not something this console can do for them.
 */
function summariseKey(
  row: {
    vendor: string;
    model: string;
    active: boolean;
    lastOkAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureNote: string | null;
  } | null,
): KeySummary {
  // No row, or a row switched off, both mean the same thing at runtime: this
  // tenant's conversations spend ours. See resolveProvider, which is the code
  // this has to agree with.
  if (!row || !row.active) {
    return {
      source: "platform",
      label: "enori's key",
      model: null,
      savedButInactive: Boolean(row && !row.active),
      lastOkAt: null,
      lastFailureAt: null,
      lastFailureNote: null,
    };
  }

  return {
    source: "tenant",
    label: `their own ${findVendor(row.vendor)?.label ?? row.vendor} key`,
    model: row.model,
    savedButInactive: false,
    lastOkAt: row.lastOkAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureNote: row.lastFailureNote,
  };
}

/** Never `apiKey`. See the module header. */
const KEY_SELECT = {
  tenantId: true,
  vendor: true,
  model: true,
  active: true,
  lastOkAt: true,
  lastFailureAt: true,
  lastFailureNote: true,
} as const;

export async function loadOverview(): Promise<PlatformOverview> {
  const since = new Date(Date.now() - 7 * DAY);

  const tenants = await adminDb.tenant.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      vertical: true,
      timezone: true,
      currency: true,
      createdAt: true,
    },
  });

  // One grouped query per metric rather than N per tenant. Counts only — the
  // shape of these selects is itself part of the privacy guarantee.
  // Spend is measured over thirty days, not seven. Seven days of model bills is
  // a number that swings with one busy weekend; thirty is the shape of an
  // invoice, which is the decision this figure actually informs.
  const spendSince = new Date(Date.now() - 30 * DAY);

  const [
    conversations,
    escalated,
    bookings,
    approvedDocs,
    channels,
    users,
    locations,
    rules,
    services,
    usage,
    providers,
    firstUsageEver,
  ] = await Promise.all([
    adminDb.conversation.groupBy({
      by: ["tenantId"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    adminDb.conversation.groupBy({
      by: ["tenantId"],
      where: { createdAt: { gte: since }, botPaused: true },
      _count: { _all: true },
    }),
    adminDb.booking.groupBy({
      by: ["tenantId"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    adminDb.knowledgeDoc.groupBy({
      by: ["tenantId"],
      where: { status: "approved" },
      _count: { _all: true },
    }),
    adminDb.channelAccount.findMany({
      where: { channel: "whatsapp", active: true },
      select: { tenantId: true, accessToken: true },
    }),
    adminDb.user.groupBy({ by: ["tenantId"], where: { active: true }, _count: { _all: true } }),
    adminDb.location.groupBy({ by: ["tenantId"], where: { active: true }, _count: { _all: true } }),
    adminDb.scheduleRule.groupBy({
      by: ["tenantId"],
      where: { effectiveTo: null },
      _count: { _all: true },
    }),
    adminDb.service.groupBy({ by: ["tenantId"], where: { active: true }, _count: { _all: true } }),
    adminDb.modelUsage.groupBy({
      by: ["tenantId", "source", "model"],
      where: { createdAt: { gte: spendSince } },
      _sum: USAGE_SUMS,
    }),
    adminDb.modelProvider.findMany({ select: KEY_SELECT }),
    // The ledger only knows what it has been running long enough to see. Rather
    // than let a freshly deployed console present an empty month as a cheap one,
    // the page says the window is partial — and this is how it knows.
    adminDb.modelUsage.findFirst({
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  const count = (rows: { tenantId: string; _count: { _all: number } }[], id: string) =>
    rows.find((r) => r.tenantId === id)?._count._all ?? 0;

  const connected = new Set(channels.filter((c) => c.accessToken).map((c) => c.tenantId));
  const providerByTenant = new Map(providers.map((p) => [p.tenantId, p]));

  const rows: TenantRow[] = tenants.map((t) => ({
    ...t,
    // The same three things the tenant's own checklist calls required: somewhere
    // to work, something to book, and hours to book it in.
    ready:
      count(locations, t.id) > 0 && count(services, t.id) > 0 && count(rules, t.id) > 0,
    whatsappConnected: connected.has(t.id),
    conversations7d: count(conversations, t.id),
    bookings7d: count(bookings, t.id),
    escalations7d: count(escalated, t.id),
    approvedArticles: count(approvedDocs, t.id),
    seats: count(users, t.id),
    usage30d: foldUsage(usage.filter((u) => u.tenantId === t.id)),
    key: summariseKey(providerByTenant.get(t.id) ?? null),
  }));

  const totalConversations = rows.reduce((n, r) => n + r.conversations7d, 0);
  const totalEscalations = rows.reduce((n, r) => n + r.escalations7d, 0);

  return {
    tenants: rows,
    totals: {
      tenants: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      suspended: rows.filter((r) => r.status !== "active").length,
      conversations7d: totalConversations,
      bookings7d: rows.reduce((n, r) => n + r.bookings7d, 0),
      escalations7d: totalEscalations,
      escalationRate7d:
        totalConversations === 0 ? 0 : Math.round((totalEscalations / totalConversations) * 100),
    },
    spend30d: {
      all: foldUsage(usage),
      platform: foldUsage(usage.filter((u) => u.source === "platform")),
      tenant: foldUsage(usage.filter((u) => u.source === "tenant")),
      onOwnKey: rows.filter((r) => r.key.source === "tenant").length,
      partialWindow: !firstUsageEver || firstUsageEver.createdAt > spendSince,
    },
    attention: await loadAttention(rows),
  };
}

/**
 * The list that justifies the page existing.
 *
 * Ordered by what costs a customer something: a business that cannot take a
 * booking is losing money right now; a disabled webhook means their CRM has
 * quietly stopped hearing about appointments; an unread draft is merely idle.
 */
async function loadAttention(rows: TenantRow[]): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  for (const t of rows) {
    if (t.status !== "active") {
      items.push({
        severity: "bad",
        tenantId: t.id,
        tenantName: t.name,
        what: "Suspended — nothing is being answered or booked.",
      });
      continue;
    }
    if (!t.ready) {
      items.push({
        severity: "bad",
        tenantId: t.id,
        tenantName: t.name,
        what: "Set-up unfinished, so no time can be offered.",
      });
    }
    if (t.ready && t.approvedArticles === 0) {
      items.push({
        severity: "warn",
        tenantId: t.id,
        tenantName: t.name,
        what: "Nothing approved to say — every question goes to a colleague.",
      });
    }
    if (t.ready && !t.whatsappConnected) {
      items.push({
        severity: "warn",
        tenantId: t.id,
        tenantName: t.name,
        what: "WhatsApp not connected, so customers cannot reach the assistant.",
      });
    }
    // A business on its own key whose key has stopped working is the one failure
    // here that is actively costing them customers as you read it: by design
    // there is no fallback onto ours, so every thread is being handed to a
    // colleague who may not be watching. They are told on their own settings
    // page — this is so we find out before they complain.
    if (t.key.source === "tenant" && t.key.lastFailureAt) {
      items.push({
        severity: "bad",
        tenantId: t.id,
        tenantName: t.name,
        what: `Their own key is failing, so every thread goes to a person. ${t.key.lastFailureNote ?? ""}`.trim(),
      });
    }
  }

  const [deadEndpoints, failedSources] = await Promise.all([
    adminDb.webhookEndpoint.findMany({
      where: { active: false },
      select: { id: true, tenantId: true, url: true, tenant: { select: { name: true } } },
      take: 20,
    }),
    adminDb.knowledgeSource.findMany({
      where: { status: "failed" },
      select: { id: true, tenantId: true, filename: true, tenant: { select: { name: true } } },
      take: 20,
    }),
  ]);

  for (const e of deadEndpoints) {
    items.push({
      severity: "bad",
      tenantId: e.tenantId,
      tenantName: e.tenant.name,
      // The host, not the full URL — a path can carry a token.
      what: `Webhook to ${hostOf(e.url)} switched itself off after repeated failures.`,
    });
  }
  for (const s of failedSources) {
    items.push({
      severity: "warn",
      tenantId: s.tenantId,
      tenantName: s.tenant.name,
      what: `Couldn't read the uploaded "${s.filename}".`,
    });
  }

  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "bad" ? -1 : 1));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an endpoint";
  }
}

// ══════════════════════════════════════════════════════════════════════
//  One tenant
// ══════════════════════════════════════════════════════════════════════

export type TenantDetail = NonNullable<Awaited<ReturnType<typeof loadTenantDetail>>>;

export async function loadTenantDetail(tenantId: string) {
  const tenant = await adminDb.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      vertical: true,
      timezone: true,
      currency: true,
      descriptor: true,
      escalationTopics: true,
      createdAt: true,
    },
  });
  if (!tenant) return null;

  const since = new Date(Date.now() - 30 * DAY);

  const [
    locations,
    resources,
    services,
    rules,
    conversations30d,
    escalated30d,
    bookings30d,
    messages30d,
    knowledge,
    sources,
    channel,
    endpoints,
    failedDeliveries,
    capabilities,
    users,
    apiKeys,
    recentAudit,
    usageGroups,
    providerRow,
    lifetime,
  ] = await Promise.all([
    adminDb.location.count({ where: { tenantId, active: true } }),
    adminDb.resource.count({ where: { tenantId, active: true } }),
    adminDb.service.count({ where: { tenantId, active: true } }),
    adminDb.scheduleRule.count({ where: { tenantId, effectiveTo: null } }),
    adminDb.conversation.count({ where: { tenantId, createdAt: { gte: since } } }),
    adminDb.conversation.count({ where: { tenantId, createdAt: { gte: since }, botPaused: true } }),
    adminDb.booking.groupBy({
      by: ["status"],
      where: { tenantId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    adminDb.conversationMessage.groupBy({
      by: ["direction"],
      where: { tenantId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    adminDb.knowledgeDoc.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: { _all: true },
    }),
    adminDb.knowledgeSource.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, filename: true, status: true, chunkCount: true, createdAt: true },
    }),
    adminDb.channelAccount.findFirst({
      where: { tenantId, channel: "whatsapp" },
      // Never the token, the app secret or the verify token — not even to
      // report whether they look right. Presence is all the console needs.
      select: { displayNumber: true, active: true, accessToken: true },
    }),
    adminDb.webhookEndpoint.findMany({
      where: { tenantId },
      select: { id: true, url: true, active: true, events: true, disabledReason: true },
    }),
    adminDb.webhookDelivery.count({ where: { tenantId, status: "failed" } }),
    adminDb.tenantCapability.findMany({
      where: { tenantId },
      select: { capability: true, mode: true, connector: true },
      orderBy: { capability: "asc" },
    }),
    adminDb.user.findMany({
      where: { tenantId },
      // Staff emails are operational, not customer data — an operator needs to
      // know who to contact when a tenant is stuck.
      select: { email: true, role: true, active: true, lastLoginAt: true },
      orderBy: { email: "asc" },
    }),
    adminDb.apiKey.count({ where: { tenantId, revokedAt: null } }),
    adminDb.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, action: true, actor: true, createdAt: true },
    }),
    adminDb.modelUsage.groupBy({
      by: ["tenantId", "source", "model", "kind"],
      where: { tenantId, createdAt: { gte: since } },
      _sum: USAGE_SUMS,
    }),
    // Never `apiKey`. See the module header — this is the select that guarantee
    // actually lives in.
    adminDb.modelProvider.findFirst({ where: { tenantId }, select: KEY_SELECT }),
    adminDb.modelUsage.aggregate({
      where: { tenantId },
      _sum: { costMicros: true },
      _min: { createdAt: true },
    }),
  ]);

  return {
    tenant,
    setup: { locations, resources, services, rules },
    ready: locations > 0 && services > 0 && rules > 0,
    volume: {
      conversations30d,
      escalated30d,
      inbound30d: messages30d.find((m) => m.direction === "inbound")?._count._all ?? 0,
      outbound30d: messages30d.find((m) => m.direction === "outbound")?._count._all ?? 0,
      bookings30d,
    },
    knowledge: {
      approved: knowledge.find((k) => k.status === "approved")?._count._all ?? 0,
      draft: knowledge.find((k) => k.status === "draft")?._count._all ?? 0,
      archived: knowledge.find((k) => k.status === "archived")?._count._all ?? 0,
    },
    sources,
    channel: channel
      ? {
          displayNumber: channel.displayNumber,
          active: channel.active,
          hasToken: Boolean(channel.accessToken),
        }
      : null,
    endpoints: endpoints.map((e) => ({
      id: e.id,
      // The host only. A webhook path routinely carries a token.
      host: hostOf(e.url),
      active: e.active,
      events: e.events,
      disabledReason: e.disabledReason,
    })),
    failedDeliveries,
    capabilities,
    users,
    apiKeys,
    recentAudit,
    key: summariseKey(providerRow),
    spend: {
      total30d: foldUsage(usageGroups),
      /** Conversations and ingestion cost differently and are steered differently. */
      byKind: ["conversation", "ingestion"].map((kind) => ({
        kind,
        totals: foldUsage(usageGroups.filter((g) => g.kind === kind)),
      })),
      /** Which model the money actually went to, biggest first. */
      byModel: groupBySourceAndModel(usageGroups),
      /**
       * Everything they have ever cost us, not just this window. The number a
       * conversation about an account actually starts from.
       */
      lifetimeCostMicros: lifetime._sum.costMicros ?? 0,
      firstRecordedAt: lifetime._min.createdAt,
    },
  };
}
