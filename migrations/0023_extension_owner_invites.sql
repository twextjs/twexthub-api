-- An owner grant is two steps: the namespace account invites, the invitee
-- accepts. A separate table rather than a status column on extension_owners, so
-- that "is an owner" keeps a single meaning everywhere it is asked. The three
-- checks that answer it (the publish path, canSee, the listing filter) are
-- security-relevant and a pending row that one of them forgot to exclude would
-- be a grant nobody accepted. An invite is not an owner row at all, so there is
-- nothing for them to exclude.
--
-- An organization can be invited here. It holds no sessions and no inbox of its
-- own, so accepting is done by any of the accounts on its owner list, the same
-- rule that lets any of them publish to @org/id.
--
-- invited_by is nulled rather than cascaded, so deleting the account that made
-- the invitation is not blocked by the record of who made it.
CREATE TABLE extension_owner_invites (
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, extension_id, owner_id)
);

-- Listing an invitee's pending invites is by candidate, and accepting one
-- arrives the same way; extension_owners carries the mirror index.
CREATE INDEX extension_owner_invites_owner_idx ON extension_owner_invites(owner_id);

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (
    kind IN (
      'review.approved', 'review.rejected',
      'terms.bumped', 'tokens.revoked', 'role.changed',
      'broadcast',
      'extension.owner.added', 'extension.owner.removed',
      'extension.owner.invited', 'extension.owner.withdrawn',
      'organization.owner.added', 'organization.owner.removed'
    )
  );
