-- A tenant's own model credentials — bring your own key.
--
-- One row per tenant, and no row is the default: conversations run on cadence's
-- platform key until a business says otherwise. Nothing here is backfilled,
-- because "no row" is exactly the state every existing tenant should be in.
--
-- `apiKey` holds ciphertext from lib/crypto.ts, not a key. It is the third
-- secret in this database that has to be spent rather than verified (the other
-- two are on ChannelAccount), which is why it is encrypted and not hashed.
-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastOkAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelProvider_tenantId_key" ON "ModelProvider"("tenantId");

-- AddForeignKey
ALTER TABLE "ModelProvider" ADD CONSTRAINT "ModelProvider_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
