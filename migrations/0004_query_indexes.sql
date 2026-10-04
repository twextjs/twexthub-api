DROP INDEX IF EXISTS versions_status_idx;
CREATE INDEX IF NOT EXISTS versions_status_created_at_idx ON versions(status, created_at);
CREATE INDEX IF NOT EXISTS versions_status_published_at_idx ON versions(status, published_at DESC);