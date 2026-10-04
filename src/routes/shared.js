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
export async function createSession(sql, userId, sessionTtlMs) {
  const token = newToken();
  const [row] = await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashToken(token)}, ${new Date(Date.now() + sessionTtlMs)})
    RETURNING *
  `;
  return { token, session: row };
}

export async function resolveTargetUser(sql, req) {
  const me = req.auth.user;
  const ns = req.query.namespace;
  if (ns === undefined) return me;
  if (typeof ns !== 'string') {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid namespace parameter.' });
  }
  if (me.role !== 'admin' && ns !== me.namespace) {
    throw forbidden('Only an admin can inspect another account.');
  }
  const [user] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
  if (!user) throw notFound('No such user.');
  return user;
}
