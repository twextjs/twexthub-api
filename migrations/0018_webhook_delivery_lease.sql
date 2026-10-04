-- The delivery worker claims rows with FOR UPDATE SKIP LOCKED, which scans by
-- status and time. The partial index from 0012 covers 'pending' and 'retrying',
-- but a claimed row now sits in 'delivering' until its lease runs out, and
-- reclaiming an expired one has to be able to use the index too.
DROP INDEX webhook_deliveries_due_idx;
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at)
  WHERE status IN ('pending', 'retrying', 'delivering');
