ALTER TABLE notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (
    kind IN (
      'review.approved', 'review.rejected',
      'terms.bumped', 'tokens.revoked', 'role.changed',
      'broadcast',
      'extension.owner.added', 'extension.owner.removed'
    )
  );