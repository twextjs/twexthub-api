import { createHmac } from 'node:crypto';
import { downloadAddressKey } from './download-address.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Buckets are keyed on the UTC date the event falls in, so day boundaries are
// UTC midnight too. Local midnight would split a day into two buckets on any
// host that isn't on UTC.
function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function aggregateDayLoader(sql) {
  return async function aggregateDay(day = new Date()) {
    const dayStart = utcMidnight(day);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    await sql`
      INSERT INTO extension_daily_downloads (namespace, extension_id, day, total_downloads, distinct_downloads)
      SELECT
        e.namespace,
        e.extension_id,
        ${dayStart.toISOString()}::date AS day,
        COUNT(*)::bigint AS total_downloads,
        COUNT(
          DISTINCT COALESCE(e.ip_hash, e.user_agent, '')
        )::bigint AS distinct_downloads
      FROM download_events e
      WHERE e.created_at >= ${dayStart.toISOString()}
        AND e.created_at < ${dayEnd.toISOString()}
      GROUP BY e.namespace, e.extension_id
      ON CONFLICT (namespace, extension_id, day)
      DO UPDATE SET
        total_downloads = EXCLUDED.total_downloads,
        distinct_downloads = EXCLUDED.distinct_downloads
    `;
  };
}

// The download address is never stored. A keyed hash is enough to count
// distinct clients per day, and the raw value would otherwise sit in the table
// indefinitely with nothing reading it.
export async function hashDownloadAddress(sql, config, ip) {
  if (typeof ip !== 'string' || ip.length === 0) return null;
  const key = await downloadAddressKey(sql, config);
  return createHmac('sha256', key).update(ip).digest('base64url').slice(0, 22);
}

export function dailyAggregationJob(sql) {
  let timer = null;
  let running = false;
  const aggregateDay = aggregateDayLoader(sql);
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

export async function totalDownloads(sql, namespace, extensionId) {
  const rows = await sql`
    SELECT COALESCE(SUM(total_downloads), 0)::bigint AS total
    FROM extension_daily_downloads
    WHERE namespace = ${namespace} AND extension_id = ${extensionId}
  `;
  return rows[0]?.total ?? 0n;
}

export async function trendingExtensions(sql, { limit = 10, visibility = sql`` } = {}) {
  const rows = await sql`
    WITH latest AS (
      SELECT v.namespace, v.extension_id, v.visibility,
        row_number() OVER (
          PARTITION BY v.namespace, v.extension_id
          ORDER BY CASE WHEN v.status = 'published' THEN 0 ELSE 1 END,
                   v.published_at DESC, v.id DESC
        ) AS rn
      FROM versions v
      WHERE v.status IN ('published', 'deprecated')
    )
    SELECT d.namespace, d.extension_id,
           COALESCE(SUM(d.total_downloads), 0)::bigint AS downloads
    FROM extension_daily_downloads d
    JOIN latest s ON s.namespace = d.namespace AND s.extension_id = d.extension_id AND s.rn = 1
    WHERE d.day >= ${new Date(utcMidnight(new Date()).getTime() - 6 * DAY_MS).toISOString()}::date
      ${visibility}
    GROUP BY d.namespace, d.extension_id
    ORDER BY downloads DESC, d.namespace ASC, d.extension_id ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    namespace: row.namespace,
    id: row.extension_id,
    downloads: row.downloads,
  }));
}
