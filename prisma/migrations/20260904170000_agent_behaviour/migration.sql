-- How this tenant's assistant behaves: their own instructions, and which model
-- answers. All nullable — null means "whatever the platform default is today",
-- so an existing tenant is unaffected until someone opens the page.
ALTER TABLE "Tenant" ADD COLUMN "agentInstructions" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "agentModel" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "agentEffort" TEXT;
