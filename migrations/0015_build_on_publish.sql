-- Server-side build on publish: the registry keeps the uploaded source
-- tarball and records the sandboxed compile that produced the served blob.
ALTER TABLE versions
  ADD COLUMN source_path TEXT,
  ADD COLUMN source_digest TEXT,
  ADD COLUMN source_size BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN build_log TEXT,
  ADD COLUMN build_error TEXT;

-- Moderation/GC look up the on-disk source by digest when pruning.
CREATE INDEX versions_source_digest_idx ON versions(source_digest)
  WHERE source_digest IS NOT NULL;