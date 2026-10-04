import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Set this to manage the key yourself (Kubernetes secret, config management);
// it is read once per process.
const KEY_ENV = 'TWEXTHUB_DOWNLOAD_HASH_KEY';

const resolved = new Map();

function keyFile(dataDir) {
  return path.join(dataDir, 'secrets', 'download-address.key');
}

function readKey(file) {
  const secret = readFileSync(file, 'utf8').trim();
  // An empty key is worse than no key: it would hash every address to the same
  // value and quietly answer nothing useful.
  if (secret.length === 0) throw new Error(`The download address key at ${file} is empty.`);
  return secret;
}

// A download address is hashed so the registry can count distinct clients
// without keeping the address, and that hash is worth nothing if the key sits
// next to it: one database dump would undo the whole point. The key therefore
// lives on disk, or wherever the operator keeps secrets, and never in a table.
export async function downloadAddressKey(sql, config) {
  const cached = resolved.get(config.dataDir);
  if (cached) return cached;

  const fromEnv = process.env[KEY_ENV];
  if (fromEnv) {
    resolved.set(config.dataDir, fromEnv);
    return fromEnv;
  }

  const file = keyFile(config.dataDir);
  let secret;
  let created = false;
  try {
    secret = readKey(file);
  } catch (error) {
    // Only a missing key is ours to create. An unreadable one is the operator's
    // problem to see, not a reason to rotate: rotating here would clear every
    // hash and hide the cause.
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(32).toString('base64url');
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      // Exclusive, so an instance starting at the same moment cannot overwrite
      // the key that hashes written a moment ago were made with.
      writeFileSync(file, `${secret}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      secret = readKey(file);
    }
  }

  if (created) {
    // Losing the key leaves hashes that cannot be compared with new ones, so
    // the rows that used it are cleared. The rollup still counts them; their
    // distinct counts fall back to the user agent.
    const stale = await sql`UPDATE download_events SET ip_hash = NULL WHERE ip_hash IS NOT NULL`;
    if (stale.count > 0) {
      console.log(`generated a new download address key; cleared ${stale.count} stale hashes`);
    }
  }

  resolved.set(config.dataDir, secret);
  return secret;
}
