ALTER TABLE versions
  DROP CONSTRAINT IF EXISTS versions_status_check,
  ADD CONSTRAINT versions_status_check CHECK (
    status IN ('staging', 'pending', 'published', 'rejected', 'yanked', 'deprecated')
  );

ALTER TABLE versions
  ADD COLUMN deprecation_message TEXT;