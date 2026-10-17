// The runner `npm test` uses. It brings one template database fully up to date,
// then runs every test file against a clone of it (test/helpers.mjs) so the
// files can run at the same time without truncating each other's rows. Keeping
// the preparation and the runner behind one command means a developer can run
// it directly, and CI keeps calling plain `npm test`.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_DATABASE_URL =
  process.env.TWEXTHUB_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/twexthub_test';

const baseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
const adminUrl = new URL(TEST_DATABASE_URL);
adminUrl.pathname = '/postgres';

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// A clone is named `<base>_w<runId>_<pid>` (test/helpers.mjs): the run that
// created it, then the process. The run id is the time that run started, so a
// clone can be told from the template (no suffix) and its age from the name.
const RUN_ID = Date.now().toString();
// The suite finishes in about a minute, so a clone this old is residue from a
// run that died before it could clean up; anything newer might belong to a run
// happening right now, which must be left alone.
const STALE_CLONE_MS = 60 * 60 * 1000;

// The run id a clone name carries, or null when the name is not a clone (the
// template, or a database that merely shares the prefix).
function cloneRunId(name) {
  const prefix = `${baseName}_w`;
  if (!name.startsWith(prefix)) return null;
  const match = /^([0-9]+)_[0-9]+$/.exec(name.slice(prefix.length));
  return match ? match[1] : null;
}

async function dropClones(shouldDrop) {
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT datname FROM pg_database');
    for (const { datname } of rows) {
      if (shouldDrop(datname)) {
        await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    }
  } finally {
    await client.end();
  }
}

// What earlier runs left behind when they crashed before their own cleanup. A
// concurrent run's clones are minutes old at most, so the age threshold keeps
// them out of the sweep.
const isStaleClone = (name) => {
  const runId = cloneRunId(name);
  return runId !== null && Date.now() - Number(runId) > STALE_CLONE_MS;
};

// The clones this run made, known as its own by the id baked into their names.
const isOwnClone = (name) => cloneRunId(name) === RUN_ID;

// The template is the database a single file run would use, brought fully up to
// date once. Every clone copies its `_prisma_migrations` history, so the
// per-file boot has nothing left to apply.
async function migrateTemplate() {
  const config = loadConfig();
  config.database.url = TEST_DATABASE_URL;
  const db = createDb(config);
  try {
    await runMigrations(db, config);
  } finally {
    await db.$disconnect();
  }
}

// Enough workers to cover the database- and CPU-bound files without so many
// sandbox builds at once that they starve each other. Capped at eight: beyond
// that the clones mostly queue, and the longest single file is a floor the
// runner cannot beat. A four-core CI runner still gets four.
function concurrency() {
  const requested = Number(process.env.TWEXTHUB_TEST_CONCURRENCY);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.min(8, Math.max(2, os.availableParallelism()));
}

// The preflight runs on its own so a missing database is still one clear
// message instead of two hundred, before the runner spawns.
const preflight = await spawnAndWait(process.execPath, ['test/preflight.mjs']);
if (preflight !== 0) process.exit(preflight);

await dropClones(isStaleClone);
await migrateTemplate();

const limit = concurrency();
// A download records its event with a fire-and-forgotten insert (metrics must
// not hold up the download). Under Node's runner that detached promise can
// leave the file's harness waiting at exit, which hangs the whole run instead
// of failing it. `--test-force-exit` lets each file's root test exit once its
// tests and hooks are done, regardless of that leftover. It only fires after
// the file is finished, so no result is lost.
const code = await spawnAndWait(
  process.execPath,
  ['--test', '--test-force-exit', `--test-concurrency=${limit}`, 'test/*.test.js'],
  {
    env: {
      ...process.env,
      TWEXTHUB_TEST_ISOLATED: limit > 1 ? '1' : '0',
      TWEXTHUB_TEST_RUN_ID: RUN_ID,
    },
  },
);

await dropClones(isOwnClone);
process.exit(code);
