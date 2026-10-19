import { hashToken, newToken } from '../auth.js';
import { forbidden, HttpError, notFound } from '../errors.js';
import { isPlainObject } from '../util.js';

export function requireObjectBody(req) {
  if (!isPlainObject(req.body)) {
    throw new HttpError(422, {
      title: 'Validation Error',
      detail: 'Request body must be a JSON object.',
    });
  }
}

// A session is created in two places: when an account signs up and when it
// signs in. Both hand back the plaintext token, because the row only holds its
// hash, and it is shown exactly once.
export async function createSession(db, userId, sessionTtlMs) {
  const token = newToken();
  const session = await db.Sessions.create({
    data: {
      UserId: userId,
      TokenHash: hashToken(token),
      ExpiresAt: new Date(Date.now() + sessionTtlMs),
    },
  });
  return { token, session };
}

export async function resolveTargetUser(db, req) {
  const me = req.auth.user;
  const ns = req.query.namespace;
  if (ns === undefined) return me;
  if (typeof ns !== 'string') {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid namespace parameter.' });
  }
  if (me.Role !== 'admin' && ns !== me.Namespace) {
    throw forbidden('Only an admin can inspect another account.');
  }
  const user = await db.Users.findUnique({ where: { Namespace: ns } });
  if (!user) throw notFound('No such user.');
  return user;
}
