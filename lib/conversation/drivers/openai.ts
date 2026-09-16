import { logger } from "@/lib/logger";
import {
  ProviderFailure,
  chatCompletionsUrl,
  classifyFailure,
  unsafeEndpointReason,
} from "@/lib/conversation/providers";
import {
  emptyUsage,
  type PingRequest,
  type PingResult,
  type ToolShape,
  type TurnRequest,
  type TurnResult,
} from "./types";

/**
 * Chat-completions: the protocol everyone else speaks.
 *
 * DeepSeek, OpenAI, Groq, Mistral, OpenRouter, Fireworks, Together, and every
 * model a business runs itself behind vLLM, Ollama or LiteLLM answer this exact
 * shape. One driver reaches all of them, which is the reason "which vendor" is a
 * row in a list rather than a file in this directory.
 *
 * The loop is written out here rather than borrowed from a second SDK. It is
 * forty lines, it is the part that has to agree exactly with what the Anthropic
 * driver does, and a dependency whose loop we cannot read is a dependency we
 * cannot hold to that.
 *
 * Two things are deliberately absent, because this protocol has no portable way
 * to express them: prompt caching breakpoints (most vendors here cache
 * automatically or not at all — neither is ours to control) and thinking effort.
 * A tenant on their own key is paying their own bill, which is the trade they
 * made when they brought it.
 */

const REQUEST_TIMEOUT_MS = 90_000;

type ToolCall = { id: string; type?: string; function: { name: string; arguments: string } };

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI's name for a cache hit. */
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek's name for the same thing. */
    prompt_cache_hit_tokens?: number;
  };
  /** Some gateways report failure in a 200 body rather than a status. */
  error?: { message?: string; code?: string | number } | string;
};

export type Fetcher = typeof globalThis.fetch;

/**
 * The request, built separately so it can be asserted on without a network.
 *
 * `scripts/proveModelProviders.ts` checks the translation here — that the system
 * blocks are flattened, that no `cache_control` leaks into a protocol that would
 * reject it, and that every tool arrives with a JSON Schema — because a mistake
 * in this function is invisible until a customer's message goes unanswered.
 */
export function buildChatRequest(req: {
  system: { text: string }[];
  messages: { role: "user" | "assistant"; content: string }[];
  tools: { name: string; description?: string; input_schema: Record<string, unknown> }[];
  model: string;
  maxTokens: number;
  baseUrl: string | null;
  apiKey: string;
  vendorLabel: string;
}): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (!req.baseUrl) {
    throw new ProviderFailure(
      "credential",
      `No address saved for ${req.vendorLabel}, so there is nowhere to send the request.`,
    );
  }

  const url = chatCompletionsUrl(req.baseUrl);

  // Checked again here, not only when it was saved. The settings form is the
  // first gate; this is the one that holds if a row is ever written by anything
  // else, and it costs a URL parse against a request about to cross a network.
  const unsafe = unsafeEndpointReason(url);
  if (unsafe) throw new ProviderFailure("credential", unsafe);

  return {
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: {
      model: req.model,
      // The prompt's two blocks become one system message. The split exists to
      // carry a cache breakpoint, which this protocol has no field for — so it
      // is flattened here rather than sent as something no vendor would read.
      messages: [
        { role: "system", content: req.system.map((b) => b.text).join("\n\n") },
        ...req.messages,
      ] satisfies ChatMessage[],
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description ?? "",
                parameters: stripSchemaDialect(t.input_schema),
              },
            })),
            tool_choice: "auto",
          }
        : {}),
      max_tokens: req.maxTokens,
      // Explicit, because some gateways stream by default and a streamed body
      // parsed as JSON fails in a way that reads like a broken key.
      stream: false,
    },
  };
}

/**
 * `$schema` is correct JSON Schema and several providers reject it outright.
 * Dropped here rather than at the tool definition, which has no business knowing
 * which protocol will read it.
 */
function stripSchemaDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...rest } = schema;
  void $schema;
  return rest;
}

export async function runOpenAiTurn(req: TurnRequest, fetcher: Fetcher = fetch): Promise<TurnResult> {
  const tools = req.tools as unknown as ToolShape[];
  const { url, headers, body } = buildChatRequest({ ...req, tools });

  const messages = body.messages as ChatMessage[];
  const toolCalls: { name: string; input: unknown }[] = [];
  const usage = emptyUsage();
  let roundTrips = 0;
  let text = "";

  for (let iteration = 0; iteration < req.maxIterations; iteration++) {
    const data = await post(fetcher, url, headers, { ...body, messages }, req.vendorLabel);
    roundTrips++;

    if (data.usage) {
      usage.input += data.usage.prompt_tokens ?? 0;
      usage.output += data.usage.completion_tokens ?? 0;
      usage.cacheRead +=
        data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0;
      // No cacheWrite: on this protocol caching is the vendor's business, and
      // reporting a number we did not ask for would be inventing one.
    }

    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new ProviderFailure(
        "transient",
        `${req.vendorLabel} returned an empty response. This is usually theirs and usually brief.`,
      );
    }

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      // The turn is over. Only the final message's text becomes the reply —
      // anything said alongside a tool call is the model narrating itself
      // ("let me check that for you"), which the Anthropic path also drops.
      text = (message.content ?? "").trim();
      return { text, toolCalls, usage, roundTrips };
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });

    // Sequentially, deliberately. These tools run inside one database
    // transaction, and they mutate shared turn state — an escalation has to be
    // visible to the tool that runs after it, or the agent keeps booking on a
    // thread it has already handed to a colleague.
    for (const call of calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runTool(tools, call, toolCalls),
      });
    }
  }

  // Out of iterations with the model still asking for tools. The Anthropic
  // runner stops the same way; returning what we have beats hanging.
  logger.warn("openai driver hit the iteration ceiling", {
    model: req.model,
    iterations: req.maxIterations,
  });
  return { text, toolCalls, usage, roundTrips };
}

/**
 * Runs one tool call and produces what goes back to the model.
 *
 * Every failure is answered rather than thrown. A tool that throws past this
 * point ends the turn and leaves the customer with silence; a tool that returns
 * an error string lets the model apologise, try something else, or hand over —
 * which is exactly the behaviour the tools were written for.
 */
async function runTool(
  tools: ToolShape[],
  call: ToolCall,
  trace: { name: string; input: unknown }[],
): Promise<string> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) {
    // A hallucinated tool name. Telling the model plainly is what stops it
    // trying the same invented name three more times.
    return JSON.stringify({
      ok: false,
      reason: "unknown_tool",
      message: `There is no tool called '${call.function.name}'.`,
      recoverable: true,
    });
  }

  let input: unknown;
  try {
    // Providers differ on what a no-argument call looks like: "", "{}", or the
    // field missing altogether.
    const raw = call.function.arguments?.trim() || "{}";
    input = tool.parse(JSON.parse(raw));
  } catch (err) {
    return JSON.stringify({
      ok: false,
      reason: "validation_failed",
      message: `Those arguments were not valid: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: true,
    });
  }

  trace.push({ name: tool.name, input });

  try {
    const result = await tool.run(input as never);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    // The tools serialise their own failures; reaching here means one threw
    // rather than returning, which is a bug in the tool, not in the model.
    logger.error("tool threw during an openai turn", {
      tool: tool.name,
      err: err instanceof Error ? err.message : String(err),
    });
    return JSON.stringify({
      ok: false,
      reason: "internal",
      message: "That didn't work. Offer to have a colleague follow up.",
      recoverable: false,
    });
  }
}

async function post(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  vendorLabel: string,
): Promise<ChatResponse> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // DNS failure, refused connection, TLS mismatch, our own timeout. All of
    // them mean "not reachable now", none of them mean the key is wrong.
    throw new ProviderFailure(
      "transient",
      `Could not reach ${vendorLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    // OpenAI's own endpoint retired `max_tokens` for its newer models in favour
    // of `max_completion_tokens`, and says so in a 400. Every other vendor on
    // this protocol still takes `max_tokens`. Rather than keep a table of which
    // is which — a table that is wrong the week after it ships — send the
    // portable field and take the correction when it comes.
    if (response.status === 400 && /max_completion_tokens/.test(text) && "max_tokens" in body) {
      const { max_tokens, ...rest } = body;
      return post(fetcher, url, headers, { ...rest, max_completion_tokens: max_tokens }, vendorLabel);
    }

    throw classifyFailure(response.status, text, vendorLabel);
  }

  const data = (await response.json().catch(() => null)) as ChatResponse | null;
  if (!data) {
    throw new ProviderFailure(
      "transient",
      `${vendorLabel} returned something that was not JSON. If this persists, check the address.`,
    );
  }

  // A 200 carrying an error is how several gateways report an upstream refusal.
  // Treated as credential-class: it is nearly always a model id the account
  // cannot use, which does not fix itself.
  if (data.error) {
    const message = typeof data.error === "string" ? data.error : data.error.message;
    throw classifyFailure(400, JSON.stringify({ error: { message } }), vendorLabel);
  }

  return data;
}

/**
 * Proves the key works and — separately — that the model calls tools.
 *
 * The second half is the one that matters. Plenty of endpoints on this protocol
 * authenticate perfectly and ignore `tools` entirely, and a business that
 * discovers that through a customer who could not book has been failed by this
 * page, not by their provider.
 */
export async function pingOpenAi(req: PingRequest, fetcher: Fetcher = fetch): Promise<PingResult> {
  const { url, headers, body } = buildChatRequest({
    system: [{ text: "You are being checked. Follow the instruction exactly." }],
    messages: [
      {
        role: "user",
        content: "Call the confirm_setup tool with ok set to true. Do not reply with text.",
      },
    ],
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
    model: req.model,
    maxTokens: 64,
    baseUrl: req.baseUrl,
    apiKey: req.apiKey,
    vendorLabel: req.vendorLabel,
  });

  const data = await post(fetcher, url, headers, body, req.vendorLabel);
  const message = data.choices?.[0]?.message;

  return {
    toolsWork: (message?.tool_calls ?? []).length > 0,
    sample: (message?.content ?? "").trim().slice(0, 200),
  };
}
