import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BLOB_GC_LOCK_KEY, blobPathFor, removeBlobIfUnused, sha256Hex } from './blobs.js';

// Blob garbage collection: a file under blobs/ whose digest no row references is
// deleted. Sources are handled by removeSourceIfUnused at the call sites that
// already know the digest; this sweep only covers blobs so a crash between the
// DB delete and the file removal cannot strand bytes.
export async function gcBlobs(sql, dataDir) {
  const blobsDir = path.join(dataDir, 'blobs');

  // The transaction covers the two queries and nothing else. Nearly all of this
  // function is filesystem work, and holding a transaction open across it keeps
  // a read lock on versions for the length of the pass -- long enough to
  // deadlock against a TRUNCATE, which wants an exclusive lock on versions and
  // everything cascading from it. The advisory lock only keeps two instances off
  // the same directory at once. The unlink is a separate locked step per
  // candidate, so releasing it before the walk costs nothing.
  const referenced = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${BLOB_GC_LOCK_KEY}, 0))`;
    const known = await tx`SELECT DISTINCT blob_digest FROM versions WHERE blob_digest IS NOT NULL`;
    // Uploaded profile images share this store, so their digests have to be in
    // the referenced set too. Leaving them out would make every avatar on the
    // instance collectable the first time the sweep ran.
    const profiles = await tx`
      SELECT avatar_blob_digest AS digest, banner_blob_digest AS banner
      FROM users
      WHERE avatar_blob_digest IS NOT NULL OR banner_blob_digest IS NOT NULL
    `;
    const referenced = new Set(known.map((row) => row.blob_digest));
    for (const row of profiles) {
      if (row.digest) referenced.add(row.digest);
      if (row.banner) referenced.add(row.banner);
    }
    return referenced;
  });

  // A blob lands on disk before the versions row that references it, so a file
  // younger than an hour may still belong to a publish in flight. Leave those
  // to the next pass rather than deleting them out from under it.
  const cutoff = Date.now() - 60 * 60 * 1000;

  let removed = 0;
  let prefixes;
  try {
    prefixes = await readdir(blobsDir, { withFileTypes: true });
  } catch (error) {
    // Nothing has ever been published here, so there is nothing to sweep.
    if (error.code !== 'ENOENT') throw error;
    return 0;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue;
    const prefixDir = path.join(blobsDir, prefix.name);
    for (const rest of await readdir(prefixDir)) {
      const digest = prefix.name + rest;
      if (referenced.has(digest)) continue;
      const abs = path.join(prefixDir, rest);
      const info = await stat(abs).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      // The snapshot above was taken under the lock, but the walk that follows
      // it is not, and a publish can claim an aged file in between. The final
      // check and the unlink both happen under the lock in the helper, so a
      // digest that gained a reference since the snapshot is kept.
      if (await removeBlobIfUnused(sql, { dataDir }, digest, null)) {
        removed += 1;
      }
    }
  }
  return removed;
}

// Verify every referenced blob against its stored digest. Missing or
// mismatched files are reported, not deleted: the database row is the source
// of truth for what should exist, so the operator decides what to do.
// Registered integrity failures are exported through
// twexthub_storage_integrity_errors.
let integrityErrorCount = 0;

export function getIntegrityErrors() {
  return integrityErrorCount;
}

export async function scrubBlobs(sql, dataDir) {
  const rows = await sql`
    SELECT DISTINCT ON (blob_digest) namespace, extension_id, version, blob_digest
    FROM versions
    WHERE blob_digest IS NOT NULL AND status <> 'staging'
    ORDER BY blob_digest, id DESC
  `;

  // Counted locally so a scrape partway through a long pass does not read a
  // half-finished tally.
  let errors = 0;
  const problems = [];
  for (const row of rows) {
    const abs = blobPathFor(dataDir, row.blob_digest);
    let actual;
    try {
      actual = sha256Hex(await readFile(abs));
    } catch {
      errors += 1;
      problems.push({ ...row, problem: 'missing' });
      continue;
    }
    if (actual !== row.blob_digest) {
      errors += 1;
      problems.push({ ...row, problem: 'mismatch' });
    }
  }
  integrityErrorCount = errors;
  return problems;
}

export function makeMaintenanceJob({ sql, config }) {
  let timer = null;
  let running = false;

  const gcIntervalMs = 6 * 60 * 60 * 1000;
  const scrubIntervalMs = 24 * 60 * 60 * 1000;
  let lastScrub = 0;

  // The startup pass sweeps orphaned files as soon as the process is up, but it
  // skips the scrub. A scrub that early can read a version row whose blob is
  // still being written and report the file missing, which puts a false error in
  // the integrity metric on every boot. The first scheduled tick still scrubs.
  const tick = async ({ gcOnly = false } = {}) => {
    if (running) return;
    running = true;
    try {
      const removed = await gcBlobs(sql, config.dataDir);
      if (removed > 0) console.log(`blob gc removed ${removed} orphaned file(s)`);

      if (!gcOnly && Date.now() - lastScrub >= scrubIntervalMs) {
        lastScrub = Date.now();
        const problems = await scrubBlobs(sql, config.dataDir);
        for (const problem of problems) {
          console.warn(
            `blob integrity ${problem.problem}: ${problem.namespace}/${problem.extension_id}@${problem.version}`,
          );
        }
      }
    } catch (error) {
      console.error('maintenance job failed:', error.message);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      void tick({ gcOnly: true });
      timer = setInterval(tick, gcIntervalMs);
      timer.unref?.();
      return this;
    },
    async stop() {
      if (timer) clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    },
    // Convenience for tests and tooling: run one pass immediately.
    async runOnce() {
      await tick();
    },
  };
}
