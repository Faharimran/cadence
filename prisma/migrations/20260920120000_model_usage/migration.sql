-- What a tenant actually spent on a model, per call.
--
-- Nothing is backfilled and nothing can be: until this table existed the
-- numbers were computed, logged and dropped. The console therefore counts from
-- deploy forward, and says so on the page rather than presenting an empty first
-- week as a quiet one.
--
-- `costMicros` is nullable on purpose — null means the call ran on the tenant's
-- own key, which we neither pay for nor know the rate card of.
-- CreateTable
CREATE TABLE "ModelUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "roundTrips" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER,
    "conversationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelUsage_tenantId_createdAt_idx" ON "ModelUsage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelUsage_createdAt_idx" ON "ModelUsage"("createdAt");

-- AddForeignKey
ALTER TABLE "ModelUsage" ADD CONSTRAINT "ModelUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
