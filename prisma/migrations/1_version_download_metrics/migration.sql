-- Per-version download rollup, the same shape as extension_daily_downloads but
-- keyed on the version too, so an author can tell which release is being used.
-- Both are filled by the same daily aggregation from download_events.
--
-- This was the last of the legacy SQL migrations (0029). It is carried as a
-- Prisma migration after the baseline so that a database adopted from an older
-- SQL history -- one that stops at 0028_version_warnings.sql, before the rollup
-- existed -- gets the table from `migrate deploy`. The baseline is a snapshot
-- that already includes it, so IF NOT EXISTS keeps the statement a no-op on a
-- fresh install or on a database that already ran the 0029 file.
CREATE TABLE IF NOT EXISTS "public"."extension_version_daily_downloads" (
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "total_downloads" BIGINT NOT NULL DEFAULT 0,
    "distinct_downloads" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "extension_version_daily_downloads_pkey" PRIMARY KEY ("namespace","extension_id","version","day")
);
