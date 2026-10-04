CREATE TABLE download_events (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  version TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  remote_addr TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX download_events_ns_id_ts_idx
  ON download_events(namespace, extension_id, created_at);

CREATE TABLE extension_daily_downloads (
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  day DATE NOT NULL,
  total_downloads BIGINT NOT NULL DEFAULT 0,
  distinct_downloads BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, extension_id, day)
);