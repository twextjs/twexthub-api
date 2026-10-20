import { createHmac } from 'node:crypto';
import { normalizeValue } from './db.js';
import { downloadAddressKey } from './download-address.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Buckets are keyed on the UTC date the event falls in, so day boundaries are
// UTC midnight too. Local midnight would split a day into two buckets on any
// host that isn't on UTC.
function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function aggregateDayLoader(db) {
  return async function aggregateDay(day = new Date()) {
    const dayStart = utcMidnight(day);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    // One scan of the day's events feeds both rollups, so the extension and
    // version counts are computed from the same snapshot rather than two reads
    // that a concurrent download could fall between. The `events` CTE is
    // referenced twice, so Postgres materializes it once; the data-modifying
    // `"extension"` CTE runs alongside the primary version insert. Kept as a
    // single raw statement: both upserts share one snapshot.
    await db.$executeRaw`
      WITH events AS (
        SELECT
          "Namespace",
          "ExtensionId",
          "Version",
          COALESCE("IpHash", "UserAgent", '') AS client
        FROM "DownloadEvents"
        WHERE "CreatedAt" >= ${dayStart}
          AND "CreatedAt" < ${dayEnd}
      ),
      "extension" AS (
        INSERT INTO "ExtensionDailyDownloads" ("Namespace", "ExtensionId", "Day", "TotalDownloads", "DistinctDownloads")
        SELECT
          "Namespace",
          "ExtensionId",
          ${dayStart}::date AS "Day",
          COUNT(*)::bigint AS "TotalDownloads",
          COUNT(DISTINCT client)::bigint AS "DistinctDownloads"
        FROM events
        GROUP BY "Namespace", "ExtensionId"
        ON CONFLICT ("Namespace", "ExtensionId", "Day")
        DO UPDATE SET
          "TotalDownloads" = EXCLUDED."TotalDownloads",
          "DistinctDownloads" = EXCLUDED."DistinctDownloads"
      )
      INSERT INTO "ExtensionVersionDailyDownloads" ("Namespace", "ExtensionId", "Version", "Day", "TotalDownloads", "DistinctDownloads")
      SELECT
        "Namespace",
        "ExtensionId",
        "Version",
        ${dayStart}::date AS "Day",
        COUNT(*)::bigint AS "TotalDownloads",
        COUNT(DISTINCT client)::bigint AS "DistinctDownloads"
      FROM events
      GROUP BY "Namespace", "ExtensionId", "Version"
      ON CONFLICT ("Namespace", "ExtensionId", "Version", "Day")
      DO UPDATE SET
        "TotalDownloads" = EXCLUDED."TotalDownloads",
        "DistinctDownloads" = EXCLUDED."DistinctDownloads"
    `;
  };
}

// The download address is never stored. A keyed hash is enough to count
// distinct clients per day, and the raw value would otherwise sit in the table
// indefinitely with nothing reading it.
export async function hashDownloadAddress(db, config, ip) {
  if (typeof ip !== 'string' || ip.length === 0) return null;
  const key = await downloadAddressKey(db, config);
  return createHmac('sha256', key).update(ip).digest('base64url').slice(0, 22);
}

export function dailyAggregationJob(db) {
  let timer = null;
  let running = false;
  const aggregateDay = aggregateDayLoader(db);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const yesterday = new Date(utcMidnight(new Date()).getTime() - DAY_MS);
      await aggregateDay(yesterday);
      await aggregateDay(new Date());
    } catch (error) {
      console.error('daily download aggregation failed:', error);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      const interval = Number(process.env.TWEXTHUB_METRICS_INTERVAL_MS ?? 60 * 60 * 1000);
      timer = setInterval(tick, interval);
      timer.unref?.();
      void tick();
      return this;
    },
    async stop() {
      if (timer) clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

// Grouped sums stay raw: four call sites want the same `SUM(...)::bigint` shape
// and a typed aggregate would still be one round trip each.
export async function totalDownloads(db, namespace, extensionId) {
  const rows = await db.$queryRaw`
    SELECT COALESCE(SUM("TotalDownloads"), 0)::bigint AS total
    FROM "ExtensionDailyDownloads"
    WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${extensionId}
  `;
  return normalizeValue(rows[0]?.total ?? 0n);
}

export async function trendingExtensions(db, { limit = 10 } = {}) {
  const rows = await db.$queryRaw`
    WITH latest AS (
      SELECT v."Namespace", v."ExtensionId",
        row_number() OVER (
          PARTITION BY v."Namespace", v."ExtensionId"
          ORDER BY CASE WHEN v."Status" = 'published' THEN 0 ELSE 1 END,
                   v."PublishedAt" DESC, v."Id" DESC
        ) AS rn
      FROM "Versions" v
      WHERE v."Status" IN ('published', 'deprecated')
    )
    SELECT d."Namespace", d."ExtensionId",
           COALESCE(SUM(d."TotalDownloads"), 0)::bigint AS downloads
    FROM "ExtensionDailyDownloads" d
    JOIN latest s ON s."Namespace" = d."Namespace" AND s."ExtensionId" = d."ExtensionId" AND s.rn = 1
    WHERE d."Day" >= ${new Date(utcMidnight(new Date()).getTime() - 6 * DAY_MS)}::date
    GROUP BY d."Namespace", d."ExtensionId"
    ORDER BY downloads DESC, d."Namespace" ASC, d."ExtensionId" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    namespace: row.Namespace,
    id: row.ExtensionId,
    downloads: normalizeValue(row.downloads),
  }));
}

export async function versionDownloads(db, namespace, extensionId, version) {
  const rows = await db.$queryRaw`
    SELECT COALESCE(SUM("TotalDownloads"), 0)::bigint AS total
    FROM "ExtensionVersionDailyDownloads"
    WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${extensionId} AND "Version" = ${version}
  `;
  return normalizeValue(rows[0]?.total ?? 0n);
}

// Every version's count for one extension in a single query, so a version list
// does not issue one statement per entry.
export async function versionDownloadTotals(db, namespace, extensionId) {
  const rows = await db.$queryRaw`
    SELECT "Version", COALESCE(SUM("TotalDownloads"), 0)::bigint AS total
    FROM "ExtensionVersionDailyDownloads"
    WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${extensionId}
    GROUP BY "Version"
  `;
  return new Map(rows.map((row) => [row.Version, row.total]));
}
