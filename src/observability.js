import { getIntegrityErrors } from './maintenance.js';

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

// Counts requests and accumulates durations in memory, and (optionally) writes
// one JSON log line per request. The route label comes from the matched
// Express route at finish time, so unmatched requests report as "unmatched"
// rather than echoing raw paths into the metrics cardinality.
export function makeRequestTelemetry({ logRequests = false } = {}) {
  const requests = new Map();
  const durations = new Map();

  function middleware(req, res, next) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

      const requestKey = `${req.method}|${route}|${res.statusCode}`;
      requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);

      const durationKey = `${req.method}|${route}`;
      const agg = durations.get(durationKey) ?? { sum: 0, count: 0 };
      agg.sum += durationMs / 1000;
      agg.count += 1;
      durations.set(durationKey, agg);

      if (logRequests) {
        console.log(
          JSON.stringify({
            time: new Date().toISOString(),
            msg: 'request',
            method: req.method,
            path: `${req.baseUrl || ''}${req.path}`,
            route,
            status: res.statusCode,
            durationMs: Math.round(durationMs * 100) / 100,
            ip: req.ip,
          }),
        );
      }
    });
    next();
  }

  function render() {
    const lines = [
      '# HELP twexthub_http_requests_total HTTP requests handled, by method, route, and status.',
      '# TYPE twexthub_http_requests_total counter',
    ];
    for (const [key, count] of requests) {
      const [method, route, status] = key.split('|');
      lines.push(
        `twexthub_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${count}`,
      );
    }
    lines.push('# HELP twexthub_http_request_duration_seconds Cumulative request duration.');
    lines.push('# TYPE twexthub_http_request_duration_seconds summary');
    for (const [key, agg] of durations) {
      const [method, route] = key.split('|');
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
      lines.push(`twexthub_http_request_duration_seconds_sum{${labels}} ${agg.sum.toFixed(6)}`);
      lines.push(`twexthub_http_request_duration_seconds_count{${labels}} ${agg.count}`);
    }
    return lines;
  }

  return { middleware, render };
}

export async function renderRegistryMetrics(sql, telemetry) {
  const [byStatus, users, extensions, downloads, storage] = await Promise.all([
    sql`SELECT status, COUNT(*)::bigint AS count FROM versions GROUP BY status`,
    sql`SELECT COUNT(*)::bigint AS count FROM users`,
    sql`SELECT COUNT(DISTINCT (namespace, extension_id))::bigint AS count FROM versions
        WHERE status IN ('published', 'deprecated')`,
    sql`SELECT COALESCE(SUM(total_downloads), 0)::bigint AS total FROM extension_daily_downloads`,
    sql`SELECT COALESCE(SUM(blob_size), 0)::bigint AS blob,
               COALESCE(SUM(source_size), 0)::bigint AS source
        FROM versions`,
  ]);

  const lines = [];
  const gauge = (name, help, value, labels = '') => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}${labels} ${value}`);
  };

  gauge('twexthub_users_total', 'Registered accounts.', Number(users[0].count));
  gauge(
    'twexthub_extensions_published_total',
    'Extensions with at least one published version.',
    Number(extensions[0].count),
  );
  for (const row of byStatus) {
    gauge(
      'twexthub_versions_total',
      'Versions by review status.',
      Number(row.count),
      `{status="${escapeLabel(row.status)}"}`,
    );
  }
  gauge('twexthub_downloads_total', 'Total recorded downloads.', Number(downloads[0].total));
  gauge(
    'twexthub_storage_bytes',
    'Charged storage by artifact kind.',
    Number(storage[0].blob),
    '{kind="blob"}',
  );
  gauge(
    'twexthub_storage_bytes',
    'Charged storage by artifact kind.',
    Number(storage[0].source),
    '{kind="source"}',
  );
  gauge(
    'twexthub_storage_integrity_errors',
    'Blobs that failed or could not complete the last integrity scrub.',
    getIntegrityErrors(),
  );
  gauge(
    'twexthub_process_uptime_seconds',
    'Seconds since the server process started.',
    Math.floor(process.uptime()),
  );

  lines.push(...telemetry.render());
  return `${lines.join('\n')}\n`;
}
