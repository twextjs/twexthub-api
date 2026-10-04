-- v1.0.0 hardening: indexes for the v1.0.0 tables' hot paths and an index that
-- keeps the windowed "latest version per extension" query from scanning every
-- published row.

-- Private-visibility probes (canSee, discovery's visibilityFilter) select rows
-- by visibility first; a partial index keeps it tiny.
CREATE INDEX versions_visibility_idx
  ON versions(visibility)
  WHERE visibility = 'private';

-- Discovery, badges, and the Atom feed rank published rows within a namespace
-- by publication time; this matches the window's PARTITION BY/ORDER BY shape.
CREATE INDEX versions_public_listing_idx
  ON versions(namespace, extension_id, status, published_at DESC)
  WHERE status IN ('published', 'deprecated');

-- Audit listing pages backwards from the newest entry; the created_at index
-- from 0014 covers time ordering, but the moderation/history joins filter on
-- target columns too.
CREATE INDEX audit_log_target_idx
  ON audit_log(target_namespace, target_extension_id)
  WHERE target_namespace IS NOT NULL;

-- Dist-tag lookups resolve version from (namespace, extension_id, tag) —
-- covered by the UNIQUE constraint — but the admin/ops path also deletes by
-- version when a version disappears.
CREATE INDEX dist_tags_version_idx ON dist_tags(namespace, extension_id, version);

-- Webhook delivery polling scans due deliveries by status and time; the
-- partial index from 0012 covers it. Listing by webhook for the retention
-- prune gets a covering index.
CREATE INDEX webhook_deliveries_webhook_id_idx ON webhook_deliveries(webhook_id, id DESC);

-- Download attribution queries filter by namespace/version first.
CREATE INDEX download_events_version_idx
  ON download_events(namespace, extension_id, version);
