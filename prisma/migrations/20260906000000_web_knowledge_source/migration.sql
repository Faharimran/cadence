-- A knowledge source can now be a website, not only an uploaded file.
--
-- Existing rows are all uploads, which is what the default encodes, so nothing
-- has to be backfilled.
ALTER TABLE "KnowledgeSource" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'file';
ALTER TABLE "KnowledgeSource" ADD COLUMN "sourceUrl" TEXT;
