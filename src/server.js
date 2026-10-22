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
// aggregation locks the download rollups before reading download_events, which
// is the reverse of the order a TRUNCATE takes those tables in, so resetDb and
// a background pass deadlock. Tests that want a job build it themselves and
// drive it directly.
export async function bootstrap(
  config = loadConfig(),
  { backgroundJobs = true, storageProbe, resolveTarget, migrations = true } = {},
) {
  ensureDataDirs(config.dataDir);
  const db = createDb(config);
  try {
    // The suite applies the migrations once and then tells every later boot to
    // skip the bridge: each test file boots its own app, so re-running it would
    // spawn `prisma migrate deploy` a few dozen times to find nothing pending.
    // Production always applies them.
    if (migrations) await runMigrations(db, config);
    await reconcileOnBoot(db, config);
    const { app, rateLimiter, telemetry } = createApp({ config, db, storageProbe, resolveTarget });
    if (!backgroundJobs) {
      return { app, db, config, rateLimiter, telemetry };
    }
    const metricsJob = dailyAggregationJob(db).start();
    const webhookWorker = makeWebhooks({ db }).worker().start();
    const maintenanceJob = makeMaintenanceJob({ db, config }).start();
    return { app, db, config, rateLimiter, telemetry, metricsJob, webhookWorker, maintenanceJob };
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const configPath = process.argv[2] ?? product.defaults?.configFilename ?? 'config.yaml';
  const { app, db, config, rateLimiter, metricsJob, webhookWorker, maintenanceJob } =
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
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
