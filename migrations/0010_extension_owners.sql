CREATE TABLE extension_owners (
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  added_by BIGINT REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, extension_id, owner_id)
);

CREATE INDEX extension_owners_owner_idx ON extension_owners(owner_id);