-- Full-text search over the knowledge corpus.
--
-- An IMMUTABLE function plus a GIN index over the expression, rather than a
-- stored generated column. The generated column was tried first and abandoned:
-- Prisma cannot express GENERATED, so it read the column as drift, offered to
-- reset the database on every `migrate dev`, and then emitted DDL that Postgres
-- rejects outright. An expression index is invisible to Prisma for the same
-- reason the exclusion constraint on BookingResource is, and Postgres uses it
-- for any query written with the same expression.
--
-- The function must be IMMUTABLE for the index to be legal. The two-argument
-- form of to_tsvector with a literal config is immutable; the one-argument form
-- depends on a session setting and is not.
--
-- Weighting: a title here is the question a customer would ask, so a hit there
-- is much stronger evidence than the same word buried in prose — 'A' over 'B'.
-- Tags are excluded deliberately: `array_to_string` is only STABLE, so it
-- cannot appear here, and tags are already an exact filter on the query.
CREATE OR REPLACE FUNCTION knowledge_tsv(title text, body text)
  RETURNS tsvector
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
         setweight(to_tsvector('english', coalesce(body, '')), 'B')
$$;

CREATE INDEX IF NOT EXISTS knowledge_doc_search
  ON "KnowledgeDoc" USING GIN (knowledge_tsv(title, body));
