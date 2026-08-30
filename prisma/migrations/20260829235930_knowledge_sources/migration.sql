-- CreateEnum
CREATE TYPE "KnowledgeSourceStatus" AS ENUM ('extracting', 'review', 'done', 'failed');

-- AlterTable
ALTER TABLE "KnowledgeDoc" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourcePage" INTEGER;

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "pageCount" INTEGER,
    "extractedText" TEXT,
    "status" "KnowledgeSourceStatus" NOT NULL DEFAULT 'extracting',
    "failureNote" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeSource_tenantId_status_idx" ON "KnowledgeSource"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_tenantId_checksum_key" ON "KnowledgeSource"("tenantId", "checksum");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_sourceId_idx" ON "KnowledgeDoc"("sourceId");

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
