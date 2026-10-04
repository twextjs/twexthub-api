import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { product } from './product.js';
import { createApp } from './app.js';
import { createDb, ensureDataDirs, reconcileOnBoot, runMigrations } from './db.js';
import { dailyAggregationJob } from './metrics.js';
import { makeMaintenanceJob } from './maintenance.js';
import { makeWebhooks } from './webhooks.js';

// `backgroundJobs` is off for the test suite. The jobs all run a pass
// immediately, and their passes collide with the suite's own setup: the daily
// aggregation locks extension_daily_downloads before reading download_events,
// which is the reverse of the order a TRUNCATE takes the same two tables in, so
// resetDb and a background pass deadlock. Tests that want a job build it
// themselves and drive it directly.
export async function bootstrap(
  config = loadConfig(),
  { backgroundJobs = true, storageProbe } = {},
) {
  ensureDataDirs(config.dataDir);
  const sql = createDb(config);
  try {
    await runMigrations(sql);
    await reconcileOnBoot(sql, config);
    const { app, rateLimiter, telemetry } = createApp({ config, sql, storageProbe });
    if (!backgroundJobs) {
      return { app, sql, config, rateLimiter, telemetry };
    }
    const metricsJob = dailyAggregationJob(sql).start();
    const webhookWorker = makeWebhooks({ sql }).worker().start();
    const maintenanceJob = makeMaintenanceJob({ sql, config }).start();
    return { app, sql, config, rateLimiter, telemetry, metricsJob, webhookWorker, maintenanceJob };
  } catch (error) {
    await sql.end();
    throw error;
  }
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const configPath = process.argv[2] ?? product.defaults?.configFilename ?? 'config.yaml';
  const { app, sql, config, rateLimiter, metricsJob, webhookWorker, maintenanceJob } =
    await bootstrap(loadConfig(configPath));
  const server = app.listen(config.port, () => {
    console.log(`${product.name} v${product.version} listening on http://localhost:${config.port}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rateLimiter?.stop?.();
    await metricsJob?.stop?.();
    await webhookWorker?.stop?.();
    await maintenanceJob?.stop?.();
    const force = setTimeout(() => server.closeAllConnections(), 5000);
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(force);
    await sql.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
