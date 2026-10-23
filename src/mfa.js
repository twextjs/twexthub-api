import { createHash, randomInt } from 'node:crypto';
import { hashToken, newToken } from './auth.js';
import { product } from './product.js';

// The characters a backup code is drawn from: no `0`/`O`, `1`/`I`/`L`, or
// `U`, so a code read off paper and typed back in is unambiguous. Twelve
// characters from a thirty-letter alphabet is about fifty-nine bits -- enough
// that guessing one is hopeless even before the login rate limit is counted.
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

// The stored hash is of the code's normalized form, not the grouped form it is
// shown in. A code is read off paper and typed back by hand, so the hyphens are
// presentation: hashing the normalized form means any way of retyping it --
// lower case, spaces instead of hyphens, the hyphens dropped -- finds the row.
export function hashBackupCode(code) {
  return createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}

// A passkey's COSE public key is bytes, and the library hands registration one
// as a `Uint8Array` while the column is text. Base64url is the encoding
// WebAuthn already uses for every other binary field, so it is what the column
// holds between the two ceremonies.
export function encodePublicKey(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function decodePublicKey(encoded) {
  return new Uint8Array(Buffer.from(encoded, 'base64url'));
}

// Accept a code however it was typed back: case-folded and with the grouping
// punctuation stripped, so `abcd-efgh` and `ABCD EFGH` are the same code.
export function normalizeBackupCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomCode() {
  // `randomInt` draws from the whole alphabet without bias: it rejects the
  // values that would otherwise push the first few characters over the others.
  // Slicing five bits out of a byte instead would index past the end of a
  // thirty-character alphabet, and the resulting `undefined` disappears when
  // the group is joined, leaving a code shorter than the twelve it promises.
  const chars = Array.from(
    { length: CODE_GROUPS * CODE_GROUP_SIZE },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  );
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

// The answer to a sign-in that passed its first factor and stopped at the
// second. The token is the claim on the pending challenge: the requests that
// finish the sign-in are anonymous, so it is all they carry to name the
// account. Only its hash is stored, like a session token, and the account's
// earlier pending sign-in is dropped with it, so a token handed out before
// stops working.
export async function beginSigninMfa(db, userId) {
  const token = newToken();
  await db.$transaction([
    db.MfaChallenges.deleteMany({ where: { UserId: userId, Kind: CHALLENGE_KINDS.signin } }),
    db.MfaChallenges.create({
      data: {
        UserId: userId,
        Kind: CHALLENGE_KINDS.signin,
        SecretHash: hashToken(token),
        ExpiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
      },
    }),
  ]);
  const unusedCodes = await unusedBackupCodeCount(db, userId);
  return { mfaRequired: true, mfaToken: token, methods: mfaMethods(unusedCodes) };
}
