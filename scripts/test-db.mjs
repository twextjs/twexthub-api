// Creates the test database if it is missing. `docker compose up` creates the
// POSTGRES_DB on first boot only, and a volume that predates a rename of that
// database (or a container reused across checkouts) can be healthy without the
// database the suite wants, so this is idempotent rather than assumed.
//
// The container name comes from compose.test.yml; the command runs
// inside it, so no client library or local psql is needed on the host.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CONTAINER = 'twexthub-pg';
const DATABASE = 'twexthub_test';

const psql = async (...args) =>
  (await run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', ...args]))
    .stdout;

const existing = await psql(
  '-tAc',
  `SELECT 1 FROM pg_database WHERE datname = '${DATABASE}'`,
).catch((error) => {
  console.error(`Could not talk to the ${CONTAINER} container: ${error.message}`);
  console.error('Is it running? `npm run test:setup` starts it.');
  process.exit(1);
});

if (existing.trim() === '1') {
  console.log(`${DATABASE} already exists.`);
} else {
  await psql('-c', `CREATE DATABASE ${DATABASE}`);
  console.log(`Created ${DATABASE}.`);
}
