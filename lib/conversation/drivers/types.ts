import type Anthropic from "@anthropic-ai/sdk";
import type { buildTools } from "@/lib/conversation/tools";
import type { Protocol } from "@/lib/conversation/providers";

/**
 * What every protocol has to be able to do, and nothing more.
 *
 * A driver runs one turn: take a prompt, a transcript and a set of tools, let
 * the model work until it stops asking for tools, and report what it said and
 * what it cost. That is the entire contract, and it is deliberately narrow —
 * everything that decides whether the assistant behaves well (which tools exist,
 * what they refuse to do, what is in the prompt) is decided before a driver is
 * called and is identical whichever one runs.
 *
 * Which means a business on DeepSeek gets the same guarantees as one on enori's
 * Claude key: the same closed toolset, the same approved knowledge, the same
 * refusal to quote a price no tool returned. The model changes; the walls do not.
 */

/**
 * The toolset, exactly as `buildTools` produced it.
 *
 * Taken from that function's own return type rather than re-declared, because a
 * second declaration is a second thing to keep in step — and the way it would
 * announce itself is a tool that silently stops being offered to one protocol.
 */
export type AgentTools = ReturnType<typeof buildTools>;

/** One tool, in the shape a non-Anthropic protocol needs to read. */
export type ToolShape = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  parse: (input: unknown) => unknown;
  run: (input: never) => Promise<string | unknown[]> | string | unknown[];
};

export type TurnRequest = {
  /** Which wire protocol to speak. Decides the driver, and nothing else does. */
  protocol: Protocol;
  /**
   * The system prompt, still in Anthropic's block form because that is what
   * carries the cache breakpoint. A protocol without prompt caching flattens
   * it; one with caching must not, or the largest part of every prompt is
   * re-billed at full price on every message.
   */
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: { role: "user" | "assistant"; content: string }[];
  tools: AgentTools;
  model: string;
  effort?: "low" | "medium" | "high";
  maxIterations: number;
  maxTokens: number;
  apiKey: string;
  baseUrl: string | null;
  /** Whose key this is. Only the platform's carries our workspace header. */
  source: "platform" | "tenant";
  /** Names the provider in any error a person will read. */
  vendorLabel: string;
};

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type TurnResult = {
  /** The reply, or "" when the model produced no text. */
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage: TurnUsage;
  /** API calls made. Each one re-sends the whole prompt and is billed for it. */
  roundTrips: number;
};

/** What a connection test asks, and what it can tell you. */
export type PingRequest = {
  protocol: Protocol;
  apiKey: string;
  baseUrl: string | null;
  model: string;
  vendorLabel: string;
};

export type PingResult = {
  /**
   * Whether the model called the tool it was handed.
   *
   * Asked because a key that authenticates is not the same as a model that can
   * book. Tool calling is how every booking in this product happens, plenty of
   * OpenAI-compatible endpoints answer chat perfectly and ignore `tools`
   * entirely, and the symptom is an assistant that chats pleasantly and never
   * books anything — which looks like a bad model, not a bad setup, and gets
   * discovered by a customer.
   */
  toolsWork: boolean;
  /** What the model actually replied, for the page to show. */
  sample: string;
};

export const emptyUsage = (): TurnUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
