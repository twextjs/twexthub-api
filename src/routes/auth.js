import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { hashToken, requireSession } from '../auth.js';
import { beginSigninMfa, hasPasskeys } from '../mfa.js';
import { makeOidcClient, newSecret, oidcEnabled, OidcError } from '../oidc.js';
import { deviceEnabled } from '../device.js';
import { conflict, fieldErrors, HttpError, notFound } from '../errors.js';
import { isValidNamespace, normalizeApiRoot } from '../util.js';
import { sessionToObject, userToObject } from '../serialize.js';
import { createSession, requireObjectBody } from './shared.js';
import { audit } from '../audit.js';
import { withLocks } from '../locks.js';

// How long a sign-in may sit between the authorize redirect and the callback,
// and how long the browser then has to redeem its one-time code for the
// session. The first is generous because it includes typing a password at the
// provider; the second only has to cover a redirect and one request.
const FLOW_TTL_MS = 10 * 60_000;
const EXCHANGE_TTL_MS = 5 * 60_000;

export function makeAuthRouter({ db, config, rateLimiter }) {
  const root = normalizeApiRoot(config.apiRoot);
  const mount = (path) => `${root ? `/${root}` : ''}${path}`;
  const router = Router();
  const oidc = config.auth.oidc;
  const enabled = oidcEnabled(config);
  const client = enabled ? makeOidcClient(config) : null;
  const sessionTtlMs = config.auth.sessionTtlDays * 86_400_000;

  // The flow is bound to the browser that started it by a secret in a cookie:
  // the callback has to present the same secret, so a callback minted in one
  // browser cannot be replayed into another. `Secure` only when the instance
  // is actually served over TLS, for the same reason the instance allows plain
  // HTTP at all. The cookie is named by the flow's state so concurrent flows
  // do not overwrite each other's binding.
  const flowCookieBase = 'twexthub_oidc_flow';
  const flowCookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicBaseUrl.startsWith('https:'),
    path: mount('/auth'),
    maxAge: FLOW_TTL_MS,
  };
  const flowCookieName = (state) => {
    if (typeof state !== 'string' || state === '') return flowCookieBase;
    return `${flowCookieBase}_${state}`;
  };
  const setFlowCookie = (res, state, secret) =>
    res.cookie(flowCookieName(state), secret, flowCookieOptions);
  const clearFlowCookie = (res, state) => res.clearCookie(flowCookieName(state), flowCookieOptions);

  // What a sign-in page needs to render: whether password sign-in is offered,
  // and where the button for the provider should lead. Public, because it is
  // read before anybody has signed in.
  router.get('/', (req, res) => {
    res.json({
      passwordAuth: !oidc.required,
      oidc: enabled ? { issuer: oidc.issuer, required: Boolean(oidc.required) } : null,
      // A client that cannot run a browser flow reads this to know it can ask
      // for a code instead of prompting for a password.
      device: deviceEnabled(config)
        ? { verificationUrl: config.auth.device.verificationUrl }
        : null,
    });
  });

  // The browser leaves here for the provider, and the provider sends it back
  // to the callback. The flow row is what makes the return trip trustworthy:
  // it holds the state the callback has to see again, the PKCE verifier the
  // code can only be redeemed with, and the nonce the ID token must contain.
  router.get('/oidc/authorize', async (req, res) => {
    if (!enabled) throw notFound();
    const returnTo = returnToPath(req.query.returnTo, config);
    const state = newSecret();
    const verifier = newSecret();
    const nonce = newSecret();
    const binding = newSecret();
    const authorizationUrl = await client.authorizationUrl({ state, nonce, verifier });

    await db.OidcFlows.deleteMany({ where: { ExpiresAt: { lt: new Date() } } });
    await db.OidcFlows.create({
      data: {
        Kind: 'signin',
        StateHash: hashToken(state),
        FlowSecretHash: hashToken(binding),
        CodeVerifier: verifier,
        Nonce: nonce,
        ReturnTo: returnTo,
        ExpiresAt: new Date(Date.now() + FLOW_TTL_MS),
      },
    });
    setFlowCookie(res, state, binding);

    if (wantsHtml(req)) return res.redirect(authorizationUrl);
    res.json({ authorizationUrl });
  });

  router.get('/oidc/callback', async (req, res) => {
    if (!enabled) throw notFound();
    const { state, code, error: providerError } = req.query;
    if (typeof state !== 'string' || state === '') {
      return failFlow(
        req,
        res,
        null,
        400,
        'state_invalid',
        'The callback is missing its state parameter.',
      );
    }

    // Claiming the row and consuming its state are the same write: the guard
    // on exchange_code_hash means only the first callback through matches, so
    // a replayed state finds nothing. The cookie binding is checked in the
    // same statement, so a callback carrying another browser's state does not
    // complete a sign-in for this one. A conditional update across two unique
    // filters has no typed equivalent that both claims the row and returns it.
    const exchangeCode = newSecret();
    const binding = readCookie(req, flowCookieName(state));
    const [flow] = await db.$queryRaw`
      UPDATE "OidcFlows"
      SET "ExchangeCodeHash" = ${hashToken(exchangeCode)}
      WHERE "StateHash" = ${hashToken(state)}
        AND "FlowSecretHash" = ${hashToken(binding ?? '')}
        AND "ExchangeCodeHash" IS NULL AND "ExpiresAt" > now()
      RETURNING *
    `;
    if (!flow) {
      return failFlow(
        req,
        res,
        null,
        400,
        'state_invalid',
        'The sign-in attempt is unknown or has expired.',
      );
    }
    clearFlowCookie(res, state);

    if (typeof providerError === 'string' && providerError !== '') {
      return failFlow(
        req,
        res,
        flow,
        502,
        'provider_error',
        `The provider refused the sign-in (${providerError.slice(0, 64)}).`,
      );
    }
    if (typeof code !== 'string' || code === '') {
      return failFlow(
        req,
        res,
        flow,
        400,
        'provider_error',
        'The callback is missing its code parameter.',
      );
    }

    let claims;
    try {
      claims = await client.redeemCode({ code, verifier: flow.CodeVerifier, nonce: flow.Nonce });
    } catch (error) {
      if (error instanceof OidcError) {
        return failFlow(req, res, flow, error.status, error.slug, error.detail);
      }
      throw error;
    }
    const issuer = claims.iss;
    const subject = claims.sub;

    if (flow.Kind === 'link') {
      return finishLink(req, res, flow, { issuer, subject, claims });
    }
    return finishSignin(req, res, flow, exchangeCode, { issuer, subject, claims });
  });

  // The token is handed to the client exactly once, in exchange for the code
  // it was redirected with, so an Authorization header reaches the browser
  // script without the session token ever appearing in a URL.
  router.post('/oidc/exchange', async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const { code } = req.body;
    if (typeof code !== 'string' || code === '') {
      throw fieldErrors([{ field: 'code', message: 'A code is required.' }]);
    }
    const [flow] = await db.$queryRaw`
      DELETE FROM "OidcFlows"
      WHERE "ExchangeCodeHash" = ${hashToken(code)} AND "UserId" IS NOT NULL AND "ExpiresAt" > now()
      RETURNING *
    `;
    if (!flow) throw new HttpError(400, { detail: 'That code is invalid or has expired.' });
    const user = await db.Users.findUnique({ where: { Id: flow.UserId } });
    if (!user) throw new HttpError(400, { detail: 'That code is invalid or has expired.' });

    // The provider vouched for the first factor only. An account with a
    // passkey trades the code for a claim on its second factor rather than for
    // the session, so signing in through the provider does not bypass MFA.
    if (await hasPasskeys(db, user.Id)) {
      return res.status(202).json(await beginSigninMfa(db, user.Id));
    }

    const created = await createSession(db, user.Id, sessionTtlMs);
    res
      .location(mount(`/sessions/${created.session.Id}`))
      .status(201)
      .json({
        session: sessionToObject(created.session),
        user: userToObject(user, config),
        token: created.token,
      });
  });

  // Linking is confirmed from a session rather than from a token, because it
  // is a lasting change to how the account can be signed into: a session is
  // the account acting as itself, while an automation token is a credential
  // that should not be able to bind a new identity to the account.
  router.post('/oidc/link', requireSession, async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const returnTo = returnToPath(req.body.returnTo, config);
    const state = newSecret();
    const verifier = newSecret();
    const nonce = newSecret();
    const binding = newSecret();
    const authorizationUrl = await client.authorizationUrl({ state, nonce, verifier });

    await db.OidcFlows.deleteMany({ where: { ExpiresAt: { lt: new Date() } } });
    await db.OidcFlows.create({
      data: {
        Kind: 'link',
        StateHash: hashToken(state),
        FlowSecretHash: hashToken(binding),
        CodeVerifier: verifier,
        Nonce: nonce,
        UserId: req.auth.user.Id,
        ReturnTo: returnTo,
        ExpiresAt: new Date(Date.now() + FLOW_TTL_MS),
      },
    });
    setFlowCookie(res, state, binding);
    res.json({ authorizationUrl });
  });

  router.get('/oidc/identities', requireSession, async (req, res) => {
    const rows = await db.UserIdentities.findMany({
      where: { UserId: req.auth.user.Id },
      select: { Id: true, Issuer: true, Subject: true, Email: true, CreatedAt: true },
      orderBy: { Id: 'asc' },
    });
    res.json({ data: rows.map(identityToObject) });
  });

  // An identity is not gated on the provider still being configured: an
  // operator who turns the provider off leaves accounts that linked it needing
  // a way to remove the link.
  router.delete('/oidc/identities/:id', requireSession, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    await db.$transaction(async (tx) => {
      const [identity] = await tx.$queryRaw`
        SELECT * FROM "UserIdentities" WHERE "Id" = ${id} AND "UserId" = ${req.auth.user.Id} FOR UPDATE
      `;
      if (!identity) throw notFound('No such linked identity.');
      const [user] =
        await tx.$queryRaw`SELECT * FROM "Users" WHERE "Id" = ${req.auth.user.Id} FOR UPDATE`;
      const count = await tx.UserIdentities.count({ where: { UserId: req.auth.user.Id } });
      // Unlinking the last way in would strand the account: a password that
      // still works is a way in, but one the instance no longer accepts is not.
      const canUsePassword = Boolean(user.PasswordHash) && !oidc.required;
      if (!canUsePassword && count <= 1) {
        throw conflict(
          user.PasswordHash
            ? 'Password sign-in is turned off on this instance, so this link is the only way in.'
            : 'This link is the only way into the account. Ask an admin for a password before removing it.',
        );
      }
      await tx.UserIdentities.delete({ where: { Id: id } });
      await audit(
        tx,
        user,
        'identity.unlink',
        { namespace: user.Namespace },
        { issuer: identity.Issuer },
      );
    });
    res.status(204).end();
  });

  async function finishLink(req, res, flow, { issuer, subject, claims }) {
    const user = await db.Users.findUnique({ where: { Id: flow.UserId } });
    if (!user) {
      return failFlow(
        req,
        res,
        flow,
        400,
        'link_failed',
        'The account this link was started for no longer exists.',
      );
    }
    const identity = await attachIdentity(db, user.Id, issuer, subject, claimEmail(claims));
    if (!identity || Number(identity.UserId) !== Number(user.Id)) {
      return failFlow(
        req,
        res,
        flow,
        409,
        'identity_taken',
        'That identity is already linked to another account.',
      );
    }
    if (identity.created) {
      await audit(db, user, 'identity.link', { namespace: user.Namespace }, { issuer });
    }
    await db.OidcFlows.deleteMany({ where: { Id: flow.Id } });
    if (wantsHtml(req)) {
      const target = redirectTarget(flow.ReturnTo, config);
      target.searchParams.set('oidc_linked', '1');
      return res.redirect(target.toString());
    }
    res.json({ linked: true, issuer, subject });
  }

  async function finishSignin(req, res, flow, exchangeCode, { issuer, subject, claims }) {
    const existing = await db.UserIdentities.findUnique({
      where: { Issuer_Subject: { Issuer: issuer, Subject: subject } },
    });
    let user;
    if (existing) {
      user = await db.Users.findUnique({ where: { Id: existing.UserId } });
    } else {
      user = await createAccountFromClaims(db, rateLimiter, req, {
        issuer,
        subject,
        claims,
      });
    }
    if (!user) {
      return failFlow(req, res, flow, 500, 'signup_failed', 'The account could not be created.');
    }

    // A browser cannot read an Authorization header from a redirect, so it is
    // sent back with a one-time code instead and trades that for the session.
    if (wantsHtml(req)) {
      await db.OidcFlows.update({
        where: { Id: flow.Id },
        data: { UserId: user.Id, ExpiresAt: new Date(Date.now() + EXCHANGE_TTL_MS) },
      });
      const target = redirectTarget(flow.ReturnTo, config);
      target.searchParams.set('oidc_code', exchangeCode);
      return res.redirect(target.toString());
    }

    await db.OidcFlows.deleteMany({ where: { Id: flow.Id } });
    if (await hasPasskeys(db, user.Id)) {
      return res.status(202).json(await beginSigninMfa(db, user.Id));
    }

    const created = await createSession(db, user.Id, sessionTtlMs);
    res
      .location(mount(`/sessions/${created.session.Id}`))
      .status(201)
      .json({
        session: sessionToObject(created.session),
        user: userToObject(user, config),
        token: created.token,
      });
  }

  // A failure in the middle of a sign-in reaches a browser as a redirect back
  // with a slug the sign-in page can turn into wording, and an API client as
  // the problem response its own Accept header asked for.
  function failFlow(req, res, flow, status, slug, detail) {
    if (wantsHtml(req)) {
      const target = redirectTarget(flow?.ReturnTo, config);
      target.searchParams.set('oidc_error', slug);
      return res.redirect(target.toString());
    }
    throw new HttpError(status, { detail });
  }

  return router;
}

// An account is created for an identity the provider vouches for and the hub
// has never seen. Roles stay local -- the first account is an admin exactly as
// it is for password sign-up -- and the namespace comes from the provider's
// preferred name when it can, with a digest-based fallback that cannot collide
// with anybody.
async function createAccountFromClaims(db, rateLimiter, req, { issuer, subject, claims }) {
  await rateLimiter.signupCheck(`signup:${req.ip}`);
  const base = namespaceFromClaims(claims, issuer, subject);
  const displayName = displayNameFromClaims(claims, base);

  return withLocks(db, ['signup-bootstrap'], async (tx) => {
    // Another callback for the same identity may have created the account
    // while this one waited for the lock.
    const existing = await tx.UserIdentities.findFirst({
      where: { Issuer: issuer, Subject: subject },
      include: { Users: true },
    });
    if (existing) return existing.Users;

    const count = await tx.Users.count();
    const role = count === 0 ? 'admin' : 'normal';
    const namespace = await freeNamespace(tx, base);
    const user = await tx.Users.create({
      data: { Namespace: namespace, DisplayName: displayName, Role: role },
    });
    await tx.UserIdentities.create({
      data: { UserId: user.Id, Issuer: issuer, Subject: subject, Email: claimEmail(claims) },
    });
    return user;
  });
}

// Inserts the link unless the identity already exists, in which case the row
// is returned with `created: false` and the caller decides what an existing
// link belonging to somebody else means. The insert and the fallback read have
// to be one statement apart, so the conflict-ignoring INSERT keeps its
// `RETURNING`.
async function attachIdentity(db, userId, issuer, subject, email) {
  const inserted = await db.$queryRaw`
    INSERT INTO "UserIdentities" ("UserId", "Issuer", "Subject", "Email")
    VALUES (${userId}, ${issuer}, ${subject}, ${email})
    ON CONFLICT ("Issuer", "Subject") DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) return { ...inserted[0], created: true };
  return db.UserIdentities.findUnique({
    where: { Issuer_Subject: { Issuer: issuer, Subject: subject } },
  });
}

async function freeNamespace(tx, base) {
  const taken = (namespace) =>
    tx.Users.findFirst({ where: { Namespace: namespace }, select: { Id: true } });
  if (base) {
    if (!(await taken(base))) return base;
    for (let suffix = 2; suffix <= 50; suffix += 1) {
      const candidate = `${base.slice(0, 36)}-${suffix}`;
      if (!(await taken(candidate))) return candidate;
    }
  }
  for (;;) {
    const candidate = `user-${randomBytes(6).toString('hex')}`;
    if (!(await taken(candidate))) return candidate;
  }
}

function namespaceFromClaims(claims, issuer, subject) {
  const claimed = [claims.preferred_username, claims.nickname, claims.username].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  const normalized = claimed
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  if (normalized && isValidNamespace(normalized)) return normalized;
  const digest = createHash('sha256')
    .update(`${issuer}\u0000${subject}`)
    .digest('hex')
    .slice(0, 12);
  return `user-${digest}`;
}

function displayNameFromClaims(claims, fallback) {
  const claimed = [claims.name, claims.preferred_username, claims.nickname].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  return claimed ? claimed.trim().slice(0, 80) : fallback;
}

function claimEmail(claims) {
  if (typeof claims.email !== 'string') return null;
  const email = claims.email.trim();
  return email !== '' && email.length <= 254 ? email : null;
}

function identityToObject(row) {
  return {
    id: String(row.Id),
    issuer: row.Issuer,
    subject: row.Subject,
    email: row.Email ?? null,
    createdAt: row.CreatedAt.toISOString(),
  };
}

// A browser navigation is a request for a page; anything else (an SPA calling
// with fetch, a CLI) wants JSON and gets the same information as one.
function wantsHtml(req) {
  return String(req.headers.accept ?? '').includes('text/html');
}

// Read one cookie without pulling in a parser for the whole jar. The values
// this reads are base64url secrets this instance set, so malformed input is
// simply "no cookie".
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

// Where the browser is sent once the provider hands it back. A path is
// resolved against publicBaseUrl and has to stay on that origin; an absolute
// URL has to name an origin the instance already trusts. Either way the stored
// value is the resolved URL, because otherwise an authorize link with an
// attacker's returnTo would hand that attacker a freshly minted sign-in code.
function returnToPath(value, config) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) {
    throw fieldErrors([{ field: 'returnTo', message: 'Must be a path or an allowed origin.' }]);
  }
  // Control characters are stripped by the URL parser rather than encoded, so
  // "/<tab>/evil.example" would first pass the leading-slash check here and
  // then resolve to "//evil.example" off-origin. Backslashes are refused for
  // the same reason on the browsers that treat them as slashes.
  if (hasControlChars(value) || value.includes('\\')) {
    throw fieldErrors([{ field: 'returnTo', message: 'Must be a path on this instance.' }]);
  }
  const base = URL.parse(config.publicBaseUrl);
  if (value.startsWith('/')) {
    const target = resolveAgainst(value, config.publicBaseUrl);
    if (!base || !target || target.origin !== base.origin) {
      throw fieldErrors([{ field: 'returnTo', message: 'Must be a path on this instance.' }]);
    }
    return `${target.pathname}${target.search}${target.hash}`;
  }
  const parsed = URL.parse(value);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw fieldErrors([{ field: 'returnTo', message: 'Must be a path or an allowed origin.' }]);
  }
  if (!allowedReturnOrigins(config).has(parsed.origin)) {
    throw fieldErrors([
      {
        field: 'returnTo',
        message:
          "Must be a path on this instance, or an origin in the instance's cors.allowedOrigins.",
      },
    ]);
  }
  return parsed.toString();
}

function resolveAgainst(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function allowedReturnOrigins(config) {
  const origins = new Set();
  const base = URL.parse(config.publicBaseUrl);
  if (base) origins.add(base.origin);
  for (const origin of Array.isArray(config.cors.allowedOrigins)
    ? config.cors.allowedOrigins
    : []) {
    const parsed = URL.parse(origin);
    if (parsed) origins.add(parsed.origin);
  }
  return origins;
}

function redirectTarget(returnTo, config) {
  try {
    return new URL(returnTo ?? '', config.publicBaseUrl);
  } catch {
    return new URL(config.publicBaseUrl);
  }
}
