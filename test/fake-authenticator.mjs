// A software authenticator, for tests only.
//
// The WebAuthn ceremonies are the one part of MFA a real client performs, and
// the suite has no browser. So this stands in for one: it holds an ES256 key,
// answers a registration challenge with a `none` attestation, and answers an
// authentication challenge with a signature over the authenticator data. The
// server sees exactly what a real authenticator would send, so the tests
// exercise the library's verification rather than a stub of it.
//
// The pieces are small enough to write by hand. CBOR is only needed for the
// handful of shapes the spec uses -- byte strings, text, arrays, maps, and
// small integers -- and the signature is standard ECDSA with SHA-256, DER
// encoded, which is what `crypto.sign` already produces.
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as signWith,
} from 'node:crypto';

const textEncoder = new TextEncoder();

// ---- Minimal CBOR ---------------------------------------------------------

function cborLength(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

function cbor(value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0) return cborLength(0, value);
    if (Number.isInteger(value) && value < 0) return cborLength(1, -1 - value);
    throw new Error('CBOR here only carries integers');
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborLength(2, bytes.length), bytes]);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(textEncoder.encode(value));
    return Buffer.concat([cborLength(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborLength(4, value.length), ...value.map(cbor)]);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const parts = [cborLength(5, entries.length)];
    for (const [key, inner] of entries) {
      parts.push(cbor(/^-?\d+$/.test(key) ? Number(key) : key));
      parts.push(cbor(inner));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cannot encode ${typeof value} as CBOR`);
}

// ---- Authenticator --------------------------------------------------------

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sha256(...buffers) {
  const hash = createHash('sha256');
  for (const buffer of buffers) hash.update(buffer);
  return hash.digest();
}

// The key pair is small enough to make per test. `ieee-p1363` is the raw r||s
// form, but WebAuthn carries DER, so the public key is exported as DER and the
// signature is asked for in DER too (the default).
function createKeyPair() {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
}

// The X and Y coordinates out of an SPKI DER public key. The key is fixed-size:
// a 26-byte header (algorithm identifier and the unused-bits octet) followed by
// the two 32-byte coordinates.
function coordinates(spkiDer) {
  return {
    x: spkiDer.subarray(spkiDer.length - 64, spkiDer.length - 32),
    y: spkiDer.subarray(spkiDer.length - 32),
  };
}

export function createAuthenticator({ aaguid = randomBytes(16) } = {}) {
  const { publicKey, privateKey } = createKeyPair();
  const { x, y } = coordinates(publicKey);
  const key = createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' });
  const credentialId = randomBytes(32);
  let counter = 0;

  // The COSE key for an ES256 credential: EC2, the ES256 algorithm, the P-256
  // curve, then the two coordinates. This is what the server stores and later
  // verifies assertions against.
  const cosePublicKey = cbor({
    1: 2, // kty: EC2
    3: -7, // alg: ES256
    '-1': 1, // crv: P-256
    '-2': x,
    '-3': y,
  });

  function authData(rpId, { flags, counterValue, attested }) {
    const parts = [sha256(textEncoder.encode(rpId)), Buffer.from([flags])];
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counterValue);
    parts.push(counterBytes);
    if (attested) {
      parts.push(Buffer.from(aaguid));
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      parts.push(idLength, credentialId, cosePublicKey);
    }
    return Buffer.concat(parts);
  }

  // The User Present and User Verified flags, plus Attested Data during
  // registration. The server requires user verification, so the flag has to be
  // set or every ceremony would be refused.
  const FLAG_UP = 0x01;
  const FLAG_UV = 0x04;
  const FLAG_AT = 0x40;

  function clientData(type, challenge, origin) {
    return textEncoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  return {
    credentialId: toBase64Url(credentialId),
    transports: ['internal'],

    registrationResponse({ challenge, origin, rpId }) {
      const data = authData(rpId, {
        flags: FLAG_UP | FLAG_UV | FLAG_AT,
        counterValue: 0,
        attested: true,
      });
      const attestationObject = cbor({
        fmt: 'none',
        attStmt: {},
        authData: data,
      });
      return {
        id: this.credentialId,
        rawId: this.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientData('webauthn.create', challenge, origin)),
          attestationObject: toBase64Url(attestationObject),
          transports: this.transports,
        },
      };
    },

    authenticationResponse({ challenge, origin, rpId }, { userVerified = true } = {}) {
      counter += 1;
      const data = authData(rpId, {
        flags: FLAG_UP | (userVerified ? FLAG_UV : 0),
        counterValue: counter,
        attested: false,
      });
      const clientDataJSON = clientData('webauthn.get', challenge, origin);
      const signature = signWith('sha256', Buffer.concat([data, sha256(clientDataJSON)]), {
        key,
        dsaEncoding: 'der',
      });
      return {
        id: this.credentialId,
        rawId: this.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientDataJSON),
          authenticatorData: toBase64Url(data),
          signature: toBase64Url(signature),
          userHandle: null,
        },
      };
    },
  };
}

export { toBase64Url };
