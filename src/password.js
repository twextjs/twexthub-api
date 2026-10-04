import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export async function hashPassword(password, { N, r, p }) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N, r, p, maxmem: 256 * N * r });
  return `${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 5) return false;
  const [N, r, p, saltHex, keyHex] = parts;
  if (!/^(?:[0-9a-f]{2})+$/i.test(saltHex) || !/^(?:[0-9a-f]{2})+$/i.test(keyHex)) {
    return false;
  }
  const Nn = Number(N);
  const rn = Number(r);
  const pn = Number(p);
  if (![Nn, rn, pn].every(Number.isInteger) || Nn <= 0 || rn <= 0 || pn <= 0) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const derived = await scrypt(password, salt, expected.length, {
    N: Nn,
    r: rn,
    p: pn,
    maxmem: 256 * Nn * rn,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
