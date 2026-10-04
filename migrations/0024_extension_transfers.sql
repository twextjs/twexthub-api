-- Moving an extension to a different namespace. Two steps like an owner grant:
-- the namespace that holds the extension asks, the namespace that would receive
-- it agrees. Both steps are recorded here rather than in a status column on
-- versions, because until the second one runs there is no move to describe and
-- nothing should read as though the address has already changed.
--
-- The request is keyed by (source address, recipient) so one namespace can have
-- several offers outstanding to different people, but only one to any single
-- recipient: that is the one they would act on, and a second copy would make
-- "which offer is this" a question the accept endpoint has to answer.
CREATE TABLE extension_transfers (
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  to_namespace TEXT NOT NULL,
  requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, extension_id, to_namespace)
);

-- The recipient's inbox is addressed by the namespace being offered the
-- extension, which is a text key rather than a users id, since the whole
-- point is that the recipient may not be the account that gets to act.
CREATE INDEX extension_transfers_to_idx ON extension_transfers(to_namespace);

-- Where an address used to point. Kept so that `twext install @old/id` keeps
-- resolving after the move instead of 404ing on every pinned version and README
-- badge in the wild.
--
-- Redirects are stored already collapsed: a row always names the final
-- destination, never another redirect. A -> B, then B -> C rewrites the A row
-- to C in the same transaction, so resolution is one lookup with no loop and no
-- way to build a cycle. That is also why the target cannot be asked to accept
-- an extension whose current address is itself a redirect.
CREATE TABLE extension_redirects (
  from_namespace TEXT NOT NULL,
  from_extension_id TEXT NOT NULL,
  to_namespace TEXT NOT NULL,
  to_extension_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_namespace, from_extension_id)
);

-- Looking a redirect up by where it points is how a move finds the rows to
-- rewrite when a redirect's own destination is moved again.
CREATE INDEX extension_redirects_to_idx ON extension_redirects(to_namespace, to_extension_id);

ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (
    kind IN (
      'review.approved', 'review.rejected',
      'terms.bumped', 'tokens.revoked', 'role.changed',
      'broadcast',
      'extension.owner.added', 'extension.owner.removed',
      'extension.owner.invited', 'extension.owner.withdrawn',
      'extension.transfer.requested', 'extension.transfer.completed',
      'organization.owner.added', 'organization.owner.removed'
    )
  );
