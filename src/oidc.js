import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './errors.js';
import { normalizeApiRoot } from './util.js';

const DISCOVERY_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SIGNING_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

// A sign-in that cannot be completed. `slug` is what a browser redirect names
// in place of the detail, which stays in the problem response an API client
// sees; the detail can hold provider text, the slug never does.
export class OidcError extends HttpError {
  constructor(status, slug, detail) {
    super(status, { detail });
    this.slug = slug;
  }
}

export function oidcEnabled(config) {
  return Boolean(config.auth.oidc?.issuer && config.auth.oidc?.clientId);
}

export function newSecret() {
  return randomBytes(32).toString('base64url');
}

export function codeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// The redirect URI the provider is given and must send the browser back to. It
// is derived rather than configured so the value in the config file and the
// value registered at the provider cannot drift apart by a typo.
export function callbackUrl(config) {
  const root = normalizeApiRoot(config.apiRoot);
  return `${config.publicBaseUrl.replace(/\/$/, '')}${root ? `/${root}` : ''}/auth/oidc/callback`;
}

export function makeOidcClient(config) {
  const issuer = config.auth.oidc.issuer.replace(/\/+$/, '');
  const clientId = config.auth.oidc.clientId;
  const clientSecret = config.auth.oidc.clientSecret || null;

  let discovery = null;
  let jwks = null;

  async function metadata() {
    if (discovery && discovery.fetchedAt + DISCOVERY_TTL_MS > Date.now()) return discovery.value;
    const url = `${issuer}/.well-known/openid-configuration`;
    const value = await fetchJson(url, 'provider discovery');
    // The document names its own issuer, and a mismatch means the URL points
    // at something other than the provider the operator configured -- a
    // fronting proxy's error page, say -- so it is not used.
    if (typeof value.issuer !== 'string' || value.issuer.replace(/\/+$/, '') !== issuer) {
      throw new OidcError(
        502,
        'provider_unavailable',
        `The provider at ${issuer} identifies itself as ${value.issuer ?? 'nothing'}.`,
      );
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof value[key] !== 'string' || value[key] === '') {
        throw new OidcError(502, 'provider_unavailable', `The discovery document has no ${key}.`);
      }
    }
    discovery = { value, fetchedAt: Date.now() };
    return value;
  }

  async function authorizationUrl({ state, nonce, verifier }) {
    const doc = await metadata();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl(config));
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async function redeemCode({ code, verifier, nonce }) {
    const doc = await metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(config),
      code_verifier: verifier,
    });
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    // A confidential client authenticates at the token endpoint; one without a
    // secret is a public client and is identified by client_id in the body.
    if (clientSecret) {
      const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    } else {
      body.set('client_id', clientId);
    }

    let response;
    try {
      response = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OidcError(
        502,
        'provider_unavailable',
        `Could not reach the identity provider's token endpoint: ${error.message}`,
      );
    }
    const token = await response.json().catch(() => null);
    if (!response.ok || !token || typeof token.id_token !== 'string') {
      const reason = token?.error ? ` (${token.error})` : '';
      throw new OidcError(
        502,
        'provider_rejected',
        `The identity provider refused the sign-in${reason}.`,
      );
    }

    jwks ??= createRemoteJWKSet(new URL(doc.jwks_uri), {
      timeoutDuration: REQUEST_TIMEOUT_MS,
      cooldownDuration: 30_000,
    });
    let payload;
    try {
      ({ payload } = await jwtVerify(token.id_token, jwks, {
        issuer: [issuer, `${issuer}/`],
        audience: clientId,
        algorithms: SIGNING_ALGS,
        // OIDC Core requires iss, sub, aud, exp and iat on an ID token, so a
        // token missing any of them is not one this instance will accept.
        requiredClaims: ['exp', 'iat', 'sub'],
        clockTolerance: 10,
      }));
    } catch (error) {
      throw new OidcError(
        502,
        'invalid_id_token',
        `The ID token could not be verified: ${error.message}`,
      );
    }
    // The nonce is what ties the token to this attempt rather than to another
    // one the provider issued for the same client.
    if (payload.nonce !== nonce) {
      throw new OidcError(502, 'invalid_id_token', 'The ID token does not belong to this sign-in.');
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new OidcError(502, 'invalid_id_token', 'The ID token carries no subject.');
    }
    return payload;
  }

  return { metadata, authorizationUrl, redeemCode };
}

// Fetch and parse a JSON document, with anything that can go wrong on the way
// reported as the provider being unavailable rather than as a server fault of
// this instance's own.
async function fetchJson(url, what) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OidcError(
      502,
      'provider_unavailable',
      `Could not reach the identity provider for ${what}: ${error.message}`,
    );
  }
  if (!response.ok) {
    throw new OidcError(
      502,
      'provider_unavailable',
      `The provider answered ${response.status} for ${what}.`,
    );
  }
  const value = await response.json().catch(() => null);
  if (!value || typeof value !== 'object') {
    throw new OidcError(502, 'provider_unavailable', `The provider returned no JSON for ${what}.`);
  }
  return value;
}
