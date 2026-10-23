import { createHash, randomInt } from 'node:crypto';
import { hashToken, newToken } from './auth.js';
import { CODE_ALPHABET } from './mfa.js';

// How long a CLI sign-in may wait for a browser to approve it, and how often
// the client is told it may ask whether it has been. The TTL matches the OIDC
// flow's: both cover a person finding a browser and signing in.
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_SECONDS = 5;

export const MAX_CLIENT_NAME_LENGTH = 80;

const USER_CODE_GROUPS = 2;
const USER_CODE_GROUP_SIZE = 4;

// Two spellings of the same on/off check: OIDC needs an issuer and a client id,
// while the device flow needs a page to approve on.
export function deviceEnabled(config) {
  return Boolean(config.auth.device?.verificationUrl);
}

// The pending sign-in a client creates. The device code is the secret it holds
// and polls with; the user code is what a person reads off the terminal and
// types into the approval page. Both are stored hashed, so a read of the table
// cannot resume either half.
export function newDeviceCode() {
  return { deviceCode: newToken(), userCode: newUserCode() };
}

export function newUserCode() {
  const chars = Array.from(
    { length: USER_CODE_GROUPS * USER_CODE_GROUP_SIZE },
    () =>
      // `randomInt` rather than a byte shifted down: the alphabet is shorter than
      // a byte, so slicing bits out of one would either bias the letters or index
      // past the end of it.
      CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  );
  const groups = [];
  for (let i = 0; i < chars.length; i += USER_CODE_GROUP_SIZE) {
    groups.push(chars.slice(i, i + USER_CODE_GROUP_SIZE).join(''));
  }
  return groups.join('-');
}

export function normalizeUserCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// A user code is typed by hand, so what is compared is its normalized form:
// lower case, spaces instead of the hyphen, and the hyphen dropped all find the
// same row. A code of the wrong shape is not looked up at all.
export function parseUserCode(input) {
  const normalized = normalizeUserCode(input);
  if (normalized.length !== USER_CODE_GROUPS * USER_CODE_GROUP_SIZE) return null;
  for (const char of normalized) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return normalized;
}

export function hashUserCode(code) {
  return createHash('sha256').update(normalizeUserCode(code)).digest('hex');
}

export function hashDeviceCode(code) {
  return hashToken(code);
}

// What the approval page shows above its button, and what the descriptor
// advertises. The complete URL carries the code, which is the one-click form;
// the plain one is what a person opens on another device and types into.
export function verificationUri(config, userCode) {
  const url = new URL(config.auth.device.verificationUrl);
  return { verificationUri: url.toString(), verificationUriComplete: withUserCode(url, userCode) };
}

function withUserCode(url, userCode) {
  if (!userCode) return url.toString();
  const complete = new URL(url);
  complete.searchParams.set('user_code', userCode);
  return complete.toString();
}

// A client names itself so the person approving sees what is asking, rather
// than a code with no context. It is free text and stays bounded.
export function parseClientName(value) {
  if (value === undefined || value === null) return 'Unnamed client';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return 'Unnamed client';
  if (trimmed.length > MAX_CLIENT_NAME_LENGTH) return null;
  return trimmed;
}
