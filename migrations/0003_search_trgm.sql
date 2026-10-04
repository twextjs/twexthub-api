-- Requires CREATE EXTENSION privileges (pg_trgm may already exist in managed Postgres).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS versions_search_text_trgm_idx
  ON versions USING gin (search_text gin_trgm_ops);