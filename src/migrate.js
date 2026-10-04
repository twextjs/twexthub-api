import { loadConfig } from './config.js';
import { createDb, ensureDataDirs, runMigrations } from './db.js';

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--config');
if (flagIndex !== -1 && args[flagIndex + 1] === undefined) {
  throw new Error('--config requires a file path');
}
const configPath = flagIndex === -1 ? args[0] : args[flagIndex + 1];
const config = loadConfig(configPath);
ensureDataDirs(config.dataDir);
const sql = createDb(config);
try {
  await runMigrations(sql);
  console.log('Migrations applied.');
} finally {
  await sql.end();
}
