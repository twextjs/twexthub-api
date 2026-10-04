CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'normal' CHECK (role IN ('admin', 'normal')),
  has_published BOOLEAN NOT NULL DEFAULT false,
  terms_accepted_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE automation_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX automation_tokens_user_id_idx ON automation_tokens(user_id);

CREATE TABLE versions (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staging' CHECK (
    status IN ('staging', 'pending', 'published', 'rejected', 'yanked')
  ),
  name TEXT NOT NULL,
  license TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT,
  color1 TEXT,
  color2 TEXT,
  color3 TEXT,
  blob_path TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  rejection_reason TEXT,
  UNIQUE (owner_id, extension_id, version)
);
CREATE INDEX versions_namespace_id_idx ON versions(namespace, extension_id);
CREATE INDEX versions_status_idx ON versions(status);
CREATE UNIQUE INDEX versions_one_pending_idx ON versions(owner_id)
  WHERE status IN ('staging', 'pending');

CREATE TABLE legal_documents (
  kind TEXT PRIMARY KEY CHECK (kind IN ('terms', 'privacy')),
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_entries (
  id BIGSERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (bucket, window_start)
);