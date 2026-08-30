-- Someone who runs cadence itself rather than a business on it.
--
-- A separate table from "User", not a flag on it: every User belongs to a
-- tenant and a platform operator belongs to none. Two tables cannot be mistaken
-- for one another, whereas a nullable tenantId puts a null check in front of
-- every tenant-scoped query — the check that eventually gets forgotten.
--
-- Not tenant-scoped, so it carries no row-level-security policy. What protects
-- it is that no tenant session can reach it: platform sessions use a different
-- cookie signed under a different HMAC domain (lib/platform/session.ts).
CREATE TYPE "PlatformRole" AS ENUM ('support', 'admin');

CREATE TABLE "PlatformUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'support',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformUser_email_key" ON "PlatformUser"("email");
CREATE INDEX "PlatformUser_active_idx" ON "PlatformUser"("active");
