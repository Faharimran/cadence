import { adminDb } from "@/lib/prisma";

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
 * `ConversationMessage.body`. Running cadence means knowing that Cara Clinic had
 * forty conversations last week and two are waiting on a human; it does not mean
 * being able to read what a patient said. An operator who genuinely needs the
 * content of one thread should be asking the customer for access, and that
 * request should be visible to them.
 *
 * scripts/provePlatform.ts asserts this rather than trusting it: it seeds a
 * customer with a distinctive name and phone number and fails if either appears
 * in any rendered console page.
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
  ]);

  const count = (rows: { tenantId: string; _count: { _all: number } }[], id: string) =>
    rows.find((r) => r.tenantId === id)?._count._all ?? 0;

  const connected = new Set(channels.filter((c) => c.accessToken).map((c) => c.tenantId));

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
  };
}
