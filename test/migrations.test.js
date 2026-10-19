// The migration bridge and the baseline are the one part of the server that
// cannot be exercised against the shared test database: they decide what happens
// to a database's history, and every test in the suite would be affected by the
// answer. Each test here builds its own database, runs the bridge against it,
// and drops it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createDb, runMigrations } from '../src/db.js';
import { makeConfig, TEST_DATABASE_URL } from './helpers.mjs';

const SCRATCH = 'twexthub_migrate_test';

function urlFor(database) {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function legacyFiles() {
  const dir = path.join(import.meta.dirname, '..', 'migrations');
  return (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
}

// The runner the server used before Prisma Migrate: apply each file in order and
// record its name. Reproducing it here is what makes the adoption tests a real
// legacy database rather than a table of names.
async function applyLegacyMigrations(db, files) {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const dir = path.join(import.meta.dirname, '..', 'migrations');
  for (const name of files) {
    await db.$executeRawUnsafe(await readFile(path.join(dir, name), 'utf8'));
    await db.$executeRaw`INSERT INTO schema_migrations (version) VALUES (${name})`;
  }
}

async function withScratchDatabase(run) {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await admin.end();

  const config = makeConfig({ database: { url: urlFor(SCRATCH) } });
  const db = createDb(config);
  try {
    await run(db, config);
  } finally {
    await db.$disconnect();
    const cleanup = new pg.Client({ connectionString: urlFor('postgres') });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await cleanup.end();
  }
}

test('the baseline builds the objects the application depends on', async () => {
  await withScratchDatabase(async (db, config) => {
    await runMigrations(db, config);

    const tables = (
      await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    ).map((row) => row.tablename);
    for (const table of [
      'Versions',
      'Users',
      'DistTags',
      'WebhookDeliveries',
      'ExtensionOwnerInvites',
      'ExtensionTransfers',
      'OidcFlows',
      'ExtensionDailyDownloads',
    ]) {
      assert.ok(tables.includes(table), `the baseline should create ${table}`);
    }

    // The trigram index is the one object the baseline cannot create without
    // its extension, and the extension has to be enabled before the index.
    const [{ installed }] = await db.$queryRaw`
      SELECT count(*)::int AS installed FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    assert.equal(installed, 1, 'pg_trgm is enabled by the baseline');
    const trigram = await db.$queryRaw`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'versions_search_text_trgm_idx'
    `;
    assert.equal(trigram.length, 1, 'the trigram index exists');
    assert.match(trigram[0].indexdef, /USING gin \("SearchText" gin_trgm_ops\)/);

    // Partial indexes: one plain, one unique.
    const partial = (
      await db.$queryRaw`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
      `
    ).map((row) => row.indexname);
    for (const index of ['versions_public_listing_idx', 'notifications_unread_idx']) {
      assert.ok(partial.includes(index), `${index} should be a partial index`);
    }
    const [{ pending }] = await db.$queryRaw`
      SELECT count(*)::int AS pending FROM pg_indexes WHERE indexname = 'versions_one_pending_idx'
    `;
    assert.equal(pending, 1, 'the one-pending-version index exists');

    // Named CHECK constraints, which Prisma cannot model and the baseline has to
    // carry itself.
    const checks = (
      await db.$queryRaw`
        SELECT conname FROM pg_constraint
        WHERE contype = 'c' AND connamespace = 'public'::regnamespace
      `
    ).map((row) => row.conname);
    for (const constraint of [
      'versions_status_check',
      'users_kind_check',
      'users_role_check',
      'users_password_matches_kind',
      'notifications_kind_check',
    ]) {
      assert.ok(checks.includes(constraint), `${constraint} should exist`);
    }
    // The check has to be enforced, not just present: an organization with a
    // password is exactly what `users_password_matches_kind` refuses.
    await assert.rejects(
      db.$executeRaw`
        INSERT INTO "Users" ("Namespace", "PasswordHash", "DisplayName", "Kind")
        VALUES ('enforced', 'x', 'enforced', 'organization')
      `,
      /violates check constraint "users_password_matches_kind"/,
    );

    const [events] = await db.$queryRaw`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'Webhooks' AND column_name = 'Events'
    `;
    assert.equal(events.is_nullable, 'NO', 'webhooks.events is NOT NULL');

    // Deleting an account has to remove the owner row it added for itself. The
    // row is reached by two foreign keys and the order they were created in
    // decides which check runs first, so this is a behavioral assertion rather
    // than a name comparison.
    await db.$executeRaw`
      INSERT INTO "Users" ("Namespace", "PasswordHash", "DisplayName") VALUES ('deleteme', 'x', 'deleteme')
    `;
    const [{ id }] = await db.$queryRaw`SELECT "Id" AS id FROM "Users" WHERE "Namespace" = 'deleteme'`;
    await db.$executeRaw`
      INSERT INTO "ExtensionOwners" ("OwnerId", "Namespace", "ExtensionId", "AddedBy")
      VALUES (${id}, 'deleteme', 'thing', ${id})
    `;
    await db.$executeRaw`DELETE FROM "Users" WHERE "Id" = ${id}`;
    const [{ remaining }] = await db.$queryRaw`
      SELECT count(*)::int AS remaining FROM "ExtensionOwners" WHERE "OwnerId" = ${id}
    `;
    assert.equal(remaining, 0, 'the owner row went with the account');

    // Sequence-backed ids.
    const [{ sequence }] = await db.$queryRaw`
      SELECT pg_get_serial_sequence('"Versions"', 'Id') AS sequence
    `;
    assert.ok(sequence, 'versions.id is backed by a sequence');

    // Retention: the functions and the triggers that call them.
    const functions = await db.$queryRaw`
        SELECT p.proname, pg_get_functiondef(p.oid) AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
      `;
    const notifications = functions.find((row) => row.proname === 'prune_notifications');
    assert.ok(notifications, 'prune_notifications exists');
    assert.match(notifications.body, /pg_advisory_xact_lock\(NEW\."UserId"\)/);
    assert.match(notifications.body, /OFFSET 200/);
    const deliveries = functions.find((row) => row.proname === 'prune_webhook_deliveries');
    assert.ok(deliveries, 'prune_webhook_deliveries exists');
    assert.match(deliveries.body, /OFFSET 500/);

    const triggers = (
      await db.$queryRaw`
        SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = '"Notifications"'::regclass
      `
    ).map((row) => row.tgname);
    assert.ok(triggers.includes('notifications_prune'), 'the retention trigger is installed');
  });
});

test('a complete legacy history is adopted in place', async () => {
  await withScratchDatabase(async (db, config) => {
    const files = await legacyFiles();
    assert.equal(files.length, 29, 'the archive holds the 29 SQL migrations the releases wrote');
    await applyLegacyMigrations(db, files);
    await db.$executeRaw`
      INSERT INTO "Users" ("Namespace", "PasswordHash", "DisplayName")
      VALUES ('sentinel', 'x', 'sentinel')
    `;

    await runMigrations(db, config);

    const applied = await db.$queryRaw`
      SELECT migration_name FROM _prisma_migrations ORDER BY migration_name
    `;
    assert.deepEqual(
      applied.map((row) => row.migration_name),
      ['0_baseline', '1_version_download_metrics', '2_pascal_case'],
      'the baseline is recorded as applied, without its DDL running again',
    );
    const [kept] = await db.$queryRaw`
      SELECT "Namespace" AS namespace FROM "Users" WHERE "Namespace" = 'sentinel'
    `;
    assert.equal(kept.namespace, 'sentinel', 'the existing rows are untouched');
    // The migrated database is the one the application queries.
    assert.equal(await db.Versions.count(), 0);
  });
});

test('a history that stops before the download rollup is adopted and gets the table', async () => {
  await withScratchDatabase(async (db, config) => {
    // The last release before the Prisma conversion shipped 0028 and earlier;
    // 0029 only ever existed in the Prisma flow, so a database adopted from that
    // release must have the rollup created for it rather than required of it.
    const files = (await legacyFiles()).filter(
      (name) => name !== '0029_version_download_metrics.sql',
    );
    assert.equal(files.length, 28, 'the pre-Prisma release shipped 28 SQL migrations');
    await applyLegacyMigrations(db, files);

    await runMigrations(db, config);

    const applied = await db.$queryRaw`
      SELECT migration_name FROM _prisma_migrations ORDER BY migration_name
    `;
    assert.deepEqual(
      applied.map((row) => row.migration_name),
      ['0_baseline', '1_version_download_metrics', '2_pascal_case'],
      'the baseline is marked applied and the rollup is run after it',
    );
    const [{ present }] = await db.$queryRaw`
      SELECT count(*)::int AS present FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'ExtensionVersionDailyDownloads'
    `;
    assert.equal(present, 1, 'Prisma Migrate created the per-version download rollup');
  });
});

test('a partial legacy history is refused before anything is written', async () => {
  await withScratchDatabase(async (db, config) => {
    const files = (await legacyFiles()).slice(0, 3);
    await applyLegacyMigrations(db, files);

    await assert.rejects(
      runMigrations(db, config),
      /pre-Prisma upgrade error/,
      'three of the legacy migrations cannot be adopted',
    );
    const recorded = await db.$queryRaw`SELECT migration_name FROM _prisma_migrations`;
    assert.equal(recorded.length, 0, 'the refusal leaves no history behind');
  });
});

test('two bootstraps racing for one database serialize', async () => {
  await withScratchDatabase(async (db, config) => {
    const peer = createDb(config);
    try {
      await Promise.all([runMigrations(db, config), runMigrations(peer, config)]);
    } finally {
      await peer.$disconnect();
    }
    const applied = await db.$queryRaw`
      SELECT migration_name FROM _prisma_migrations ORDER BY migration_name
    `;
    assert.deepEqual(
      applied.map((row) => row.migration_name),
      ['0_baseline', '1_version_download_metrics', '2_pascal_case'],
      'the baseline is applied exactly once',
    );
  });
});
