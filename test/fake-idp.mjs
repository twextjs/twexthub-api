import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// A minimal OpenID Connect provider for the suite: discovery, JWKS, an
// authorize endpoint that issues a code bound to the request's nonce and PKCE
// challenge, and a token endpoint that checks the verifier and returns a
// signed ID token. It is enough to exercise the client and the routes without
// a network provider standing behind them.
export async function startFakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };

  const codes = new Map();
  let port = 0;
  let claims = defaultClaims();
  let tokenOptions = {};

  const origin = () => `http://localhost:${port}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin());

    if (url.pathname === '/.well-known/openid-configuration') {
      return sendJson(res, 200, {
        issuer: origin(),
        authorization_endpoint: `${origin()}/authorize`,
        token_endpoint: `${origin()}/token`,
        jwks_uri: `${origin()}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    }

    if (url.pathname === '/jwks') return sendJson(res, 200, { keys: [jwk] });

    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
        clientId: url.searchParams.get('client_id'),
        claims: { ...claims },
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token') {
      const body = new URLSearchParams(await readBody(req));
      const entry = codes.get(body.get('code'));
      codes.delete(body.get('code'));
      if (!entry) return sendJson(res, 400, { error: 'invalid_grant' });
      const verifier = body.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== entry.challenge) {
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      }
      const idToken = await signIdToken({
        privateKey,
        issuer: origin(),
        audience: entry.clientId,
        nonce: entry.nonce,
        claims: entry.claims,
        options: tokenOptions,
      });
      return sendJson(res, 200, {
        id_token: idToken,
        token_type: 'Bearer',
        access_token: 'access-token-not-used',
        expires_in: 300,
      });
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;

  return {
    get issuer() {
      return origin();
    },
    get url() {
      return origin();
    },
    // Claims the next authorize round-trip will mint into its ID token. Left
    // as-is until a test changes them.
    setClaims(next) {
      claims = { ...defaultClaims(), ...next };
    },
    // Shape the ID tokens the provider will mint, e.g. `{ omitExp: true }` to
    // present a token a conforming client has to reject.
    setTokenOptions(next) {
      tokenOptions = { ...next };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function defaultClaims() {
  return { sub: `subject-${randomUUID()}`, email: 'person@example.test', name: 'Test Person' };
}

function signIdToken({ privateKey, issuer, audience, nonce, claims, options }) {
  const jwt = new SignJWT({ nonce, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(claims.sub);
  if (!options.omitIat) jwt.setIssuedAt();
  if (!options.omitExp) jwt.setExpirationTime('5m');
  return jwt.sign(privateKey);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Walk the provider the way a browser would: request the authorization URL
// without following its redirect, and read the code and state back off the
// Location header.
export async function roundTripProvider(authorizationUrl) {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  if (response.status !== 302) {
    throw new Error(`fake IdP authorize answered ${response.status}`);
  }
  const location = new URL(response.headers.get('location'));
  return { code: location.searchParams.get('code'), state: location.searchParams.get('state') };
}
