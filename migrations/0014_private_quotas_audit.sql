ALTER TABLE versions
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private'));

-- Per-account access grants to private extensions. The namespace account and
-- owners need no grant; this covers everyone else.
CREATE TABLE extension_access (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  granted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, namespace, extension_id)
);
CREATE INDEX extension_access_ns_id_idx ON extension_access(namespace, extension_id);

-- Accounted blob storage and the per-account quota. A null max_blob_bytes
-- falls back to the configured default.
ALTER TABLE users
  ADD COLUMN blob_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN max_blob_bytes BIGINT;

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_namespace TEXT NOT NULL,
  action TEXT NOT NULL,
  target_namespace TEXT,
  target_extension_id TEXT,
  target_version TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
