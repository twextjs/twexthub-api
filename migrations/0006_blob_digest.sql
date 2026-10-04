ALTER TABLE versions
  ADD COLUMN blob_digest TEXT,
  ADD COLUMN blob_size BIGINT,
  ADD COLUMN blob_sha512 TEXT;

CREATE INDEX IF NOT EXISTS versions_blob_digest_idx ON versions(blob_digest);