CREATE INDEX IF NOT EXISTS rate_limit_entries_window_start_idx
  ON rate_limit_entries(window_start);