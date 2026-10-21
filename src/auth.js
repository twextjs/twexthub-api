import { createHash, randomBytes } from 'node:crypto';
import { forbidden, unauthorized } from './errors.js';

// The permissions an automation token can be granted. A session satisfies every
// one of them, so what a credential may do is decided by its scopes and by the
// account's own authority (its role, the extensions it owns) rather than by
// whether it is a session. A token granted all of them acts like a session in
// everything but how it expires and how it is revoked.
export const SCOPES = [
  'publish',
  'yank',
  'read:source',
  'manage:account',
  'manage:orgs',
  'manage:sessions',
  'manage:tokens',
  'admin',
];

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('hex');
}

const LAST_USED_THROTTLE_MS = 60_000;

// The columns a request needs from the authenticated account. Selected rather
// than read whole so a password hash never rides along in memory.
const SESSION_USER_FIELDS = {
  Id: true,
  Namespace: true,
  DisplayName: true,
  Role: true,
  HasPublished: true,
  TermsAcceptedVersion: true,
  CreatedAt: true,
  Bio: true,
  Website: true,
  Github: true,
  AvatarUrl: true,
  BannerUrl: true,
  AvatarBlobDigest: true,
  BannerBlobDigest: true,
};

export function makeAuthenticate(db) {
  return async function authenticate(req, res, next) {
    const header = req.headers.authorization;
    // \S after \s+ keeps the match unambiguous (the two can't share a
    // character), so this can't backtrack polynomially on hostile input.
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(\S.*)$/i) : null;
    if (!match) {
      req.auth = null;
      return next();
    }

    const hash = hashToken(match[1].trim());
    const found = await lookupToken(db, hash);
    req.auth = found
      ? {
          user: found.user,
          tokenType: found.tokenType,
          scopes: found.scopes,
          tokenId: found.tokenId,
          authenticatedAt: found.authenticatedAt,
        }
      : null;

    if (found && shouldTouchLastUsed(found.lastUsedAt)) {
      try {
        if (found.tokenType === 'session') {
          await db.Sessions.update({
            where: { Id: found.tokenId },
            data: { LastUsedAt: new Date() },
          });
        } else {
          await db.AutomationTokens.update({
            where: { Id: found.tokenId },
            data: { LastUsedAt: new Date() },
          });
        }
      } catch (error) {
        const table = found.tokenType === 'session' ? 'Sessions' : 'AutomationTokens';
        console.warn(
          `failed to update last_used_at for ${table} ${found.tokenId}: ${error.message}`,
        );
      }
    }
    next();
  };
}

function shouldTouchLastUsed(lastUsedAt) {
  if (!lastUsedAt) return true;
  return Date.now() - lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS;
}

async function lookupToken(db, hash) {
  const session = await db.Sessions.findUnique({
    where: { TokenHash: hash },
    include: { Users: { select: SESSION_USER_FIELDS } },
  });
  if (session) {
    if (session.ExpiresAt && session.ExpiresAt <= new Date()) return null;
    return {
      tokenId: session.Id,
      tokenType: 'session',
      // A session is the full authority of the account, so it satisfies every
      // scope. Copied per request so nothing can widen them in place.
      scopes: [...SCOPES],
      lastUsedAt: session.LastUsedAt,
      // When this credential was last proven to belong to the account: the
      // moment the session was created, or the last passkey step-up that
      // refreshed it. Operations that demand a recent authentication read it;
      // an automation token has none, and those operations refuse it anyway.
      authenticatedAt: session.ReauthAt ?? session.CreatedAt,
      user: session.Users,
    };
  }

  const token = await db.AutomationTokens.findUnique({
    where: { TokenHash: hash },
    include: { Users: { select: SESSION_USER_FIELDS } },
  });
  if (!token) return null;
  if (token.ExpiresAt && token.ExpiresAt <= new Date()) return null;
  return {
    tokenId: token.Id,
    tokenType: 'automation',
    scopes: token.Scopes,
    lastUsedAt: token.LastUsedAt,
    user: token.Users,
  };
}

export function requireAuth(req, res, next) {
  if (!req.auth) throw unauthorized();
  next();
}

// An extension owner is an account or an organization, and an organization's
// owners all stand behind its row. So one test answers both: the direct match
// covers the account case, and the organization_owners branch covers @org/id
// with no row per person, as well as an organization holding a row on somebody
// else's extension. Two relations, an OR, and an EXISTS: kept as one raw read
// rather than smuggled into two typed round trips.
export async function isExtensionOwner(db, user, namespace, id) {
  const rows = await db.$queryRaw`
    SELECT 1
    FROM "ExtensionOwners" o
    WHERE o."Namespace" = ${namespace} AND o."ExtensionId" = ${id}
      AND (
        o."OwnerId" = ${user.Id}
        OR EXISTS (
          SELECT 1 FROM "OrganizationOwners" g
          WHERE g."OrgId" = o."OwnerId" AND g."UserId" = ${user.Id}
        )
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

// Whether an account may act for an organization by name. Used where the
// organization is identified by its namespace rather than by an ownership row:
// accepting an invitation addressed to it, for one.
export async function isOrganizationOwner(db, user, namespace) {
  const rows = await db.$queryRaw`
    SELECT 1
    FROM "OrganizationOwners" g
    JOIN "Users" org ON org."Id" = g."OrgId"
    WHERE g."UserId" = ${user.Id} AND org."Namespace" = ${namespace}
      AND org."Kind" = 'organization'
    LIMIT 1
  `;
  return rows.length > 0;
}

// The same answer as a list, for the places that need it as one: the listing
// filter carries the namespaces rather than testing each row, and an
// organization holding an invitation needs to know it is waiting.
export async function organizationsOwnedBy(db, user) {
  const rows = await db.$queryRaw`
    SELECT org."Namespace"
    FROM "OrganizationOwners" g
    JOIN "Users" org ON org."Id" = g."OrgId"
    WHERE g."UserId" = ${user.Id} AND org."Kind" = 'organization'
  `;
  return rows.map((row) => row.Namespace);
}

export function requireSession(req, res, next) {
  if (!req.auth) throw unauthorized();
  if (req.auth.tokenType !== 'session') {
    throw forbidden('Automation tokens cannot access this endpoint.');
  }
  next();
}

// A session proves who the caller is; this also demands that the proof is
// recent. It guards changes to the account's second factor -- adding or
// removing a passkey, regenerating backup codes -- where a
// long-lived session stolen from a browser should not be enough on its own. A
// sign-in counts, so the ordinary path needs nothing extra; a session that has
// aged past the window refreshes itself with a passkey (POST /auth/mfa/reauth)
// or by signing in again.
export function makeRequireRecentAuth(config) {
  const windowMs = config.auth.reauthWindowMinutes * 60_000;
  return function requireRecentAuth(req, res, next) {
    requireSession(req, res, () => {});
    const at = req.auth.authenticatedAt;
    if (!at || Date.now() - at.getTime() > windowMs) {
      throw forbidden(
        'This change needs a recent sign-in. Verify a passkey again, or sign out and back in.',
      );
    }
    next();
  };
}

// Admin authority is two separate things: the account carries the admin role,
// and the credential is allowed to use the admin surface. A session always has
// every scope, so a session admin passes on the role alone. An automation token
// has to have been granted `admin` as well, and the role check still runs
// first, so a normal account cannot mint itself an admin token.
export function isAdmin(auth) {
  return Boolean(auth) && auth.user.Role === 'admin' && auth.scopes.includes('admin');
}

// Throws the specific reason; the callers that have a message of their own to
// add (a review, say) would rather call this than restate both checks.
export function assertAdmin(auth) {
  if (!auth) throw unauthorized();
  if (auth.user.Role !== 'admin') {
    throw forbidden('Admin privileges are required.');
  }
  if (!auth.scopes.includes('admin')) {
    throw forbidden('This token is missing the required "admin" scope.');
  }
}

export function requireAdmin(req, res, next) {
  assertAdmin(req.auth);
  next();
}

export function makeRequireTerms(db) {
  let cachedVersion;
  let cachedAt = 0;

  async function requireTerms(req, res, next) {
    requireAuth(req, res, () => {});
    const now = Date.now();
    if (cachedVersion === undefined || cachedVersion === null || now - cachedAt > 60_000) {
      const terms = await db.LegalDocuments.findUnique({
        where: { Kind: 'terms' },
        select: { Version: true },
      });
      cachedVersion = terms ? terms.Version : null;
      cachedAt = now;
    }
    const accepted = req.auth.user.TermsAcceptedVersion;
    // No published terms means nothing to accept yet; the first document can
    // only be created from this un-gated state.
    if (cachedVersion !== null && (!accepted || accepted < cachedVersion)) {
      throw forbidden('The current Terms of Service have not been accepted yet.');
    }
    next();
  }

  requireTerms.invalidate = () => {
    cachedVersion = undefined;
    cachedAt = 0;
  };

  return requireTerms;
}

export function requireScope(scope) {
  return function checkScope(req, res, next) {
    requireAuth(req, res, () => {});
    if (!req.auth.scopes.includes(scope)) {
      throw forbidden(`This token is missing the required "${scope}" scope.`);
    }
    next();
  };
}
