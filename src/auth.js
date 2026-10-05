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

export function makeAuthenticate(sql) {
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
    const found = await lookupToken(sql, hash);
    req.auth = found
      ? {
          user: found.user,
          tokenType: found.tokenType,
          scopes: found.scopes,
          tokenId: found.tokenId,
        }
      : null;

    if (found && shouldTouchLastUsed(found.lastUsedAt)) {
      const table = found.tokenType === 'session' ? 'sessions' : 'automation_tokens';
      try {
        await sql`UPDATE ${sql(table)} SET last_used_at = now() WHERE id = ${found.tokenId}`;
      } catch (error) {
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

async function lookupToken(sql, hash) {
  const [session] = await sql`
    SELECT s.id AS token_id, s.expires_at, s.last_used_at,
      u.id, u.namespace, u.display_name, u.role, u.has_published, u.terms_accepted_version, u.created_at,
      u.bio, u.website, u.github, u.avatar_url, u.banner_url, u.avatar_blob_digest, u.banner_blob_digest
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash}
  `;
  if (session) {
    if (session.expires_at && session.expires_at <= new Date()) return null;
    return {
      tokenId: session.token_id,
      tokenType: 'session',
      // A session is the full authority of the account, so it satisfies every
      // scope. Copied per request so nothing can widen them in place.
      scopes: [...SCOPES],
      lastUsedAt: session.last_used_at,
      user: session,
    };
  }

  const [token] = await sql`
    SELECT t.id AS token_id, t.expires_at, t.last_used_at, t.scopes,
      u.id, u.namespace, u.display_name, u.role, u.has_published, u.terms_accepted_version, u.created_at,
      u.bio, u.website, u.github, u.avatar_url, u.banner_url, u.avatar_blob_digest, u.banner_blob_digest
    FROM automation_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${hash}
  `;
  if (!token) return null;
  if (token.expires_at && token.expires_at <= new Date()) return null;
  return {
    tokenId: token.token_id,
    tokenType: 'automation',
    scopes: token.scopes,
    lastUsedAt: token.last_used_at,
    user: token,
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
// else's extension.
export async function isExtensionOwner(sql, user, namespace, id) {
  const [row] = await sql`
    SELECT 1
    FROM extension_owners o
    WHERE o.namespace = ${namespace} AND o.extension_id = ${id}
      AND (
        o.owner_id = ${user.id}
        OR EXISTS (
          SELECT 1 FROM organization_owners g
          WHERE g.org_id = o.owner_id AND g.user_id = ${user.id}
        )
      )
  `;
  return Boolean(row);
}

// Whether an account may act for an organization by name. Used where the
// organization is identified by its namespace rather than by an ownership row:
// accepting an invitation addressed to it, for one.
export async function isOrganizationOwner(sql, user, namespace) {
  const [row] = await sql`
    SELECT 1
    FROM organization_owners g
    JOIN users org ON org.id = g.org_id
    WHERE g.user_id = ${user.id} AND org.namespace = ${namespace}
      AND org.kind = 'organization'
  `;
  return Boolean(row);
}

// The same answer as a list, for the places that need it as one: the listing
// filter carries the namespaces rather than testing each row, and an
// organization holding an invitation needs to know it is waiting.
export async function organizationsOwnedBy(sql, user) {
  const rows = await sql`
    SELECT org.namespace
    FROM organization_owners g
    JOIN users org ON org.id = g.org_id
    WHERE g.user_id = ${user.id} AND org.kind = 'organization'
  `;
  return rows.map((row) => row.namespace);
}

export function requireSession(req, res, next) {
  if (!req.auth) throw unauthorized();
  if (req.auth.tokenType !== 'session') {
    throw forbidden('Automation tokens cannot access this endpoint.');
  }
  next();
}

// Admin authority is two separate things: the account carries the admin role,
// and the credential is allowed to use the admin surface. A session always has
// every scope, so a session admin passes on the role alone. An automation token
// has to have been granted `admin` as well, and the role check still runs
// first, so a normal account cannot mint itself an admin token.
export function isAdmin(auth) {
  return Boolean(auth) && auth.user.role === 'admin' && auth.scopes.includes('admin');
}

// Throws the specific reason; the callers that have a message of their own to
// add (a review, say) would rather call this than restate both checks.
export function assertAdmin(auth) {
  if (!auth) throw unauthorized();
  if (auth.user.role !== 'admin') {
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

export function makeRequireTerms(sql) {
  let cachedVersion;
  let cachedAt = 0;

  async function requireTerms(req, res, next) {
    requireAuth(req, res, () => {});
    const now = Date.now();
    if (cachedVersion === undefined || cachedVersion === null || now - cachedAt > 60_000) {
      const [terms] = await sql`SELECT version FROM legal_documents WHERE kind = 'terms'`;
      cachedVersion = terms ? terms.version : null;
      cachedAt = now;
    }
    const accepted = req.auth.user.terms_accepted_version;
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
