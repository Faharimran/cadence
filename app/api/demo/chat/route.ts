import { z } from "zod";
import { adminDb, withTenant } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { findDemoPersona } from "@/lib/demo/personas";
import {
  DEMO_COOKIE,
  clientIp,
  consumeDemoBudget,
  isValidSessionId,
  newSessionId,
  readCookie,
  sessionCookie,
} from "@/lib/demo/session";
import { openThread, recordInbound } from "@/lib/conversation/thread";
import { isAgentConfigured, runAgentTurn } from "@/lib/conversation/agent";

/**
 * The public demo endpoint.
 *
 * It runs the real agent. Not a trimmed one, not a second implementation kept
 * in step by hand — the same `runAgentTurn` the WhatsApp worker calls, against
 * a real tenant, reading live availability. The only difference between a
 * visitor here and a customer messaging a paying business is which capabilities
 * the tenant row carries, and that difference is enforced by
 * `lib/demo/personas.ts` giving these three tenants no `booking_write`, so the
 * model is never handed a tool that writes.
 *
 * Which is the point. A demo that reimplemented the agent would prove that
 * someone can write a chat UI, and the first divergence between the two would
 * appear on this page, in front of the person deciding whether to trust it.
 *
 * Unlike the WhatsApp path this replies synchronously. That path is
 * fire-and-forget because Meta retries anything slow; a browser is holding the
 * request open and there is nowhere to deliver a reply to afterwards.
 */

const Body = z.object({
  persona: z.string().min(1).max(40),
  // Long enough for a real question, short enough that the prompt cannot be
  // used as free inference. Anything past this is a payload, not a question.
  message: z.string().trim().min(1).max(500).optional(),
  /** Starts a fresh thread — a new identity, so nothing carries over. */
  reset: z.boolean().optional(),
});

/**
 * Said by cadence, never by the business.
 *
 * Once `escalate_to_human` fires, the conversation is paused and belongs to a
 * person. In production a colleague picks it up from the inbox; here there is
 * nobody, and the honest thing is to say what just happened rather than have
 * the assistant keep talking — which is precisely the behaviour being
 * demonstrated.
 */
const HANDED_OVER =
  "This thread has been handed to a person, so the assistant has stopped replying — " +
  "which is the behaviour being demonstrated. In a real deployment it would now be " +
  "sitting in the owner's inbox. Start over to keep exploring.";

export async function POST(request: Request) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  const persona = findDemoPersona(parsed.persona);
  // The persona id is an allowlist lookup, never a tenant id or a slug from the
  // caller. There is no string a visitor can send that reaches a tenant other
  // than these three.
  if (!persona) return json({ error: "Unknown demo." }, 404);

  const cookieHeader = request.headers.get("cookie");
  const existing = readCookie(cookieHeader, DEMO_COOKIE);
  const secure = env.CADENCE_BASE_URL.startsWith("https://");

  // Reset rotates the identity rather than deleting rows. The old transcript
  // stops being reachable — nothing holds a pointer to it but the cookie we
  // just replaced — and the visitor gets a genuinely fresh first contact
  // instead of a thread that remembers being reset.
  if (parsed.reset || !isValidSessionId(existing)) {
    const sessionId = newSessionId();
    if (parsed.reset) {
      return json({ ok: true, reset: true }, 200, sessionCookie(sessionId, secure));
    }
    return handle(request, persona.id, parsed.message, sessionId, secure);
  }

  return handle(request, persona.id, parsed.message, existing, secure);
}

async function handle(
  request: Request,
  personaId: string,
  message: string | undefined,
  sessionId: string,
  secure: boolean,
) {
  const cookie = sessionCookie(sessionId, secure);
  const persona = findDemoPersona(personaId)!;

  if (!message) return json({ error: "Say something first." }, 400, cookie);

  // Checked before the budget is spent: refusing for a missing key must not
  // also cost the visitor one of their turns.
  if (!isAgentConfigured()) {
    return json(
      {
        error:
          "The demo is offline — this deployment has no model key configured. Everything else on the page still works.",
      },
      503,
      cookie,
    );
  }

  const budget = await consumeDemoBudget({ sessionId, ip: clientIp(request.headers) });
  if (!budget.ok) {
    return json({ error: limitMessage(budget.scope) }, 429, cookie);
  }

  // Cross-tenant by necessity, and the only one here: there is no tenant
  // context to scope by until the slug has been resolved. Same shape as
  // resolving an API key in lib/api/auth.ts.
  const tenant = await adminDb.tenant.findUnique({
    where: { slug: persona.slug },
    select: { id: true, status: true },
  });

  if (!tenant || tenant.status !== "active") {
    logger.warn("demo: tenant missing — has seedDemoAgents run?", { slug: persona.slug });
    return json({ error: "This demo business isn't set up on this deployment." }, 503, cookie);
  }

  try {
    const result = await withTenant(
      tenant.id,
      async (db) => {
        // One thread per session PER persona, so switching tabs does not drop a
        // visitor into the middle of a conversation another business had.
        const thread = await openThread(db, {
          tenantId: tenant.id,
          channel: "demo",
          externalThreadId: `${sessionId}:${persona.id}`,
          identity: { name: "Demo visitor" },
        });

        await recordInbound(db, {
          tenantId: tenant.id,
          conversationId: thread.conversationId,
          body: message,
        });

        // Recorded first, then refused. A message that arrives after the thread
        // was handed over still belongs in the transcript — that is what the
        // colleague picking it up needs to read.
        if (thread.botPaused) return { handedOver: true as const };

        const turn = await runAgentTurn(db, {
          tenantId: tenant.id,
          conversationId: thread.conversationId,
          customerId: thread.customerId,
        });

        return {
          handedOver: false as const,
          reply: turn.reply,
          escalated: turn.escalated,
          // Tool NAMES only. What the agent did is the interesting half of the
          // demo and safe to show; the arguments and results are the tenant's
          // operational data and stay server-side.
          tools: [...new Set(turn.toolCalls.map((t) => t.name))],
        };
      },
      // A turn makes several model round-trips inside one transaction. The
      // worker allows three minutes; a browser is waiting on this one, so it is
      // cut to a length a person will actually sit through.
      { timeoutMs: 60_000 },
    );

    if (result.handedOver) {
      return json({ reply: null, note: HANDED_OVER, escalated: true, tools: [] }, 200, cookie);
    }

    return json(
      {
        reply: result.reply,
        // Sent alongside the reply, not instead of it: the agent says its own
        // closing line to the customer, and this explains what happened.
        note: result.escalated ? HANDED_OVER : null,
        escalated: result.escalated,
        tools: result.tools,
      },
      200,
      cookie,
    );
  } catch (err) {
    logger.error("demo: turn failed", {
      persona: persona.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "That didn't go through. Try again in a moment." }, 500, cookie);
  }
}

function limitMessage(scope: "session" | "ip" | "global" | "unavailable"): string {
  if (scope === "global") {
    return "The demo has hit its daily limit across all visitors — it runs on a real model key with a real bill. Try again tomorrow, or set up a business to get your own.";
  }
  if (scope === "unavailable") {
    return "The demo is briefly unavailable. Try again in a minute.";
  }
  return "That's the limit for now — the demo runs on a real model key. Set up a business if you'd like to keep going.";
}

function json(body: unknown, status: number, cookie?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Never store a demo reply anywhere between here and the browser: the
      // transcript is one visitor's, and a shared cache would hand it to the
      // next one.
      "cache-control": "no-store",
      ...(cookie ? { "set-cookie": cookie } : {}),
    },
  });
}
