import Anthropic from "@anthropic-ai/sdk";
import { formatInTimeZone } from "date-fns-tz";
import type { TenantDb } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { CadenceError } from "@/lib/api/errors";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { getSnapshot } from "@/lib/conversation/snapshot";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import { loadTranscript, recordOutbound } from "@/lib/conversation/thread";

/**
 * The agent loop.
 *
 * Thin on purpose. Almost everything that decides whether this behaves well
 * lives elsewhere: which tools exist (capabilities), what they will and will not
 * do (tools.ts), and what data is even in context (snapshot.ts). A model cannot
 * quote a price that was never loaded, and cannot book through a capability
 * whose tool was never passed.
 *
 * The remaining job here is a truthful system prompt and a bounded loop.
 */

const MODEL = "claude-opus-5";
const MAX_ITERATIONS = 12;

export type AgentTurn = {
  reply: string | null;
  escalated: boolean;
  escalationReasons: string[];
  bookingIds: string[];
  toolCalls: { name: string; input: unknown }[];
  usage?: { input: number; output: number };
};

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new CadenceError(
      "capability_unavailable",
      "No ANTHROPIC_API_KEY configured — the conversation layer cannot run.",
    );
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export function isAgentConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Runs one turn: reads the thread, assembles the toolset for this tenant, lets
 * the model work, and records what it said.
 *
 * Assumes the caller has already recorded the inbound message and checked
 * `botPaused` — a paused thread must never reach here, or the bot talks over
 * the colleague who took it.
 */
export async function runAgentTurn(
  db: TenantDb,
  args: { tenantId: string; conversationId: string; customerId: string },
): Promise<AgentTurn> {
  const tenant = await db.tenant.findFirstOrThrow({ where: { id: args.tenantId } });
  const caps = await resolveCapabilities(db, args.tenantId);
  const snapshot = await getSnapshot(db, caps, args);

  if (snapshot.customer?.data.optedOut) {
    // Checked before a single token is generated. An opted-out customer must not
    // receive a reply even if every other signal says to send one.
    return { reply: null, escalated: false, escalationReasons: [], bookingIds: [], toolCalls: [] };
  }

  const outcome = { escalated: false, escalationReasons: [] as string[], bookingIds: [] as string[] };
  const ctx: ToolContext = { db, caps, snapshot, outcome, ...args };
  const tools = buildTools(ctx);

  const transcript = await loadTranscript(db, args);
  if (transcript.length === 0) {
    throw new CadenceError("validation_failed", "Nothing to reply to.");
  }

  const toolCalls: { name: string; input: unknown }[] = [];

  const runner = anthropic().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 2048,
    // `medium` rather than `high`: these are short conversational turns, and
    // effort is the main cost lever on a channel that may carry thousands of
    // messages a day. Raise it if booking flows start needing more steps.
    output_config: { effort: "medium" },
    system: systemPrompt(tenant, caps.list(), snapshot),
    tools,
    messages: transcript,
    max_iterations: MAX_ITERATIONS,
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
    }
    // Escalation ends the agent's involvement. Without this the model can keep
    // working a thread a human has already been handed.
    if (outcome.escalated) break;
  }

  const final = await runner.done();
  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");

  if (reply) {
    await recordOutbound(db, {
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      body: reply,
      author: "agent",
      toolTrace: toolCalls,
      // Which snapshot this reply was based on. Three weeks later, when a
      // customer says "your bot told me 3pm was free", this is how you tell a
      // stale read from a model error.
      snapshotAt: snapshot.customer ? new Date(snapshot.customer.fetchedAt) : null,
    });
  } else {
    logger.warn("agent produced no text", { conversationId: args.conversationId });
  }

  return {
    reply: reply || null,
    escalated: outcome.escalated,
    escalationReasons: outcome.escalationReasons,
    bookingIds: outcome.bookingIds,
    toolCalls,
    usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
  };
}

// ══════════════════════════════════════════════════════════════════════
//  System prompt
// ══════════════════════════════════════════════════════════════════════

function systemPrompt(
  tenant: { name: string; timezone: string },
  capabilities: string[],
  snapshot: { degraded: boolean },
): string {
  const now = formatInTimeZone(new Date(), tenant.timezone, "EEEE d MMMM yyyy, HH:mm");

  return `You are the assistant for ${tenant.name}, replying to a customer over a messaging app.

It is currently ${now} (${tenant.timezone}). Work out dates from that — the customer will say "tomorrow" or "next Tuesday", never an ISO timestamp. Tools need ISO-8601 instants with an offset.

## What you can do
${capabilities.map((c) => `- ${c}`).join("\n")}

Your tools are the only things you can do. If a customer asks for something no tool covers, say so plainly and offer to have a colleague help — do not improvise a way round it.

## Booking
Availability is advisory until it is held. Never tell a customer a time is theirs before \`hold_slot\` has succeeded — the slot can go to someone else while you are typing. Then: hold, tell them, and confirm only once they say yes.

If a hold fails, the result usually carries alternative times. Offer one in the same message rather than apologising and asking them to start again.

## What you must not do
- Never state a price the tools did not give you. If a service has no price, the team will confirm it.
- Never describe the terms of an offer in your own words, or work out what a discount comes to. Use the wording the tool returned, or say a colleague will explain.
- Never invent an availability, a policy, or a member of staff. If you do not have it, you do not know it.
- Never repeat an internal note. Anything the tools give you is safe to say; anything you inferred about why the business is closed is not.

## Handing over
Escalate whenever the customer asks for a person, is upset or complaining, negotiates on price, asks something clinical, legal or contractual, or when a tool fails in a way you cannot work around. Escalating early is always better than guessing. After escalating, say one line telling them a colleague will pick it up, and stop.

## Tone
Write like a competent receptionist texting: warm, brief, one idea per message. No bullet lists, no headings, no emoji unless the customer uses them first. Quote times exactly as the tools formatted them — they are already in the right timezone for that location. Confirm the specifics back (what, when, where, who) when you book something, so the customer has it in writing.${
    snapshot.degraded
      ? "\n\nSome of your information could not be refreshed just now and may be out of date. Take extra care: confirm anything important through a tool rather than from memory, and if a tool fails, hand over rather than guessing."
      : ""
  }`;
}
