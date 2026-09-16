import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { ProviderFailure, classifyFailure } from "@/lib/conversation/providers";
import {
  emptyUsage,
  type PingRequest,
  type PingResult,
  type TurnRequest,
  type TurnResult,
} from "./types";

/**
 * The Messages API, via the official SDK.
 *
 * This is the path cadence's own key takes and the one a business takes when it
 * brings an Anthropic key of its own. It keeps two things the generic protocol
 * cannot offer: the SDK's tool runner, which drives the loop, and prompt
 * caching, which is most of the input bill on a prompt this size.
 */

/**
 * The platform client is cached; a tenant's is not.
 *
 * Caching per tenant would mean holding every customer's API key in a process
 * map for the life of the worker, and reusing a stale one after they rotate it.
 * Constructing a client is a few object allocations against a turn that is about
 * to make several network round trips — not a cost worth that.
 */
let platformClient: Anthropic | null = null;

function clientFor(req: {
  apiKey: string;
  baseUrl: string | null;
  source: "cadence" | "tenant";
}): Anthropic {
  if (req.source === "cadence") {
    platformClient ??= new Anthropic({
      apiKey: req.apiKey,
      // Identity-linked keys belong to a person, not a workspace, so the API
      // rejects every request that doesn't name the workspace it acts in.
      // Workspace-scoped keys ignore the header, so sending it when set is
      // always safe.
      //
      // Never sent with a tenant's key: it names OUR workspace, and on their
      // account it is at best meaningless and at worst a 400 on every message.
      ...(env.ANTHROPIC_WORKSPACE_ID
        ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }
        : {}),
    });
    return platformClient;
  }

  return new Anthropic({
    apiKey: req.apiKey,
    ...(req.baseUrl ? { baseURL: req.baseUrl } : {}),
  });
}

export async function runAnthropicTurn(req: TurnRequest): Promise<TurnResult> {
  const runner = clientFor(req).beta.messages.toolRunner({
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    system: req.system,
    tools: req.tools,
    messages: req.messages,
    max_iterations: req.maxIterations,
  });

  const toolCalls: { name: string; input: unknown }[] = [];
  const usage = emptyUsage();
  let roundTrips = 0;

  const addUsage = (u: Anthropic.Beta.BetaUsage | undefined) => {
    if (!u) return;
    roundTrips++;
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  };

  try {
    // Iterate to completion. Breaking out of this loop early abandons the async
    // iterator that drives the runner, and the `done()` below then never
    // resolves — a deadlock that only appears on whichever path breaks, which
    // here was escalation.
    //
    // Stopping the agent after an escalation is therefore enforced in the TOOLS
    // (they refuse once `outcome.escalated` is set) rather than by cutting the
    // loop short. Same guarantee, no hang.
    //
    // Usage is accumulated across the WHOLE loop, not taken from the final
    // message. A turn that calls three tools is four API calls, each re-sending
    // the entire prompt, and each billed. Reading usage off the last one
    // reported a quarter of what the turn actually cost — the wrong direction to
    // be wrong in when the number decides whether the product is affordable.
    for await (const message of runner) {
      addUsage(message.usage);
      for (const block of message.content) {
        if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
      }
    }

    const final = await runner.done();
    // `done()` resolves to the last message the loop already yielded, so counting
    // it again would inflate every turn by one round trip.
    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join("\n\n");

    return { text, toolCalls, usage, roundTrips };
  } catch (err) {
    throw asProviderFailure(err, req.vendorLabel);
  }
}

/**
 * A minimal request that answers both questions a setup has: does this key work,
 * and will this model call a tool.
 */
export async function pingAnthropic(req: PingRequest): Promise<PingResult> {
  const client = clientFor({ apiKey: req.apiKey, baseUrl: req.baseUrl, source: "tenant" });

  try {
    const message = await client.messages.create({
      model: req.model,
      max_tokens: 64,
      tools: [
        {
          name: "confirm_setup",
          description: "Confirm the connection is working. Call this and nothing else.",
          input_schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: "Call the confirm_setup tool with ok set to true. Do not reply with text.",
        },
      ],
    });

    return {
      toolsWork: message.content.some((b) => b.type === "tool_use"),
      sample: message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text.trim())
        .join(" ")
        .slice(0, 200),
    };
  } catch (err) {
    throw asProviderFailure(err, req.vendorLabel);
  }
}

/**
 * The SDK's typed errors, turned into the one distinction the caller acts on:
 * whether waiting helps.
 */
function asProviderFailure(err: unknown, vendorLabel: string): unknown {
  if (err instanceof ProviderFailure) return err;

  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const body = JSON.stringify(err.error ?? { message: err.message });
    return classifyFailure(err.status, body, vendorLabel);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderFailure(
      "transient",
      `Could not reach ${vendorLabel} just now. Replies will catch up on their own.`,
    );
  }
  // Not a transport failure — a bug in our own loop, or a tool that threw past
  // its own handler. Left alone so it surfaces as the fault it is rather than
  // being blamed on the provider.
  return err;
}
