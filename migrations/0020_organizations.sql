-- An organization is a pseudo-account: a users row that never signs in, holds
-- no session and has no password, but owns a namespace, extensions and profile
-- images like any other account. Sharing the table is what makes @org/id
-- resolve, keeps the storage quota and the publish-review trust where the
-- publish path already reads them, and lets the profile image columns, the
-- blob collector and the identicon fallback apply to an organization without
-- any of them having to learn what one is.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
  CHECK (kind IN ('user', 'organization'));

-- Nullable only so an organization can have no password at all. The constraint
-- is what keeps the two halves of the row honest: an account without a password
-- could not sign in, and an organization with one would be a credential whose
-- plaintext nobody could ever read.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_password_matches_kind CHECK (
  (kind = 'user' AND password_hash IS NOT NULL)
  OR (kind = 'organization' AND password_hash IS NULL)
);

-- The target of the composite foreign keys below. (id, kind) is already unique
-- because id alone is, so this index holds no information the primary key does
-- not; it exists because Postgres will only point a foreign key at a unique
-- constraint of exactly its own shape.
ALTER TABLE users ADD CONSTRAINT users_id_kind_key UNIQUE (id, kind);

-- The accounts that manage an organization. Nesting is refused here rather than
-- in each route: an owner is a person who can sign in, and an organization that
-- owned another organization would make "who can manage this" a question with
-- no bottom to it. Both sides carry the row's kind so the foreign keys can be
-- aimed at (id, kind); there is no trigger to keep that true and no code path to
-- forget a check.
--
-- added_by is nulled rather than cascaded, so deleting the account that made
-- the change is not blocked by the record of who made it.
CREATE TABLE organization_owners (
  org_id BIGINT NOT NULL,
  org_kind TEXT NOT NULL DEFAULT 'organization' CHECK (org_kind = 'organization'),
  user_id BIGINT NOT NULL,
  user_kind TEXT NOT NULL DEFAULT 'user' CHECK (user_kind = 'user'),
  added_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, org_kind) REFERENCES users(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (user_id, user_kind) REFERENCES users(id, kind) ON DELETE CASCADE
);

-- Adding and removing owners looks an account up by the organizations it owns,
-- not only by the ones it holds the key to.
CREATE INDEX organization_owners_user_idx ON organization_owners(user_id);
