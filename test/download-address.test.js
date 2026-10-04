import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, uniqNs } from './helpers.mjs';
import { downloadAddressKey } from '../src/download-address.js';

let sql;
before(async () => {
  ({ sql } = await boot());
});
after(async () => {
  await sql.end();
});

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-key-'));
}

function keyPath(dataDir) {
  return path.join(dataDir, 'secrets', 'download-address.key');
}

async function seedEvent(ipHash) {
  const ns = uniqNs();
  await sql`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, ip_hash)
    VALUES (${ns}, 'ext', '1.0.0', 'ua', ${ipHash})
  `;
  return ns;
}

test('the first download writes a private key file and clears incomparable hashes', async () => {
  const ns = await seedEvent('hash-from-a-key-that-is-gone');
  const dataDir = tempDataDir();

  const key = await downloadAddressKey(sql, { dataDir });
  assert.equal(key.length, 43);
  assert.equal(
    fs.statSync(keyPath(dataDir)).mode & 0o777,
    0o600,
    'the key file is not readable by anyone else',
  );
  const [row] = await sql`SELECT ip_hash FROM download_events WHERE namespace = ${ns}`;
  assert.equal(row.ip_hash, null, 'hashes made with the lost key are dropped');

  // The key is stable for the life of the data directory.
  assert.equal(await downloadAddressKey(sql, { dataDir }), key);
  assert.equal(fs.readFileSync(keyPath(dataDir), 'utf8').trim(), key);
});

test('a key file another instance wrote is reused, not replaced', async () => {
  const dataDir = tempDataDir();
  fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
  fs.writeFileSync(keyPath(dataDir), 'key-from-a-peer\n', { mode: 0o600 });

  assert.equal(await downloadAddressKey(sql, { dataDir }), 'key-from-a-peer');
});

test('two instances racing to create the key end up with the same one', async () => {
  const dataDir = tempDataDir();
  const [first, second] = await Promise.all([
    downloadAddressKey(sql, { dataDir }),
    downloadAddressKey(sql, { dataDir }),
  ]);
  assert.equal(first, second);
  assert.equal(fs.readFileSync(keyPath(dataDir), 'utf8').trim(), first);
});

test('an unreadable key file is reported instead of quietly rotated', async () => {
  const emptyDir = tempDataDir();
  fs.mkdirSync(keyPath(emptyDir), { recursive: true });
  await assert.rejects(() => downloadAddressKey(sql, { dataDir: emptyDir }), { code: 'EISDIR' });

  const emptyFile = tempDataDir();
  fs.mkdirSync(path.join(emptyFile, 'secrets'), { recursive: true });
  fs.writeFileSync(keyPath(emptyFile), '   \n');
  await assert.rejects(() => downloadAddressKey(sql, { dataDir: emptyFile }), /empty/);
});

test('an operator-supplied key is used as is', async () => {
  const dataDir = tempDataDir();
  process.env.TWEXTHUB_DOWNLOAD_HASH_KEY = 'operator-key';
  try {
    assert.equal(await downloadAddressKey(sql, { dataDir }), 'operator-key');
    assert.ok(!fs.existsSync(keyPath(dataDir)), 'no key file is written behind the operator');
  } finally {
    delete process.env.TWEXTHUB_DOWNLOAD_HASH_KEY;
  }
});
