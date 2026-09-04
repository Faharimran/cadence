-- Importing from whatever the business used before.
--
-- SheetLink is a spreadsheet we re-read on a schedule; ImportRun is one pass
-- over it plus everything needed to take that pass back.

CREATE TABLE "SheetLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchUrl" TEXT NOT NULL,
    "gid" TEXT,
    "kind" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "removeMissing" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB,
    "undo" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "revertedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SheetLink_tenantId_status_idx" ON "SheetLink"("tenantId", "status");
CREATE INDEX "ImportRun_tenantId_startedAt_idx" ON "ImportRun"("tenantId", "startedAt");
CREATE INDEX "ImportRun_linkId_startedAt_idx" ON "ImportRun"("linkId", "startedAt");

ALTER TABLE "SheetLink" ADD CONSTRAINT "SheetLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "SheetLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
