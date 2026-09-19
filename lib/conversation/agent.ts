import type Anthropic from "@anthropic-ai/sdk";
import { formatInTimeZone } from "date-fns-tz";
import type { TenantDb } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { CadenceError } from "@/lib/api/errors";
import { resolveCapabilities } from "@/lib/conversation/capabilities";
import { getSnapshot, type ServiceSummary } from "@/lib/conversation/snapshot";
import { buildTools, type ToolContext } from "@/lib/conversation/tools";
import {
  loadTranscript,
  pauseBot,
  recordOutbound,
  COLLEAGUE_PREFIX,
} from "@/lib/conversation/thread";
import { buildKnowledgeContext, type KnowledgeContext } from "@/lib/knowledge";
import {
  failureResponse,
  isProviderFailure,
  recordProviderFailure,
  recordProviderOk,
  resolveProvider,
  type ResolvedProvider,
} from "@/lib/conversation/providers";
import { runTurn, type TurnResult } from "@/lib/conversation/drivers";

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

const MAX_ITERATIONS = 12;

/**
 * A reply, not an essay. Two thousand tokens is several times longer than any
 * message this assistant should be sending, so it binds only on a model that has
 * already gone wrong — which is exactly when a ceiling is worth having.
 */
const MAX_TOKENS = 2048;

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
  /**
   * How many API calls this turn took. The cost driver nobody looks at: each
   * tool call adds a round trip, and every round trip re-sends the whole prompt.
   */
  roundTrips?: number;
  /**
   * Which key answered, and as what.
   *
   * Carried out of the turn rather than looked up again by whoever records the
   * spend, because between the turn and the write a business can switch keys —
   * and re-reading the row would then bill an Anthropic turn to the DeepSeek
   * account they moved to a second later. No secret rides along; this is the
   * provider's identity, not its credential.
   */
  provider?: { source: "platform" | "tenant"; protocol: string; vendor: string; model: string };
};

/**
 * Whether enori's own key is present.
 *
 * Narrower than it looks, and deliberately so: a tenant that has brought its own
 * key answers customers whether or not this is true. It is the platform default
 * that is missing without it — the demo, and every business that never opened
 * the model settings page. Per-tenant readiness is `resolveProvider`'s job,
 * because only it knows whose key is in play.
 */
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

  // Whose key answers this message, and on which protocol.
  //
  // A business that has added its own runs on it; everyone else runs on
  // enori's, with the model and effort they chose on Settings → Agent. Effort
  // is the main cost lever on a channel that may carry thousands of messages a
  // day, so it is theirs to spend — and it is omitted entirely for models that
  // do not accept it.
  //
  // What this deliberately never does is fall back from one to the other. See
  // lib/conversation/providers.ts.
  const provider = await resolveProvider(db, args.tenantId, tenant);

  let turn: TurnResult;
  try {
    turn = await runTurn({
      protocol: provider.protocol,
      system: systemPrompt(tenant, caps.list(), knowledge, snapshot),
      messages: transcript,
      tools,
      model: provider.model,
      effort: provider.effort,
      maxIterations: MAX_ITERATIONS,
      maxTokens: MAX_TOKENS,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      source: provider.source,
      vendorLabel: provider.label,
    });
  } catch (err) {
    return await handleProviderFailure(db, args, provider, err);
  }

  // Recorded on the way past, because the only request that proves a key works
  // is a real one — and only when there is something to change, so a busy
  // tenant does not pay for an UPDATE per message saying what the last one said.
  // Clears any failure still showing on the settings page.
  if (provider.source === "tenant" && provider.shouldRecordOk) {
    await recordProviderOk(db, args.tenantId);
  }

  const { toolCalls, usage, roundTrips } = turn;
  const reply = turn.text;

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
    usage,
    roundTrips,
    provider: {
      source: provider.source,
      protocol: provider.protocol,
      vendor: provider.vendor,
      model: provider.model,
    },
  };
}

/**
 * What happens to a customer when the business's own key will not answer.
 *
 * The distinction that decides it is in `ProviderFailure`: whether waiting
 * helps.
 *
 * A rate limit or a bad gateway is transient, and the queue already retries
 * three times with backoff — the right answer is to let it. Pausing the thread
 * for one of those would be worse than the fault: a paused thread needs a person
 * to hand it back, so a thirty-second wobble at the provider would leave a
 * business with an inbox of conversations to manually resume.
 *
 * A revoked key, an empty balance or a model id that does not exist is none of
 * those. It will still be broken in three retries' time, and the customer spends
 * every one of them waiting. So the thread goes to a person NOW, the reason is
 * written where the owner will see it, and nothing invents a reply on the
 * business's behalf — the assistant has nothing approved to say about its own
 * billing arrangements.
 *
 * enori's own key never lands here: an outage on our side is ours to fix and
 * ours to be paged about, and pausing every tenant's threads over it would turn
 * a ten-minute incident into a day of manual inbox work for every customer.
 */
async function handleProviderFailure(
  db: TenantDb,
  args: { tenantId: string; conversationId: string },
  provider: ResolvedProvider,
  err: unknown,
): Promise<AgentTurn> {
  if (!isProviderFailure(err)) throw err;

  if (failureResponse(provider.source, err.kind) === "retry") {
    // Not recorded, deliberately. This throw rolls the transaction back, so a
    // row written here would never land — and writing it on the owner
    // connection to survive that would put the conversation layer outside the
    // isolation every other query in it obeys.
    logger.warn("model provider unavailable", {
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      source: provider.source,
      status: err.status,
      note: err.note,
    });
    throw err;
  }

  await recordProviderFailure(db, args.tenantId, err.note);
  await pauseBot(db, args);
  await db.auditLog.create({
    data: {
      tenantId: args.tenantId,
      actor: "system:agent",
      action: "tenant.model_provider_failed",
      subject: `Conversation:${args.conversationId}`,
      after: { note: err.note, status: err.status ?? null },
    },
  });

  logger.error("tenant model provider rejected the turn", {
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    status: err.status,
    note: err.note,
  });

  return {
    reply: null,
    escalated: true,
    escalationReasons: ["provider_unavailable"],
    bookingIds: [],
    toolCalls: [],
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
  agentInstructions: string | null;
  escalationTopics: string[];
};

/**
 * How many services can sit in the prompt before it stops being worth it.
 *
 * The trade is between one round trip and some cached tokens. A round trip
 * re-sends the ENTIRE prompt and bills a fresh completion; cached tokens cost a
 * tenth of the input rate to re-read. So for a catalogue of any ordinary size,
 * putting it in the prompt is both cheaper and a reply that arrives seconds
 * sooner — `list_services` did no I/O at all, it read a snapshot already in
 * memory, and the model was spending a whole API call to look at data the
 * server was already holding.
 *
 * Past this many, the arithmetic turns over: the catalogue is re-read on every
 * round trip whether the customer asked about it or not, and the tool becomes
 * the cheaper way round.
 */
const CATALOGUE_INLINE_LIMIT = 60;

/**
 * The catalogue, written out rather than fetched.
 *
 * Prices are used exactly as the snapshot rendered them — already formatted in
 * the tenant's currency — because a model that is handed a number and a currency
 * code will eventually format one itself, and get it wrong for somebody.
 */
function catalogueSection(services: ServiceSummary[] | undefined): string {
  if (!services || services.length === 0 || services.length > CATALOGUE_INLINE_LIMIT) return "";

  const byCategory = new Map<string, ServiceSummary[]>();
  for (const s of services) {
    const key = s.category ?? "";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(s);
  }

  const line = (s: ServiceSummary) => {
    const bits = [`${s.durationMinutes} min`];
    if (s.quotable && s.price) bits.push(s.price);
    else bits.push("price on request");
    return `- ${s.name} — ${bits.join(", ")}  [id: ${s.id}]`;
  };

  const body = [...byCategory.entries()]
    .map(([category, items]) =>
      category ? `\n**${category}**\n${items.map(line).join("\n")}` : items.map(line).join("\n"),
    )
    .join("\n");

  return `
## What is offered
${body}

These are the prices. Quote them as written — do not convert, round, or add anything to them. A service marked "price on request" has no price you may state; say a colleague will confirm it. Use the id when calling a tool that needs one.
`;
}

/** Exported so scripts/proveKnowledge.ts can assert on what it actually says. */
export function systemPrompt(
  tenant: TenantVoice,
  capabilities: string[],
  knowledge: KnowledgeContext,
  snapshot: { degraded: boolean; services?: { data: ServiceSummary[] } },
): Anthropic.Beta.BetaTextBlockParam[] {
  const now = formatInTimeZone(new Date(), tenant.timezone, "EEEE d MMMM yyyy, HH:mm");

  // Whether the catalogue is in the prompt decides what the guidance below can
  // truthfully say. Telling the model to fetch a price list it is already
  // looking at costs a round trip AND makes the reply slower for nothing.
  const catalogue = catalogueSection(snapshot.services?.data);
  const hasInlineCatalogue = catalogue !== "";

  const stable = `You are the assistant for ${tenant.name}, replying to a customer over a messaging app.
${tenant.descriptor ? `\n## About ${tenant.name}\n${tenant.descriptor}\n` : ""}
## What you can do
${capabilities.map((c) => `- ${c}`).join("\n")}

Your tools are the only things you can do. If a customer asks for something no tool covers, say so plainly and offer to have a colleague help — do not improvise a way round it.
${catalogue}${
    tenant.agentInstructions?.trim()
      ? `\n## What ${tenant.name} has told you to do\nThese are the owner's own instructions. Follow them.\n\n${tenant.agentInstructions.trim()}\n`
      : ""
  }
${knowledgeSection(tenant.name, knowledge)}

## Booking
Availability is advisory until it is held. Never tell a customer a time is theirs before \`hold_slot\` has succeeded — the slot can go to someone else while you are typing. Then: hold, tell them, and confirm only once they say yes.

Once you hold a time it is yours until the hold expires. When they say yes to it, call \`confirm_booking\` with the hold you are already holding. Do not check availability again first — you are holding that slot, so it reads as taken, and telling someone a time has gone when you are the one holding it is the worst thing you can do to them.

Never say a time has gone unless a tool told you so on this turn.

If a hold fails, the result usually carries alternative times. Offer one in the same message rather than apologising and asking them to start again.

## Cancelling
Cancel only what they have actually asked you to cancel. "I might not make it", "I may need to move this" and "what happens if I cancel?" are all questions, not instructions — answer them.

Before you call \`cancel_booking\`, name the appointment you are about to cancel in words they can check — the day, the time and what it is for. If they have more than one booked and have not said which, ask. If what they describe is not on their list at all, do not go looking: say you cannot see it and hand over.

You can only cancel their own bookings. An id from anywhere else fails, and that is deliberate.

Once it goes through, say so plainly and tell them the time is now free for someone else — it is, immediately. Then stop. If they have said something that sounds like they still want to come — a clash, a change of plan — offer to find another time; do not assume it of somebody who has just cancelled.

## What you must not do
- Never state a price the tools did not give you. If a service has no price, the team will confirm it.
- Never describe the terms of an offer in your own words, or work out what a discount comes to. Use the wording the tool returned, or say a colleague will explain.
- Never invent an availability, a policy, or a member of staff. If you do not have it, you do not know it.
- Never repeat an internal note. Anything the tools give you is safe to say; anything you inferred about why the business is closed is not.

## When a colleague has been in the thread
A turn beginning "${COLLEAGUE_PREFIX.trim()}" was written by a member of staff, not by you. Treat what they said as a commitment the business has already made: never contradict it, and never repeat it back as though it were your own offer.

You are reading this because the thread is yours again — a colleague who still had it would have you paused, and you would not be answering at all. So carry on and help normally. Do NOT keep telling the customer that a colleague is handling it; they messaged you, and being passed back and forth is worse than either of you simply answering. Only hand over if the reason to do so is in front of you now: they ask for a person, or the question is on the list above.

## Handing over
Escalate whenever the customer asks for a person, is upset or complaining, negotiates on price, or when a tool fails in a way you cannot work around.${
    tenant.escalationTopics.length > 0
      ? `\n\n${tenant.name} also hands these over without exception:\n${tenant.escalationTopics.map((t) => `- ${t}`).join("\n")}`
      : ""
  }

Escalating early is always better than guessing. After escalating, say one line telling them a colleague will pick it up, and stop.

## Look before you say you don't know
Most questions already have an answer in front of you or one tool call away:

${
    hasInlineCatalogue
      ? `- what is offered, how long, what it costs → listed above, answer directly`
      : `- what is offered, how long, what it costs → \`list_services\``
  }
- when someone could come in → \`check_availability\`
- what they already have booked → \`list_my_bookings\`
- how anything works, what to expect, what to bring → what is written down above

"I'm not sure" is only true once you have looked and found nothing. A broad question — "what do you do?", "what are my options?" — wants the answer, not a request to narrow it down first.

## Tone
${tenant.toneNote ?? "Write like a competent receptionist texting: warm and brief."}

You are typing on WhatsApp, not writing an email. Specifically:

- **Two sentences is usually plenty.** If a reply runs past four, you are explaining rather than answering.
- **Offer two or three choices, never a catalogue.** Given six free slots, say "Saturday's fairly open — 10 or 10:30 suit you?" Reading out every time is what a search result does, not a person.
- **Never talk about your own messages.** No "I should correct myself", no "as I mentioned", no "I described that earlier". Whatever you said before, you said; revisiting it makes a customer doubt all of it. If something genuinely changed, just say the new thing.
- **Answer from what is written down; do not recite it.** An article is the business's reference, not a script. Someone asking what a visit involves wants "about half an hour, the doctor takes a look and talks through the options — it's ₹2,000", not every sentence the article contains. Give them the part they asked about and keep the rest in reserve for if they ask.
- **Answer, then stop.** Most messages should simply end. Ask something back only when you actually need it to go on — a time, a branch, a yes. A question on the end of every message reads as pushy, and after two or three it reads as a script.
- No bullet lists, no headings, no emoji unless they use them first.

Use the times the tools give you — they are already correct for that location. You may write them the way people say them out loud rather than exactly as formatted, but never change the actual time.

When you book something, confirm what, when, where and who in one line, so they have it in writing.`;

  const volatile = `It is currently ${now} (${tenant.timezone}). Work out dates from that — the customer will say "tomorrow" or "next Tuesday", never an ISO timestamp. Tools need ISO-8601 instants with an offset.${
    snapshot.degraded
      ? "\n\nSome of your information could not be refreshed just now and may be out of date. Take extra care: confirm anything important through a tool rather than from memory, and if a tool fails, hand over rather than guessing."
      : ""
  }`;

  return [
    // An hour, not the default five minutes, and the difference is most of the
    // input bill.
    //
    // Five minutes is shorter than a conversation. Somebody asks a question,
    // reads the reply, talks to their partner, and answers eight minutes later
    // — by which time the cache has expired and this entire block, which is
    // nearly the whole prompt, is written again at 1.25× the input rate. A
    // six-message conversation could pay for three or four writes.
    //
    // A one-hour entry costs 2× to write instead of 1.25×, and is written once.
    // That is cheaper from the second write onwards, and every real WhatsApp
    // conversation has a second write.
    { type: "text", text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
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
