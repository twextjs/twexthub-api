-- Per-version download rollup, the same shape as extension_daily_downloads but
-- keyed on the version too, so an author can tell which release is being used.
-- Both are filled by the same daily aggregation from download_events.
CREATE TABLE extension_version_daily_downloads (
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  version TEXT NOT NULL,
  day DATE NOT NULL,
  total_downloads BIGINT NOT NULL DEFAULT 0,
  distinct_downloads BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, extension_id, version, day)
);
