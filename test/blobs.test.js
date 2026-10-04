import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { blobPathFor, storeBlob } from '../src/blobs.js';

test('storeBlob replaces a same-size blob with the wrong digest', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'twexthub-blob-'));
  const tmpPath = path.join(dataDir, 'upload');
  const buffer = Buffer.from('expected bytes');
  try {
    await writeFile(tmpPath, buffer);
    const { digest, abs } = await storeBlob(dataDir, tmpPath, buffer);
    assert.equal(abs, blobPathFor(dataDir, digest));

    await writeFile(abs, Buffer.from('corrupt! bytes'));
    assert.equal((await readFile(abs)).length, buffer.length);
    await storeBlob(dataDir, tmpPath, buffer);

    assert.deepEqual(await readFile(abs), buffer);
    assert.deepEqual(await readdir(path.dirname(abs)), [path.basename(abs)]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
