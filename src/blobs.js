import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withLocks } from './locks.js';

export const BLOB_GC_LOCK_KEY = 'blob-gc';

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

export function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (error) => {
      // Both the stream and the hash must stop on failure; an abandoned hash
      // would otherwise keep buffering a file that is being replaced.
      hash.destroy();
      stream.destroy();
      reject(error);
    });
  });
}

// Blobs are keyed by digest so identical publishes share one file on disk.
// The digest is addressed as blobs/<first two hex chars>/<rest> to keep
// directory fan-out low. Callers must pass a digest that was computed by
// sha256Hex or matched against /^[0-9a-f]{64}$/ — never a raw request value.
export function blobPathFor(dataDir, digest) {
  return path.join(dataDir, 'blobs', digest.slice(0, 2), digest.slice(2));
}

async function readSize(abs) {
  try {
    return Number((await stat(abs)).size);
  } catch {
    return null;
  }
}

export async function storeBlob(dataDir, tmpPath, buffer) {
  const digest = sha256Hex(buffer);
  const abs = blobPathFor(dataDir, digest);
  await mkdir(path.dirname(abs), { recursive: true });
  const existing = await readSize(abs);
  if (existing === buffer.length) {
    try {
      if ((await hashFile(abs)) === digest) {
        // Refresh the reuse window against gcBlobs, which skips recent files.
        const now = new Date();
        await utimes(abs, now, now);
        return { digest, abs, size: buffer.length, sha512: sha512Base64(buffer) };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const staged = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  try {
    await copyFile(tmpPath, staged);
    await rename(staged, abs);
  } finally {
    await rm(staged, { force: true });
  }
  return { digest, abs, size: buffer.length, sha512: sha512Base64(buffer) };
}

// For callers that already hold the bytes and have no tmp file of their own.
// storeBlob stages through a path so a large publish upload can be streamed to
// disk once and moved into place; a body that is already in memory just needs
// somewhere to land before the same rename.
export async function storeBlobBuffer(dataDir, buffer) {
  const tmpPath = path.join(dataDir, 'tmp', `blob-${randomUUID()}.tmp`);
  await mkdir(path.dirname(tmpPath), { recursive: true });
  try {
    await writeFile(tmpPath, buffer);
    return await storeBlob(dataDir, tmpPath, buffer);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

// Deletes a blob file when nothing references its digest. Runs under the
// exclusive GC advisory lock so a publish of the same digest cannot be
// mid-flight: publishers hold the shared lock from before storeBlob until the
// version promotion commits, so cleanup either sees the new version row (and
// keeps the file) or completes before the publisher re-creates it.
//
// The reference check covers profile images as well as versions, because the
// store is shared and content-addressed: a digest an account's avatar points at
// is a live blob, and a caller that only knows about versions would free it
// underneath the account. The sweep's snapshot asks the same question, so a
// digest that was unreferenced a moment ago and has been claimed since is kept
// rather than deleted out from under its new owner.
//
// Resolves to true when the file was removed, false when it was kept or was
// already gone. Callers that report how much they collected need the difference.
// The keeper check and the unlink, without taking the GC lock: for callers that
// already hold it and must keep it across a delete and the filesystem cleanup
// that follows it. `tx` is the client or an interactive-transaction client.
export async function removeBlobIfUnusedInTx(tx, config, digest, exceptId) {
  if (!digest) return false;
  // `id != NULL` is never true in SQL, so a null exceptId has to drop the
  // clause entirely rather than filter on it.
  const keeper = await tx.versions.findFirst({
    where: {
      blob_digest: digest,
      ...(exceptId === null || exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (keeper) return false;
  const profile = await tx.users.findFirst({
    where: { OR: [{ avatar_blob_digest: digest }, { banner_blob_digest: digest }] },
    select: { id: true },
  });
  if (profile) return false;
  try {
    await unlink(blobPathFor(config.dataDir, digest));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

export async function removeBlobIfUnused(db, config, digest, exceptId) {
  if (!digest) return false;
  return withLocks(db, [BLOB_GC_LOCK_KEY], (tx) =>
    removeBlobIfUnusedInTx(tx, config, digest, exceptId),
  );
}
