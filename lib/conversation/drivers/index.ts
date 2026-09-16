import type { PingRequest, PingResult, TurnRequest, TurnResult } from "./types";
import { pingAnthropic, runAnthropicTurn } from "./anthropic";
import { pingOpenAi, runOpenAiTurn } from "./openai";

export type {
  AgentTools,
  PingRequest,
  PingResult,
  ToolShape,
  TurnRequest,
  TurnResult,
  TurnUsage,
} from "./types";
export { buildChatRequest, runOpenAiTurn, type Fetcher } from "./openai";
export { runAnthropicTurn } from "./anthropic";

/**
 * One turn, on whichever protocol this tenant's key speaks.
 *
 * The switch is exhaustive over a two-member union rather than a lookup on a
 * string, so adding a protocol is a compile error everywhere it has to be
 * handled — which is the point of keeping the set closed.
 */
export function runTurn(req: TurnRequest): Promise<TurnResult> {
  switch (req.protocol) {
    case "anthropic":
      return runAnthropicTurn(req);
    case "openai":
      return runOpenAiTurn(req);
  }
}

export function pingProvider(req: PingRequest): Promise<PingResult> {
  switch (req.protocol) {
    case "anthropic":
      return pingAnthropic(req);
    case "openai":
      return pingOpenAi(req);
  }
}
