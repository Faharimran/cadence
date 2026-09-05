import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";

/**
 * WhatsApp Business Cloud API adapter — transport only.
 *
 * Nothing in this file knows about scheduling, tenants' business rules, or the
 * agent. It turns Meta's payloads into a neutral shape and sends text back out.
 * Everything else lives above it, so adding SMS or a web widget means writing a
 * sibling of this file and nothing else.
 */

const GRAPH_VERSION = "v21.0";

export type InboundMessage = {
  /** Meta's id for the business number that received this — routes to a tenant. */
  phoneNumberId: string;
  /** The customer's number, in E.164 without a leading +. */
  from: string;
  profileName?: string;
  messageId: string;
  timestamp: Date;
  /** Plain text of the message. Non-text messages are described, not dropped. */
  text: string;
  kind: "text" | "interactive" | "media" | "unsupported";
};

export type DeliveryStatus = {
  messageId: string;
  status: string; // sent | delivered | read | failed
};

/**
 * Verifies Meta's `X-Hub-Signature-256` over the RAW request body.
 *
 * This must run on the exact bytes received. Re-serialising the parsed JSON
 * changes key order and whitespace, and the MAC then never matches — the most
 * common way this check gets quietly disabled.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The one-time subscription handshake Meta performs when you save a webhook URL. */
export function verifyChallenge(
  params: URLSearchParams,
  expectedToken: string,
): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== expectedToken) return null;
  return params.get("hub.challenge");
}

/** One message as Meta sends it. Every field optional — trust nothing inbound. */
type MetaMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
};

type MetaPayload = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: MetaMessage[];
        statuses?: { id?: string; status?: string }[];
      };
    }[];
  }[];
};

/**
 * Flattens Meta's deeply nested envelope into messages and delivery receipts.
 *
 * One webhook POST can carry several entries, several changes, and several
 * messages — batching is normal, not exceptional, so this always returns arrays.
 */
export function parseInbound(payload: unknown): {
  messages: InboundMessage[];
  statuses: DeliveryStatus[];
} {
  const messages: InboundMessage[] = [];
  const statuses: DeliveryStatus[] = [];
  const body = payload as MetaPayload;

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const profileName = value?.contacts?.[0]?.profile?.name;

      for (const m of value?.messages ?? []) {
        if (!m.id || !m.from) continue;

        const { text, kind } = extractText(m);
        messages.push({
          phoneNumberId,
          from: m.from,
          profileName,
          messageId: m.id,
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          text,
          kind,
        });
      }

      for (const s of value?.statuses ?? []) {
        if (s.id && s.status) statuses.push({ messageId: s.id, status: s.status });
      }
    }
  }

  return { messages, statuses };
}

function extractText(m: MetaMessage): { text: string; kind: InboundMessage["kind"] } {
  if (m.type === "text" && m.text?.body) return { text: m.text.body, kind: "text" };

  const interactive = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
  if (interactive) return { text: interactive, kind: "interactive" };

  // An unsupported type is DESCRIBED rather than dropped. A customer who sends a
  // photo and gets silence assumes the business ignored them; the agent should
  // at least be able to say it can't open images and offer a human.
  const described: Record<string, string> = {
    image: "[the customer sent an image]",
    audio: "[the customer sent a voice note]",
    video: "[the customer sent a video]",
    document: "[the customer sent a document]",
    location: "[the customer shared a location]",
    sticker: "[the customer sent a sticker]",
  };
  return {
    text: described[m.type ?? ""] ?? "[the customer sent an unsupported message]",
    kind: m.type && m.type in described ? "media" : "unsupported",
  };
}

/**
 * Sends a free-form text message.
 *
 * Only valid inside the 24-hour customer-service window. Outside it Meta rejects
 * anything but an approved template — the caller is responsible for knowing
 * which side of that line it is on, because the failure is a 400 rather than
 * something we can detect beforehand.
 */
export async function sendText(args: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}): Promise<
  { ok: true; messageId: string } | { ok: false; error: string; reason: string }
> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${args.phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "text",
        text: { preview_url: false, body: args.body },
      }),
    });

    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number };
    };

    if (!res.ok) {
      const error = json.error?.message ?? `HTTP ${res.status}`;
      const reason = explainSendFailure(json.error?.code, res.status);
      // Logged with the code, because "Authentication Error" alone does not say
      // whether the token expired, the number is wrong, or we are outside the
      // 24-hour window — three different problems with three different fixes.
      logger.error("whatsapp send failed", {
        error,
        code: json.error?.code,
        to: args.to,
      });
      return { ok: false, error, reason };
    }

    return { ok: true, messageId: json.messages?.[0]?.id ?? "" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("whatsapp send threw", { error });
    return { ok: false, error, reason: "We could not reach WhatsApp at all." };
  }
}

/**
 * When this token dies, if Meta will say.
 *
 * The whole failure mode is that expiry is invisible until messages stop, so
 * being able to say "this one runs out in three hours" the day before is worth
 * more than any amount of documentation about it.
 *
 * Meta's `debug_token` normally wants an app token; passing the token as its own
 * inspector works for the tokens that matter here and simply fails for the rest,
 * so this returns null rather than throwing and the caller says nothing. A
 * diagnostic that breaks the page it is diagnosing is worse than no diagnostic.
 *
 * `expires_at: 0` means never, which is exactly what a System User token is for.
 */
export async function describeTokenLifetime(
  token: string,
): Promise<{ neverExpires: boolean; hoursLeft: number | null } | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token` +
        `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) return null;

    const body = (await res.json()) as { data?: { expires_at?: number; is_valid?: boolean } };
    const expiresAt = body.data?.expires_at;
    if (expiresAt === undefined) return null;
    if (expiresAt === 0) return { neverExpires: true, hoursLeft: null };

    const hoursLeft = Math.round((expiresAt * 1000 - Date.now()) / 3_600_000);
    return { neverExpires: false, hoursLeft };
  } catch {
    return null;
  }
}

/**
 * Meta's error code, said the way an owner needs to hear it.
 *
 * This is shown next to a message a customer never received, so it has to say
 * what to DO. "OAuthException" is not that. The three that actually occur:
 *
 *   190  the access token expired — routine on a test app, whose tokens last a
 *        day, and the single most common reason replies stop arriving
 *   100  the phone number id is wrong, usually because the WhatsApp Business
 *        Account id beside it on the same Meta screen was pasted instead
 *   131047  outside the 24-hour window, which is Meta policy rather than a fault
 */
export function explainSendFailure(code: number | undefined, status: number): string {
  if (code === 190 || status === 401)
    return "WhatsApp rejected our access token — it has expired or been revoked. Nothing will send until a new one is saved in Settings → WhatsApp.";
  if (code === 100)
    return "WhatsApp does not recognise the phone number ID saved in Settings → WhatsApp.";
  if (code === 131047)
    return "More than 24 hours have passed since this customer last messaged you, and WhatsApp only allows free-form replies inside that window. They will receive your reply if they message again.";
  if (code === 131026)
    return "WhatsApp could not deliver to this number — it may not be a WhatsApp account.";
  if (code === 130429 || status === 429)
    return "WhatsApp is rate-limiting us. This usually clears on its own.";
  return "WhatsApp refused to send this message.";
}

/** WhatsApp's hard limit on a text body. Longer messages are rejected outright. */
export const MAX_BODY_LENGTH = 4096;

/**
 * Splits an over-long reply on paragraph then sentence boundaries.
 *
 * The agent is told to be brief, so this should rarely fire — but a truncated
 * booking confirmation is a support ticket, and silently dropping the end of a
 * message is worse than sending two.
 */
export function splitForDelivery(body: string, limit = MAX_BODY_LENGTH): string[] {
  if (body.length <= limit) return [body];

  const parts: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut =
      Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". ")) > limit * 0.5
        ? Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". ")) + 1
        : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
