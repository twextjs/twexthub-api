CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'review.approved', 'review.rejected',
    'terms.bumped', 'tokens.revoked', 'role.changed',
    'broadcast'
  )),
  message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_id_idx ON notifications(user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

-- Keep the newest 200 rows per user; older ones are deleted on insert.
CREATE FUNCTION prune_notifications() RETURNS trigger AS $$
  BEGIN
    -- Serialize per user so concurrent inserts cannot race the retention
    -- delete. Xact-scoped, so it releases on commit or rollback.
    PERFORM pg_advisory_xact_lock(NEW.user_id);
    DELETE FROM notifications
    WHERE user_id = NEW.user_id AND id <= (
      SELECT id FROM notifications
      WHERE user_id = NEW.user_id
      ORDER BY id DESC
      OFFSET 200
      LIMIT 1
    );
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_prune
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION prune_notifications();
