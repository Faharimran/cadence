import type { TenantDb } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { priceMicros, type TokenCounts } from "@/lib/conversation/pricing";

/**
 * Writing down what a model call cost.
 *
 * One function, called from the two places a model is actually paid for: a
 * conversation turn (workers/index.ts) and document ingestion
 * (lib/knowledge/ingest.ts). Both were previously measured and discarded.
 *
 * **This never throws.** The tokens have already been spent and the customer has
 * already been answered by the time it runs; failing the job over a bookkeeping
 * insert would turn a lost row into a retried turn, which spends the money a
 * second time to record the first. A failed write is logged and dropped, and
 * the console under-reports by one call — which is the cheaper wrong answer.
 */
export type UsageRecord = {
  tenantId: string;
  kind: "conversation" | "ingestion";
  source: "platform" | "tenant";
  protocol: string;
  vendor: string;
  model: string;
  tokens: TokenCounts;
  roundTrips: number;
  conversationId?: string | null;
};

export async function recordModelUsage(db: TenantDb, r: UsageRecord): Promise<void> {
  const { input, output, cacheRead, cacheWrite } = r.tokens;

  // A call that reports nothing is a call that did not happen — a driver that
  // returned early, or a provider that omitted usage entirely. A row of zeroes
  // would inflate the call count while adding nothing to the totals.
  if (input + output + cacheRead + cacheWrite === 0) return;

  try {
    await db.modelUsage.create({
      data: {
        tenantId: r.tenantId,
        kind: r.kind,
        source: r.source,
        protocol: r.protocol,
        vendor: r.vendor,
        model: r.model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        roundTrips: r.roundTrips,
        costMicros: priceMicros(r.source, r.model, r.tokens),
        conversationId: r.conversationId ?? null,
      },
    });
  } catch (err) {
    logger.warn("could not record model usage", {
      tenantId: r.tenantId,
      kind: r.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
