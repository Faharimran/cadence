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
import { buildKnowledgeContext, type KnowledgeContext } from "@/lib/knowledge";

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
  /**
   * `cacheRead` is reported separately from `input` because the API bills them
   * differently and excludes one from the other. Without it, a turn whose whole
   * prompt came from cache looks like a turn that was never given a prompt —
   * which is exactly the wrong conclusion to draw while checking that the
   * knowledge corpus is reaching the model.
   */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new CadenceError(
      "capability_unavailable",
      "No ANTHROPIC_API_KEY configured — the conversation layer cannot run.",
    );
  }
  client ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Identity-linked keys belong to a person, not a workspace, so the API
    // rejects every request that doesn't name the workspace it acts in.
    // Workspace-scoped keys ignore the header, so sending it when set is
    // always safe.
    ...(env.ANTHROPIC_WORKSPACE_ID
      ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
      : {}),
  });
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

  const outcome = {
    escalated: false,
    escalationReasons: [] as string[],
    bookingIds: [] as string[],
    sources: [] as string[],
  };

  // Loaded even when the capability is off, so the prompt can state plainly that
  // nothing is written down. Silence there is what produces a model that fills
  // the gap from general knowledge.
  const knowledge = caps.has("knowledge")
    ? await buildKnowledgeContext(db, args.tenantId)
    : ({ mode: "empty" } as const);

  const ctx: ToolContext = { db, caps, snapshot, knowledge, outcome, ...args };
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
    system: systemPrompt(tenant, caps.list(), knowledge, snapshot),
    tools,
    messages: transcript,
    max_iterations: MAX_ITERATIONS,
  });

  // Iterate to completion. Breaking out of this loop early abandons the async
  // iterator that drives the runner, and the `done()` below then never
  // resolves — a deadlock that only appears on whichever path breaks, which
  // here was escalation.
  //
  // Stopping the agent after an escalation is therefore enforced in the TOOLS
  // (they refuse once `outcome.escalated` is set) rather than by cutting the
  // loop short. Same guarantee, no hang.
  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
    }
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
      // And which articles it was reading, at which version. Deduplicated
      // because a model that searches twice for the same thing should not make
      // the reply look doubly sourced.
      sources: [...new Set(outcome.sources)],
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
    usage: {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
      cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
//  System prompt
// ══════════════════════════════════════════════════════════════════════

/**
 * Two blocks, and the split is load-bearing.
 *
 * The first holds everything stable for this tenant — who they are, what they
 * sell, what they have written down, what they refuse to say. It is identical
 * across every turn and every customer, so it carries a cache breakpoint and is
 * read from cache rather than re-billed. The knowledge corpus is by far the
 * largest thing in a prompt, which is exactly why it must sit above the line.
 *
 * The second holds the two things that change per turn — the clock and whether
 * the snapshot is degraded. Putting either in the first block would invalidate
 * the cache on every single message.
 */
export type TenantVoice = {
  name: string;
  timezone: string;
  descriptor: string | null;
  toneNote: string | null;
  escalationTopics: string[];
};

/** Exported so scripts/proveKnowledge.ts can assert on what it actually says. */
export function systemPrompt(
  tenant: TenantVoice,
  capabilities: string[],
  knowledge: KnowledgeContext,
  snapshot: { degraded: boolean },
): Anthropic.Beta.BetaTextBlockParam[] {
  const now = formatInTimeZone(new Date(), tenant.timezone, "EEEE d MMMM yyyy, HH:mm");

  const stable = `You are the assistant for ${tenant.name}, replying to a customer over a messaging app.
${tenant.descriptor ? `\n## About ${tenant.name}\n${tenant.descriptor}\n` : ""}
## What you can do
${capabilities.map((c) => `- ${c}`).join("\n")}

Your tools are the only things you can do. If a customer asks for something no tool covers, say so plainly and offer to have a colleague help — do not improvise a way round it.

${knowledgeSection(tenant.name, knowledge)}

## Booking
Availability is advisory until it is held. Never tell a customer a time is theirs before \`hold_slot\` has succeeded — the slot can go to someone else while you are typing. Then: hold, tell them, and confirm only once they say yes.

If a hold fails, the result usually carries alternative times. Offer one in the same message rather than apologising and asking them to start again.

## What you must not do
- Never state a price the tools did not give you. If a service has no price, the team will confirm it.
- Never describe the terms of an offer in your own words, or work out what a discount comes to. Use the wording the tool returned, or say a colleague will explain.
- Never invent an availability, a policy, or a member of staff. If you do not have it, you do not know it.
- Never repeat an internal note. Anything the tools give you is safe to say; anything you inferred about why the business is closed is not.

## Handing over
Escalate whenever the customer asks for a person, is upset or complaining, negotiates on price, or when a tool fails in a way you cannot work around.${
    tenant.escalationTopics.length > 0
      ? `\n\n${tenant.name} also hands these over without exception:\n${tenant.escalationTopics.map((t) => `- ${t}`).join("\n")}`
      : ""
  }

Escalating early is always better than guessing. After escalating, say one line telling them a colleague will pick it up, and stop.

## Tone
${
    tenant.toneNote ??
    "Write like a competent receptionist texting: warm, brief, one idea per message."
  } No bullet lists, no headings, no emoji unless the customer uses them first. Quote times exactly as the tools formatted them — they are already in the right timezone for that location. Confirm the specifics back (what, when, where, who) when you book something, so the customer has it in writing.`;

  const volatile = `It is currently ${now} (${tenant.timezone}). Work out dates from that — the customer will say "tomorrow" or "next Tuesday", never an ISO timestamp. Tools need ISO-8601 instants with an offset.${
    snapshot.degraded
      ? "\n\nSome of your information could not be refreshed just now and may be out of date. Take extra care: confirm anything important through a tool rather than from memory, and if a tool fails, hand over rather than guessing."
      : ""
  }`;

  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: volatile },
  ];
}

/**
 * The one instruction that makes this safe across every vertical is the same in
 * all three branches: **do not answer from general knowledge.**
 *
 * A model knows a great deal about hair transplants, and about fades, and about
 * how long a gel manicure lasts. All of it is a liability when speaking *as* a
 * particular business, because the customer will hold that business to it. The
 * only admissible source is what this business wrote down and approved.
 */
function knowledgeSection(name: string, knowledge: KnowledgeContext): string {
  if (knowledge.mode === "empty") {
    return `## What ${name} has written down
Nothing yet.

You therefore know what is offered, how long it takes and when it can be booked — and nothing else. Any question about how something works, what to expect, how to prepare, or what a result will be like goes to a colleague. Do not answer it from general knowledge about this kind of business.`;
  }

  if (knowledge.mode === "index") {
    return `## What ${name} has written down
These are the articles that exist. This list is complete — if a subject is not on it, ${name} has not written about it.

${knowledge.rendered}

Use \`search_knowledge\` to read one before answering anything it covers. Quote it or paraphrase it closely. If a question is not covered by the list, say you'll check with a colleague — never answer from general knowledge about this kind of business.`;
  }

  return `## What ${name} has written down
This is everything, and it is your only source on how things work. Quote it or paraphrase it closely. If a question is not answered below, say you'll check with a colleague — never answer from general knowledge about this kind of business.

${knowledge.rendered}`;
}
