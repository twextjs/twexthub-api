import { createHash, randomBytes } from 'node:crypto';
import { product } from './product.js';

// The characters a backup code is drawn from: no `0`/`O`, `1`/`I`/`L`, or
// `U`, so a code read off paper and typed back in is unambiguous. Five bits a
// character, twelve characters, so a code carries sixty bits -- enough that
// guessing one is hopeless even before the login rate limit is counted.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_SIZE = 4;

export const BACKUP_CODE_COUNT = 10;

// How long the server remembers a ceremony, or a sign-in waiting on its second
// factor. Long enough to find a phone and finish the prompt, short enough that
// an abandoned one cannot be resumed much later.
export const CEREMONY_TTL_MS = 5 * 60_000;

export const CHALLENGE_KINDS = {
  register: 'register',
  reauth: 'reauth',
  signin: 'signin',
};

export function hashBackupCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

// Accept a code however it was typed back: case-folded and with the grouping
// punctuation stripped, so `abcd-efgh` and `ABCD EFGH` are the same code.
export function normalizeBackupCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomCode() {
  // One byte per character would bias the alphabet: 256 is not a multiple of
  // 32, but the top five bits of a byte are uniformly distributed, so take
  // those instead of reducing the whole byte.
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_SIZE);
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte >> 3]);
  const groups = [];
  for (let i = 0; i < chars.length; i += CODE_GROUP_SIZE) {
    groups.push(chars.slice(i, i + CODE_GROUP_SIZE).join(''));
  }
  return groups.join('-');
}

// New codes, plaintext, to be shown once. Only their hashes are stored.
export function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, randomCode);
}

// The site the ceremony happens on. The RP ID is the hostname a passkey is
// scoped to; the browser refuses a page whose origin is not that host or a
// subdomain of it, so this is what the operator has to align with whatever
// serves the web client. The accepted origins are the public base URL plus the
// explicitly allowed CORS origins, which is the same set an OIDC `returnTo` is
// checked against.
export function webauthnSettings(config) {
  const publicUrl = URL.parse(config.publicBaseUrl);
  if (!publicUrl) {
    throw new Error(`publicBaseUrl is not a URL (got "${config.publicBaseUrl}")`);
  }
  const rpId = config.auth.webauthn.rpId ?? publicUrl.hostname;
  const rpName = config.auth.webauthn.rpName ?? product.name ?? 'TwextHub';

  const origins = new Set([publicUrl.origin]);
  const { allowedOrigins } = config.cors;
  if (allowedOrigins !== '*') {
    for (const origin of allowedOrigins) {
      const parsed = URL.parse(origin);
      if (parsed) origins.add(parsed.origin);
    }
  }
  return { rpId, rpName, origins: [...origins] };
}

// Whether an account has a second factor at all. A passkey is the factor; the
// backup codes only stand in for one, so the presence of a passkey is what
// turns MFA on.
export async function hasPasskeys(db, userId) {
  const count = await db.Passkeys.count({ where: { UserId: userId } });
  return count > 0;
}

export async function unusedBackupCodeCount(db, userId) {
  return db.MfaBackupCodes.count({ where: { UserId: userId, UsedAt: null } });
}

// The methods a waiting sign-in can still be finished with, for the client to
// render. Backup codes stop being listed once the set is exhausted.
export function mfaMethods(unusedCodes) {
  return unusedCodes > 0 ? ['passkey', 'backup_code'] : ['passkey'];
}
