import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Prisma, PrismaClient } from '../prisma/generated/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadConfig } from './config.js';
import { BLOB_GC_LOCK_KEY, blobPathFor, hashFile, sha512Base64 } from './blobs.js';
import {
  TRANSACTION_MAX_WAIT_MS,
  TRANSACTION_TIMEOUT_MS,
  acquireAdvisoryLocks,
  withLocks,
} from './locks.js';

export { acquireAdvisoryLocks, withLocks };

// The lock every bootstrap serializes on before it decides how the database's
// migration history is adopted. Held across the CLI run, so two instances
// starting at once run `prisma migrate deploy` one after the other.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// The CLI is launched as a Node script through the interpreter already running
// the server, resolved from the project's own dependencies. Spawning `npx`
// instead would search PATH for a package and could run a different Prisma or
// download one, and the platform's npx shim is not guaranteed to be present in
// a container.
const projectRequire = createRequire(import.meta.url);
const PRISMA_CLI = projectRequire.resolve('prisma/build/index.js');
const MIGRATE_LOCK_KEY = 32001;
// Serializes the boot-time cleanup pass (staging rows, expiry sweeps, legacy
// blob re-keying) so a second instance does not race the first over the same
// rows and files.
export const RECONCILE_LOCK_KEY = 32002;

// `prisma migrate deploy` boots a CLI, generates its client, and applies the
// baseline: the transaction that serializes it has to outlast all of that.
const MIGRATION_TIMEOUT_MS = 600_000;

export function createDb(config) {
  const adapter = new PrismaPg({
    connectionString: config.database.url,
    max: config.database.maxConnections,
    connectionTimeoutMillis: config.database.connectTimeoutSeconds * 1000,
    idleTimeoutMillis: config.database.idleTimeoutSeconds * 1000,
    // Prisma turns a timestamptz into a Date by re-parsing the text the server
    // rendered, and that parser drops the offset. On a server whose `timezone`
    // is not UTC every timestamp then comes back shifted by that offset, so
    // the session is pinned rather than left to the server's default.
    options: '-c timezone=UTC',
  });
  return new PrismaClient({
    adapter,
    transactionOptions: {
      maxWait: TRANSACTION_MAX_WAIT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  });
}

// postgres.js handed back int8 as a string and kept numeric columns as strings;
// the Prisma driver returns BigInt and Decimal objects instead. Response shapes
// were built against the string forms, and a raw row holding a BigInt throws the
// moment it reaches JSON.stringify, so raw results are folded back.
export function normalizeValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = normalizeValue(inner);
    return out;
  }
  return value;
}

export function normalizeRows(rows) {
  return rows.map(normalizeValue);
}

// A unique-index violation, told apart from every other database error so the
// callers that answer with a 409 can do so. Typed writes surface it as P2002;
// raw statements surface the same condition as P2010 wrapping the driver's
// 23505. Either way the offending index name is what callers classify on, and
// when only the fields are known they are returned as a sorted list so callers
// can still match on them.
export function uniqueViolation(error) {
  const driver = error?.meta?.driverAdapterError?.cause;
  if (error?.code === 'P2002') {
    const constraint = driver?.constraint?.index ?? null;
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target : target ? [target] : null;
    return { constraint, fields };
  }
  if (error?.code === 'P2010' && driver?.originalCode === '23505') {
    return { constraint: driver.constraint?.index ?? null, fields: null };
  }
  if (error?.code === '23505' || driver?.kind === 'UniqueConstraintViolation') {
    return { constraint: driver?.constraint?.index ?? error?.constraint ?? null, fields: null };
  }
  return null;
}

// The SQL migrations the pre-Prisma releases shipped. A database whose
// `schema_migrations` holds every one of these is adopted by recording the
// baseline as applied. Migrations that were only ever carried by the Prisma
// flow (such as the per-version download rollup that became
// `1_version_download_metrics`) are deliberately absent: Prisma applies them
// after adoption, so a database that stopped at the last SQL release is brought
// up to date instead of refused.
const LEGACY_MIGRATIONS = [
  '0001_init.sql',
  '0002_pruning.sql',
  '0003_search_trgm.sql',
  '0004_query_indexes.sql',
  '0005_notifications.sql',
  '0006_blob_digest.sql',
  '0007_deprecated.sql',
  '0008_dist_tags.sql',
  '0009_download_metrics.sql',
  '0010_extension_owners.sql',
  '0011_owner_notifications.sql',
  '0012_webhooks.sql',
  '0013_profiles.sql',
  '0014_private_quotas_audit.sql',
  '0015_build_on_publish.sql',
  '0016_hardening_indexes.sql',
  '0017_download_address_hash.sql',
  '0018_webhook_delivery_lease.sql',
  '0019_profile_images.sql',
  '0020_organizations.sql',
  '0021_global_webhooks.sql',
  '0022_organization_notifications.sql',
  '0023_extension_owner_invites.sql',
  '0024_extension_transfers.sql',
  '0025_drop_private_extensions.sql',
  '0026_version_is_unsandboxed.sql',
  '0027_oidc.sql',
  '0028_version_warnings.sql',
];

const BASELINE_MIGRATION = '0_baseline';

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [PRISMA_CLI, ...args, '--config', 'prisma.config.mjs'], {
      cwd: path.join(moduleDir, '..'),
      env,
      stdio: 'inherit',
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma ${args.join(' ')} exited with code ${code}`));
    });
  });
}

// Adopts the database onto Prisma Migrate, then applies it. A database that
// already ran every one of the legacy SQL files has no `_prisma_migrations` row
// for the baseline, so the baseline is marked applied rather than run; a partial
// history is one this bridge cannot stand behind and is rejected before anything
// is written. Any migration the baseline build added afterwards (the per-version
// download rollup) is left for `migrate deploy` to apply, so adopting a database
// that predates it brings the table in rather than skipping it.
export async function runMigrations(db, config = loadConfig()) {
  const env = { ...process.env, DATABASE_URL: config.database.url };

  // The history tables are created under the lock, in a transaction of their
  // own, and committed before the CLI runs. Two things make that necessary.
  // Creating a table takes an ACCESS EXCLUSIVE lock on it, and holding that
  // while the CLI runs deadlocks: the CLI reads and writes `_prisma_migrations`
  // and waits there forever. And two instances booting at once cannot both run
  // `CREATE TABLE IF NOT EXISTS` for the same name — Postgres answers one of
  // them with a duplicate key error on `pg_type` rather than creating nothing.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK_KEY}::bigint)::text`;
    // `schema_migrations` was the snake_case name this table carried before
    // #43; a database being adopted has it, so it is folded into the PascalCase
    // name once, under the lock, before anything reads it.
    await tx.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF to_regclass('public.schema_migrations') IS NOT NULL
           AND to_regclass('public."SchemaMigrations"') IS NULL THEN
          ALTER TABLE "public"."schema_migrations" RENAME TO "SchemaMigrations";
          ALTER TABLE "public"."SchemaMigrations" RENAME COLUMN "version" TO "Version";
          ALTER TABLE "public"."SchemaMigrations" RENAME COLUMN "applied_at" TO "AppliedAt";
        END IF;
      END
      $$
    `);
    await tx.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SchemaMigrations" (
        "Version" TEXT PRIMARY KEY,
        "AppliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        finished_at TIMESTAMPTZ,
        migration_name TEXT NOT NULL,
        logs TEXT,
        rolled_back_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_steps_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  });

  await db.$transaction(
    async (tx) => {
      // `::text` because the lock function returns void, which the client
      // cannot deserialize.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK_KEY}::bigint)::text`;
      const legacyRows = await tx.$queryRaw`SELECT "Version" FROM "SchemaMigrations"`;
      const legacySet = new Set(normalizeRows(legacyRows).map((r) => r.Version));
      const prismaRows = await tx.$queryRaw`SELECT migration_name FROM _prisma_migrations`;
      const prismaSet = new Set(normalizeRows(prismaRows).map((r) => r.migration_name));

      if (prismaSet.size === 0 && legacySet.size > 0) {
        const complete = LEGACY_MIGRATIONS.every((name) => legacySet.has(name));
        if (!complete) {
          throw new Error(
            'pre-Prisma upgrade error: the database has a partial legacy migration history; ' +
              `every one of the ${LEGACY_MIGRATIONS.length} migrations must be present before adopting Prisma Migrate.`,
          );
        }
        // Marking the baseline applied records the history Prisma would have
        // written had the baseline been the migration that built the schema,
        // without re-running DDL against tables that already exist.
        await runCli(['migrate', 'resolve', '--applied', BASELINE_MIGRATION], env);
      }

      await runCli(['migrate', 'deploy'], env);
    },
    { timeout: MIGRATION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );
}

export async function reconcileOnBoot(db, config) {
  const dataDir = config.dataDir;
  const stagingCutoff = new Date(Date.now() - 3600_000);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${RECONCILE_LOCK_KEY}::bigint)::text`;
    const staging = await tx.Versions.findMany({
      where: { Status: 'staging', CreatedAt: { lt: stagingCutoff } },
    });
    for (const row of staging) {
      const blobAbs = path.join(dataDir, row.BlobPath);
      const sourceAbs = row.SourcePath ? path.join(dataDir, row.SourcePath) : null;
      const complete = existsSync(blobAbs) && (!sourceAbs || existsSync(sourceAbs));
      if (complete) {
        // The namespace account decides the status, same as the live publish
        // path: a delegated publisher's own history says nothing about whether
        // this namespace still goes through review.
        const account = await tx.Users.findUnique({
          where: { Namespace: row.Namespace },
          select: { HasPublished: true },
        });
        const status = account?.HasPublished ? 'published' : 'pending';
        await tx.Versions.update({
          where: { Id: row.Id },
          data: {
            Status: status,
            PublishedAt: status === 'published' ? new Date() : null,
          },
        });
        console.log(
          `reconciled staging version ${row.Namespace}/${row.ExtensionId}@${row.Version} -> ${status}`,
        );
      } else {
        // The charge committed with the staging row, so dropping the row has to
        // give the bytes back the delete path would refund.
        const charge = Number(row.BlobSize ?? 0) + Number(row.SourceSize ?? 0);
        if (charge > 0) {
          await tx.$executeRaw`
            UPDATE "Users" SET "BlobBytes" = GREATEST("BlobBytes" - ${charge}, 0)
            WHERE "Namespace" = ${row.Namespace}
          `;
        }
        await tx.Versions.delete({ where: { Id: row.Id } });
        console.log(
          `removed staging version ${row.Namespace}/${row.ExtensionId}@${row.Version} (blob or source missing)`,
        );
      }
    }
  });

  const tmpDir = path.join(dataDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const cutoff = Date.now() - 3600_000;
  for (const entry of readdirSync(tmpDir)) {
    const entryPath = path.join(tmpDir, entry);
    try {
      const st = statSync(entryPath);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(entryPath);
    } catch {
      // another process may have already removed it
    }
  }

  const quarantineDir = path.join(dataDir, 'quarantine');
  mkdirSync(quarantineDir, { recursive: true });
  for (const entry of readdirSync(quarantineDir, { withFileTypes: true })) {
    const entryPath = path.join(quarantineDir, entry.name);
    try {
      const st = statSync(entryPath);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // another process may have already removed it
    }
  }

  const maxWindow = Math.max(
    config.rateLimits.loginWindowMinutes,
    config.rateLimits.signupWindowMinutes,
  );
  const rateCutoff = new Date(Date.now() - maxWindow * 60_000);
  await db.RateLimitEntries.deleteMany({ where: { WindowStart: { lt: rateCutoff } } });

  const now = new Date();
  await db.Sessions.deleteMany({ where: { ExpiresAt: { lt: now } } });
  await db.OidcFlows.deleteMany({ where: { ExpiresAt: { lt: now } } });

  // Pre-digest rows (published before the blob_digest migration) point at
  // legacy namespace/blob paths. Re-key them to content-addressed digests so
  // the whole table can be served from /blobs/:digest and evicted by GC.
  //
  // Two instances starting at once would select the same rows and then race on
  // the same files, so the pass runs under the blob GC lock and picks its rows
  // only once it holds it: by then a peer has finished and written their
  // digests, and those rows no longer match.
  const legacyPaths = await withLocks(db, [BLOB_GC_LOCK_KEY], async (tx) => {
    const paths = [];
    const legacy = await tx.Versions.findMany({
      where: { BlobDigest: null, Status: { in: ['published', 'yanked', 'deprecated'] } },
    });
    for (const row of legacy) {
      const legacyPath = path.join(dataDir, row.BlobPath);
      let digest;
      try {
        digest = await hashFile(legacyPath);
      } catch {
        console.warn(
          `indexing skipped for ${row.Namespace}/${row.ExtensionId}@${row.Version}: missing blob`,
        );
        continue;
      }
      const codeBuffer = readFileSync(legacyPath);
      const digestAbs = blobPathFor(dataDir, digest);
      // The shard for a digest that has never been stored is not there yet, and
      // nothing else in the data directory creates it.
      mkdirSync(path.dirname(digestAbs), { recursive: true });
      await copyFile(legacyPath, digestAbs);
      await tx.Versions.update({
        where: { Id: row.Id },
        data: {
          BlobDigest: digest,
          BlobSize: codeBuffer.length,
          BlobSha512: sha512Base64(codeBuffer),
          BlobPath: path.join('blobs', digest.slice(0, 2), digest.slice(2)),
        },
      });
      if (legacyPath !== digestAbs) {
        paths.push(legacyPath);
      }
    }
    return paths;
  });
  for (const legacyPath of legacyPaths) {
    await rm(legacyPath, { force: true });
  }
}

export function ensureDataDirs(dataDir) {
  mkdirSync(path.join(dataDir, 'blobs'), { recursive: true });
  mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(dataDir, 'quarantine'), { recursive: true });
}
