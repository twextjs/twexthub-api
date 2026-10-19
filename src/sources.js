import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BLOB_GC_LOCK_KEY, sha256Hex } from './blobs.js';
import { withLocks } from './locks.js';

// Sources are keyed by digest just like blobs, so identical tarballs share one
// file. Addressed as sources/<first two hex chars>/<rest> for fan-out.
// Publication and cleanup coordinate through BLOB_GC_LOCK_KEY: publishers hold
// the shared lock from storing the file until the referencing row commits, and
// removeSourceIfUnused holds the exclusive lock across the keeper check and the
// unlink — the same discipline the blob path follows.
export function sourcePathFor(dataDir, digest) {
  return path.join(dataDir, 'sources', digest.slice(0, 2), digest.slice(2));
}

export async function storeSource(dataDir, buffer) {
  const digest = sha256Hex(buffer);
  const abs = sourcePathFor(dataDir, digest);
  await mkdir(path.dirname(abs), { recursive: true });
  // Write to a same-directory temporary file and rename, so a concurrent
  // reader can never observe a half-written source and a crash cannot leave
  // a truncated file under the final name.
  const staged = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  try {
    await writeFile(staged, buffer);
    await rename(staged, abs);
  } finally {
    await rm(staged, { force: true });
  }
  return { path: path.relative(dataDir, abs), digest, size: buffer.length };
}

// The keeper check and the unlink, without taking the GC lock: for callers that
// already hold it across a delete and the cleanup that follows it.
export async function removeSourceIfUnusedInTx(tx, config, digest) {
  if (!digest) return;
  const keeper = await tx.Versions.findFirst({
    where: { SourceDigest: digest },
    select: { Id: true },
  });
  if (keeper) return;
  try {
    await unlink(sourcePathFor(config.dataDir, digest));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function removeSourceIfUnused(db, config, digest) {
  if (!digest) return;
  await withLocks(db, [BLOB_GC_LOCK_KEY], (tx) => removeSourceIfUnusedInTx(tx, config, digest));
}
