import { Router } from 'express';
import { requireScope, requireSession } from '../auth.js';
import { hashPassword, verifyPassword } from '../password.js';
import { forbidden, notFound, unauthorized } from '../errors.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { isValidNamespace, normalizeApiRoot } from '../util.js';
import { sessionToObject, userToObject } from '../serialize.js';
import { createSession, requireObjectBody, resolveTargetUser } from './shared.js';

export function makeSessionsRouter({ db, config, termsGate, rateLimiter }) {
  const router = Router();
  // Listing and revoking other sessions is a grantable permission, so a token
  // holding it can sign the account out everywhere but its own session.
  const guard = [requireScope('manage:sessions'), termsGate];
  const scrypt = config.auth.scrypt;
  const sessionTtlMs = config.auth.sessionTtlDays * 86_400_000;
  let dummyHashPromise;
  const dummyHash = () => {
    dummyHashPromise ??= hashPassword('invalid-password-placeholder', scrypt);
    return dummyHashPromise;
  };

  // Signing in is creating a session, so it is a POST on the collection. The
  // body carries the credentials rather than a namespace in the path, because
  // the account is the subject of the credential, not of the URL.
  router.post('/', async (req, res) => {
    // IdP-only mode: the provider is the only way in, so a password presented
    // here is refused before it is even looked at.
    if (config.auth.oidc.required) {
      throw forbidden('Password sign-in is turned off. Sign in with the identity provider.');
    }
    requireObjectBody(req);
    const { namespace, password } = req.body;
    if (
      typeof namespace !== 'string' ||
      !isValidNamespace(namespace) ||
      typeof password !== 'string'
    ) {
      throw unauthorized('Invalid namespace or password.');
    }

    const recordFailures = await Promise.all([
      rateLimiter.loginCheck(`login:${namespace}|${req.ip}`),
      rateLimiter.loginCheck(`login:ip:${req.ip}`),
    ]);

    const user = await db.users.findUnique({ where: { namespace } });
    // An organization is a pseudo-account with no password, and its namespace is
    // public knowledge, so this says what it is instead of pretending the
    // credentials were wrong.
    if (user?.kind === 'organization') {
      throw forbidden(`@${namespace} is an organization, which cannot sign in.`);
    }
    const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash());
    if (!user || !ok) {
      await Promise.all(recordFailures.map((record) => record()));
      throw unauthorized('Invalid namespace or password.');
    }

    const created = await createSession(db, user.id, sessionTtlMs);
    const root = normalizeApiRoot(config.apiRoot);
    res
      .location(`${root ? `/${root}` : ''}/sessions/${created.session.id}`)
      .status(201)
      .json({
        session: sessionToObject(created.session),
        user: userToObject(user, config),
        token: created.token,
      });
  });

  router.get('/', guard, async (req, res) => {
    const user = await resolveTargetUser(db, req);
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);

    const rows = await db.sessions.findMany({
      where: {
        user_id: user.id,
        ...(cursor ? (back ? { id: { gt: cursor.i } } : { id: { lt: cursor.i } }) : {}),
      },
      orderBy: { id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: sessionToObject,
        keyOf: (row) => ({ i: Number(row.id) }),
      }),
    );
  });

  // `current` is the session making the request, so a client that never kept its
  // own id can still sign itself out. It is exempt from the terms gate, like
  // signing out always has to be: an account that has just been bumped to new
  // terms is exactly the one that needs to be able to end its session. It is
  // also the one route that stays session-only, because the id it deletes is
  // the caller's own token id and the two tables number their rows
  // independently, so a token id matched against this table would end somebody
  // else's session.
  router.delete('/current', requireSession, async (req, res) => {
    await db.sessions.deleteMany({ where: { id: req.auth.tokenId } });
    res.status(204).end();
  });

  router.delete('/:id', guard, async (req, res) => {
    const targetId = Number(req.params.id);
    const isNumeric = Number.isSafeInteger(targetId) && targetId > 0;
    const row = isNumeric ? await db.sessions.findUnique({ where: { id: targetId } }) : null;
    if (!row) throw notFound();
    if (Number(row.user_id) !== Number(req.auth.user.id) && req.auth.user.role !== 'admin') {
      throw forbidden("Only an admin can revoke another account's sessions.");
    }
    await db.sessions.deleteMany({ where: { id: targetId } });
    res.status(204).end();
  });

  return router;
}
