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
import postgres from 'postgres';
import { BLOB_GC_LOCK_KEY, blobPathFor, hashFile, sha512Base64 } from './blobs.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(moduleDir, '..', 'migrations');

export function createDb(config) {
  const sql = postgres(config.database.url, {
    max: config.database.maxConnections,
    connect_timeout: config.database.connectTimeoutSeconds,
    idle_timeout: config.database.idleTimeoutSeconds,
    onnotice: () => {},
  });
  return sql;
}

export async function runMigrations(sql, migrationsDir = MIGRATIONS_DIR) {
  const files = readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(32001)`;

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedRows = await tx`SELECT version FROM schema_migrations`;
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(path.join(migrationsDir, file), 'utf8');
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    }
  });
}

export async function reconcileOnBoot(sql, config) {
  const dataDir = config.dataDir;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(32002)`;
    const staging = await tx`
      SELECT * FROM versions
      WHERE status = 'staging' AND created_at < now() - interval '1 hour'
    `;
    for (const row of staging) {
      const blobAbs = path.join(dataDir, row.blob_path);
      const sourceAbs = row.source_path ? path.join(dataDir, row.source_path) : null;
      const complete = existsSync(blobAbs) && (!sourceAbs || existsSync(sourceAbs));
      if (complete) {
        // The namespace account decides the status, same as the live publish
        // path: a delegated publisher's own history says nothing about whether
        // this namespace still goes through review.
        const [account] =
          await tx`SELECT has_published FROM users WHERE namespace = ${row.namespace}`;
        const status = account?.has_published ? 'published' : 'pending';
        await tx`
          UPDATE versions
          SET status = ${status}, published_at = ${status === 'published' ? new Date() : null}
          WHERE id = ${row.id}
        `;
        console.log(
          `reconciled staging version ${row.namespace}/${row.extension_id}@${row.version} -> ${status}`,
        );
      } else {
        // The charge committed with the staging row, so dropping the row has to
        // give the bytes back the delete path would refund.
        const charge = Number(row.blob_size ?? 0) + Number(row.source_size ?? 0);
        if (charge > 0) {
          await tx`
            UPDATE users SET blob_bytes = GREATEST(blob_bytes - ${charge}, 0)
            WHERE namespace = ${row.namespace}
          `;
        }
        await tx`DELETE FROM versions WHERE id = ${row.id}`;
        console.log(
          `removed staging version ${row.namespace}/${row.extension_id}@${row.version} (blob or source missing)`,
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
  await sql`DELETE FROM rate_limit_entries WHERE window_start < ${rateCutoff}`;

  await sql`DELETE FROM sessions WHERE expires_at < now()`;

  // Pre-digest rows (published before the blob_digest migration) point at
  // legacy namespace/blob paths. Re-key them to content-addressed digests so
  // the whole table can be served from /blobs/:digest and evicted by GC.
  //
  // Two instances starting at once would select the same rows and then race on
  // the same files, so the pass runs under the blob GC lock and picks its rows
  // only once it holds it: by then a peer has finished and written their
  // digests, and those rows no longer match.
  const legacyPaths = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${BLOB_GC_LOCK_KEY}, 0))`;
    const legacy = await tx`
      SELECT * FROM versions
      WHERE blob_digest IS NULL AND status IN ('published', 'yanked', 'deprecated')
    `;
    for (const row of legacy) {
      const legacyPath = path.join(dataDir, row.blob_path);
      let digest;
      try {
        digest = await hashFile(legacyPath);
      } catch {
        console.warn(
          `indexing skipped for ${row.namespace}/${row.extension_id}@${row.version}: missing blob`,
        );
        continue;
      }
      const codeBuffer = readFileSync(legacyPath);
      const digestAbs = blobPathFor(dataDir, digest);
      // The shard for a digest that has never been stored is not there yet, and
      // nothing else in the data directory creates it.
      mkdirSync(path.dirname(digestAbs), { recursive: true });
      await copyFile(legacyPath, digestAbs);
      await tx`
        UPDATE versions
        SET blob_digest = ${digest},
            blob_size = ${codeBuffer.length},
            blob_sha512 = ${sha512Base64(codeBuffer)},
            blob_path = ${path.join('blobs', digest.slice(0, 2), digest.slice(2))}
      WHERE id = ${row.id}
      `;
      if (legacyPath !== digestAbs) {
        legacyPaths.push(legacyPath);
      }
    }
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
