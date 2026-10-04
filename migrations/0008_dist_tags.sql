CREATE TABLE dist_tags (
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace, extension_id, tag)
);

CREATE INDEX dist_tags_namespace_id_idx ON dist_tags(namespace, extension_id);