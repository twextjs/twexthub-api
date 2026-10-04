-- The two membership notifications an organization raises, the same pair the
-- extension owner list already sends. A new migration rather than a widened
-- check on 0011 so the constraint a fresh database ends up with is written once.
ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (
    kind IN (
      'review.approved', 'review.rejected',
      'terms.bumped', 'tokens.revoked', 'role.changed',
      'broadcast',
      'extension.owner.added', 'extension.owner.removed',
      'organization.owner.added', 'organization.owner.removed'
    )
  );
