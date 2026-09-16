import type { TenantDb } from "@/lib/prisma";
import { env } from "@/lib/env";
import { decrypt } from "@/lib/crypto";
import { CadenceError } from "@/lib/api/errors";
import { MODELS, resolveModel } from "@/lib/conversation/models";

/**
 * Whose API key answers a customer, and how to speak to it.
 *
 * A business can bring its own — Claude, DeepSeek, whatever their infrastructure
 * team already pays for — or spend cadence's, which is what they get until they
 * decide otherwise. That choice is one row (`ModelProvider`), and its absence is
 * the default.
 *
 * The line this file draws is the same one drawn around exception effects
 * elsewhere in the codebase: **the endpoint and the model are data; the wire
 * protocol is code.** There are exactly two protocols, and they are ours:
 *
 *   anthropic — the Messages API, with tool use and prompt caching.
 *   openai    — chat-completions, which is what DeepSeek, Groq, OpenRouter,
 *               Mistral, Fireworks and anything self-hosted behind vLLM answer.
 *
 * Every vendor anyone has asked for is one of those two on the wire. Adding a
 * "vendor" is therefore a row in the list below and no new code — and the day a
 * genuinely different protocol appears, it arrives as a driver someone wrote and
 * read, not as a URL a tenant typed into a box that the agent then has to guess
 * the shape of.
 */

/** The closed set. Not configurable, by design. */
export type Protocol = "anthropic" | "openai";

export type Vendor = {
  id: string;
  label: string;
  protocol: Protocol;
  /** Null for Anthropic, whose SDK knows its own host. */
  baseUrl: string | null;
  /** Where this business goes to get a key, in the words that site uses. */
  keySource: string;
  /** What the key looks like, so an obviously wrong paste is caught early. */
  keyPrefix?: string;
  /** Model ids people actually use here. A hint, never a validated list. */
  exampleModels: string[];
  /** Whether the tenant may (and must) supply their own endpoint. */
  customBaseUrl?: boolean;
  note?: string;
};

/**
 * Presets, and only presets.
 *
 * Nothing in the agent branches on `vendor`. It exists so that a person setting
 * this up picks "DeepSeek" instead of being asked for a base URL, and so the
 * page can tell them where their key comes from. Anything not on this list is
 * `custom`, which is the same code path with the URL supplied by them.
 */
export const VENDORS: Vendor[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    protocol: "anthropic",
    baseUrl: null,
    keySource: "console.anthropic.com → API keys",
    keyPrefix: "sk-ant-",
    exampleModels: MODELS.map((m) => m.id),
    note: "The same models cadence runs, billed to you instead of to us.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keySource: "platform.deepseek.com → API keys",
    keyPrefix: "sk-",
    exampleModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keySource: "platform.openai.com → API keys",
    keyPrefix: "sk-",
    exampleModels: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keySource: "openrouter.ai → Keys",
    keyPrefix: "sk-or-",
    exampleModels: ["anthropic/claude-sonnet-5", "deepseek/deepseek-chat"],
    note: "One key, most vendors. Model ids here are written vendor/model.",
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keySource: "console.groq.com → API keys",
    keyPrefix: "gsk_",
    exampleModels: ["llama-3.3-70b-versatile"],
  },
  {
    id: "mistral",
    label: "Mistral",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keySource: "console.mistral.ai → API keys",
    exampleModels: ["mistral-large-latest"],
  },
  {
    id: "custom",
    label: "Anything else",
    protocol: "openai",
    baseUrl: null,
    customBaseUrl: true,
    keySource: "your provider, or your own server",
    exampleModels: [],
    note:
      "Any endpoint that answers OpenAI's chat-completions shape — a hosted vendor, a gateway, " +
      "or a model you run yourself behind vLLM, Ollama or LiteLLM.",
  },
];

export function findVendor(id: string): Vendor | undefined {
  return VENDORS.find((v) => v.id === id);
}

export function isKnownVendor(id: string): boolean {
  return VENDORS.some((v) => v.id === id);
}

// ══════════════════════════════════════════════════════════════════════
//  What a turn actually runs against
// ══════════════════════════════════════════════════════════════════════

export type ResolvedProvider = {
  /** Whose money this turn spends. The only thing the agent branches on. */
  source: "cadence" | "tenant";
  protocol: Protocol;
  apiKey: string;
  /** Null means the protocol's default host. */
  baseUrl: string | null;
  model: string;
  /**
   * Anthropic only, and only for models known to accept it. Sent to a model
   * that predates `output_config.effort` it is a 400 — and a 400 here is a
   * customer who never got a reply.
   */
  effort?: "low" | "medium" | "high";
  /** For sentences a person reads: "your own DeepSeek key". */
  label: string;
  /**
   * Whether a successful turn should write `lastOkAt`.
   *
   * False almost always, because this row records a change of state, not a
   * heartbeat: a busy tenant sends thousands of messages a day and every one of
   * them would otherwise be an extra UPDATE to say the same thing. True when
   * there is something to correct — a recorded failure that has since cleared,
   * or a key that has never yet been seen to work.
   */
  shouldRecordOk?: boolean;
};

/** How stale `lastOkAt` may get before a successful turn refreshes it. */
const OK_REFRESH_MS = 60 * 60 * 1000;

/**
 * A provider that would not answer, classified by whether waiting helps.
 *
 * The distinction is the whole point of this class, and it decides what happens
 * to the customer waiting at the other end:
 *
 *   credential — a revoked key, an exhausted balance, a model id that does not
 *                exist, a base URL that is not an API. None of these fix
 *                themselves, so retrying just burns the queue's attempts and
 *                leaves the thread silent. The turn hands over to a colleague
 *                and the settings page says why.
 *
 *   transient  — a 429, a 502, a timeout. These fix themselves, usually within
 *                seconds, and BullMQ already retries three times with backoff.
 *                Pausing a thread for one of these would need a human to hand
 *                it back afterwards, which is a worse outcome than waiting.
 */
export class ProviderFailure extends Error {
  readonly kind: "credential" | "transient";
  readonly status?: number;
  /** One sentence, for a business owner, naming what to do about it. */
  readonly note: string;

  constructor(kind: "credential" | "transient", note: string, status?: number) {
    super(note);
    this.name = "ProviderFailure";
    this.kind = kind;
    this.note = note;
    this.status = status;
  }
}

export function isProviderFailure(err: unknown): err is ProviderFailure {
  return err instanceof ProviderFailure;
}

/**
 * What a failed turn should do about it.
 *
 *   retry    — throw, and let the queue's three attempts do their work.
 *   escalate — hand the thread to a colleague now, and record why.
 *
 * A function rather than three lines inside the agent because this is the rule
 * the whole feature turns on, and it is worth being able to assert directly:
 * `scripts/proveModelProviders.ts` checks every combination, including the one
 * that must never happen — cadence's own key pausing a tenant's threads.
 */
export function failureResponse(
  source: "cadence" | "tenant",
  kind: "credential" | "transient",
): "retry" | "escalate" {
  // Our own key failing is our incident, not theirs. Pausing every tenant's
  // threads over it would turn a ten-minute outage into a day of manual inbox
  // work for every customer, each one needing a person to hand the thread back.
  if (source === "cadence") return "retry";
  return kind === "credential" ? "escalate" : "retry";
}

/**
 * HTTP status and body → a sentence the person who pasted the key can act on.
 *
 * Provider error bodies are written for whoever wrote the integration, not for
 * whoever owns the account: "invalid_request_error: model not found" tells a
 * barber nothing. Every branch here names the field on the settings page that
 * is wrong, because that is the next thing they have to do.
 */
export function classifyFailure(status: number, body: string, vendorLabel: string): ProviderFailure {
  const detail = extractMessage(body);
  const suffix = detail ? ` ${vendorLabel} said: ${detail}` : "";

  if (status === 401 || status === 403) {
    return new ProviderFailure(
      "credential",
      `${vendorLabel} rejected the API key. It may have been revoked or copied incompletely — paste it again.${suffix}`,
      status,
    );
  }
  // 402 is DeepSeek's "Insufficient Balance", and the reason billing failures
  // are credential-class: no amount of retrying tops up an account.
  if (status === 402) {
    return new ProviderFailure(
      "credential",
      `The ${vendorLabel} account has no credit left, so it refused the request. Top it up and the assistant resumes.${suffix}`,
      status,
    );
  }
  if (status === 404) {
    return new ProviderFailure(
      "credential",
      `${vendorLabel} has no such endpoint or model. Check the model id, and the address if you typed one.${suffix}`,
      status,
    );
  }
  if (status === 400 || status === 422) {
    return new ProviderFailure(
      "credential",
      `${vendorLabel} refused the request as invalid — most often a model id that does not exist on this account.${suffix}`,
      status,
    );
  }
  if (status === 429) {
    return new ProviderFailure(
      "transient",
      `${vendorLabel} is rate-limiting this key. Replies will catch up on their own.${suffix}`,
      status,
    );
  }
  return new ProviderFailure(
    "transient",
    `${vendorLabel} did not answer (HTTP ${status}). This is usually theirs and usually brief.${suffix}`,
    status,
  );
}

/** Pulls the human-readable line out of whatever error shape came back. */
function extractMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: string;
    };
    const message =
      (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ??
      parsed.message ??
      parsed.detail;
    if (message) return truncate(String(message));
  } catch {
    // Not JSON. An HTML error page from a proxy in front of the real endpoint is
    // a real case, and pasting its markup into the admin helps nobody.
    if (/^\s*</.test(body)) return "";
  }
  return truncate(body.trim());
}

const truncate = (s: string, max = 180) => (s.length > max ? `${s.slice(0, max)}…` : s);

// ══════════════════════════════════════════════════════════════════════
//  Resolution
// ══════════════════════════════════════════════════════════════════════

export type TenantModelChoice = { agentModel: string | null; agentEffort: string | null };

/** The stored row, minus the secret. Safe to hand to a page. */
export type ProviderSummary = {
  vendor: string;
  vendorLabel: string;
  protocol: Protocol;
  baseUrl: string | null;
  model: string;
  active: boolean;
  keyHint: string;
  lastOkAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureNote: string | null;
};

/**
 * Which key this tenant's next turn runs on.
 *
 * Reads the tenant's row if there is an active one, and otherwise falls through
 * to the platform key with the tenant's chosen model and effort. There is no
 * third case and deliberately no fallback *between* the two: a business that
 * brought its own key has opted out of ours, and silently spending ours when
 * theirs stops working is both a bill they did not agree to and a broken
 * integration nobody would ever notice.
 */
export async function resolveProvider(
  db: TenantDb,
  tenantId: string,
  tenant: TenantModelChoice,
): Promise<ResolvedProvider> {
  const row = await db.modelProvider.findFirst({ where: { tenantId, active: true } });

  if (row) {
    const vendor = findVendor(row.vendor);
    return {
      source: "tenant",
      protocol: row.protocol === "anthropic" ? "anthropic" : "openai",
      apiKey: decrypt(row.apiKey),
      baseUrl: row.baseUrl,
      model: row.model,
      // Their key, their model id — which may be anything. Effort is sent only
      // for the models we can positively identify as accepting it.
      effort:
        row.protocol === "anthropic" && MODELS.find((m) => m.id === row.model)?.supportsEffort
          ? resolveModel(tenant).effort
          : undefined,
      label: `your own ${vendor?.label ?? row.vendor} key`,
      shouldRecordOk:
        Boolean(row.lastFailureAt) ||
        !row.lastOkAt ||
        Date.now() - row.lastOkAt.getTime() > OK_REFRESH_MS,
    };
  }

  if (!env.ANTHROPIC_API_KEY) {
    throw new CadenceError(
      "capability_unavailable",
      "No model is configured — cadence has no platform key and this business has not added its own.",
    );
  }

  const { model, effort } = resolveModel(tenant);
  return {
    source: "cadence",
    protocol: "anthropic",
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: null,
    model,
    effort,
    label: "cadence's key",
  };
}

/** The saved row for a settings page. Never includes the key itself. */
export async function getProviderSummary(
  db: TenantDb,
  tenantId: string,
): Promise<ProviderSummary | null> {
  const row = await db.modelProvider.findFirst({ where: { tenantId } });
  if (!row) return null;

  return {
    vendor: row.vendor,
    vendorLabel: findVendor(row.vendor)?.label ?? row.vendor,
    protocol: row.protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: row.baseUrl,
    model: row.model,
    active: row.active,
    // Enough to recognise which key is saved, not enough to use it. The last
    // four characters are what people check against their provider's own list.
    keyHint: keyHint(row.apiKey),
    lastOkAt: row.lastOkAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureNote: row.lastFailureNote,
  };
}

function keyHint(encrypted: string): string {
  try {
    const plain = decrypt(encrypted);
    return plain.length > 4 ? `…${plain.slice(-4)}` : "…";
  } catch {
    // The encryption key changed since this was written. Say so here rather
    // than letting the page render a confident-looking blank.
    return "unreadable";
  }
}

/**
 * Records that the key worked, or that it did not.
 *
 * Written on the way past a turn rather than by a health check, because the only
 * request that proves a key works is a real one. `lastFailureNote` is cleared on
 * success so the page never shows a fault that has since fixed itself.
 */
export async function recordProviderOk(db: TenantDb, tenantId: string): Promise<void> {
  await db.modelProvider.updateMany({
    where: { tenantId },
    data: { lastOkAt: new Date(), lastFailureAt: null, lastFailureNote: null },
  });
}

export async function recordProviderFailure(
  db: TenantDb,
  tenantId: string,
  note: string,
): Promise<void> {
  await db.modelProvider.updateMany({
    where: { tenantId },
    data: { lastFailureAt: new Date(), lastFailureNote: note },
  });
}

/**
 * Where an OpenAI-shaped request actually goes.
 *
 * People paste all three of these, and all three are correct on some provider:
 *   https://api.deepseek.com
 *   https://api.deepseek.com/v1
 *   https://api.deepseek.com/v1/chat/completions
 *
 * Appending blindly turns the third into a 404 with nothing on the page to
 * explain it, so the path is appended only when it is not already there.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Whether this is somewhere we are willing to send a request, and why not.
 *
 * The endpoint a tenant types is fetched by cadence's own server, from inside
 * cadence's own network. That makes the box on the settings page a
 * server-side-request primitive unless something says otherwise, and the classic
 * target is one hop away: `http://169.254.169.254/` is the cloud metadata
 * service on every major host, and it answers to anyone who can reach it.
 *
 * So: https only, and no addresses that are private by construction. A business
 * that genuinely runs its own model inside the same network sets
 * CADENCE_ALLOW_PRIVATE_MODEL_ENDPOINTS — a deployment-level decision, made by
 * whoever operates cadence, not by a tenant typing in a form.
 *
 * Returns a sentence to show a person, or null when the address is fine.
 *
 * What this does NOT stop is a public hostname that resolves to a private
 * address. Closing that needs resolution-time checks against every address the
 * name returns, and pinning the connection to the one that was checked — worth
 * doing if this endpoint ever accepts untrusted signups, and dishonest to claim
 * without it.
 */
export function unsafeEndpointReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That is not a valid address. It should look like https://api.example.com/v1.";
  }

  const allowPrivate = env.CADENCE_ALLOW_PRIVATE_MODEL_ENDPOINTS === "true";

  if (url.protocol !== "https:" && !allowPrivate) {
    return "The address must start with https:// — an API key sent over http travels in the clear.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The address must be an http(s) URL.";
  }
  if (allowPrivate) return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "That address is on this machine, which is not reachable from where the assistant runs.";
  }
  if (host.endsWith(".internal")) {
    return "That address is internal to a private network and cannot be used here.";
  }
  if (isPrivateAddress(host)) {
    return "That is a private network address. Use the provider's public endpoint, or ask whoever runs this cadence deployment to allow private endpoints.";
  }
  return null;
}

function isPrivateAddress(host: string): boolean {
  // IPv6 loopback, link-local (fe80::/10) and unique-local (fc00::/7).
  if (host === "::1" || host === "::") return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;

  const [a, b] = v4.slice(1).map(Number);
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local — the metadata service lives here
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}
