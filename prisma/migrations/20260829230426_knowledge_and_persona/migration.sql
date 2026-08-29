-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('draft', 'approved', 'archived');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "descriptor" TEXT,
ADD COLUMN     "escalationTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "toneNote" TEXT,
ADD COLUMN     "vertical" TEXT,
ALTER COLUMN "currency" DROP DEFAULT;

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "authorId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDoc_tenantId_status_idx" ON "KnowledgeDoc"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDoc_tenantId_title_key" ON "KnowledgeDoc"("tenantId", "title");

-- CreateIndex
CREATE INDEX "KnowledgeRevision_tenantId_idx" ON "KnowledgeRevision"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRevision_docId_version_key" ON "KnowledgeRevision"("docId", "version");

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRevision" ADD CONSTRAINT "KnowledgeRevision_docId_fkey" FOREIGN KEY ("docId") REFERENCES "KnowledgeDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
