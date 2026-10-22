import { Router } from 'express';
import { hashToken, newToken, requireAuth, requireScope, SCOPES } from '../auth.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { fieldErrors, forbidden, notFound } from '../errors.js';
import { automationTokenToObject } from '../serialize.js';
import { requireObjectBody, resolveTargetUser } from './shared.js';

export function makeTokensRouter({ db, config }) {
  const router = Router();

  // Mints, edits and revocations are a permission in their own right rather
  // than a session privilege, so a token granted this can manage tokens within
  // the authority of its own account.
  const manageTokens = requireScope('manage:tokens');

  // A credential can only pass on permissions it holds itself, so a leaked token
  // can never be used to mint a stronger one. A session holds every scope, so
  // for the dashboard this is a no-op.
  function validateScopes(scopes, callerScopes) {
    const errors = [];
    if (!Array.isArray(scopes) || scopes.length < 1) {
      errors.push({ field: 'scopes', message: 'At least one scope is required.' });
    } else {
      for (const scope of scopes) {
        if (!SCOPES.includes(scope)) {
          errors.push({ field: 'scopes', message: `Unknown scope "${scope}".` });
        } else if (!callerScopes.includes(scope)) {
          errors.push({ field: 'scopes', message: `This token is missing the "${scope}" scope.` });
        }
      }
    }
    if (errors.length > 0) throw fieldErrors(errors);
    return [...new Set(scopes)];
  }

  router.get('/', manageTokens, async (req, res) => {
    const user = await resolveTargetUser(db, req);
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);

    const rows = await db.automation_tokens.findMany({
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
        serialize: automationTokenToObject,
        keyOf: (row) => ({ i: Number(row.id) }),
      }),
    );
  });

  router.post('/', manageTokens, async (req, res) => {
    requireObjectBody(req);
    const { name, scopes, expiresInDays } = req.body;

    const errors = [];
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
      errors.push({
        field: 'name',
        message: 'Name must be a non-empty string of at most 80 characters.',
      });
    }
    if (expiresInDays !== undefined) {
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1) {
        errors.push({
          field: 'expiresInDays',
          message: 'Must be a positive integer when provided.',
        });
      } else {
        const expiry = new Date(Date.now() + expiresInDays * 86_400_000);
        if (!Number.isFinite(expiry.getTime())) {
          errors.push({ field: 'expiresInDays', message: 'Expiration is too far in the future.' });
        }
      }
    }
    if (errors.length > 0) throw fieldErrors(errors);

    const cleanScopes = validateScopes(scopes, req.auth.scopes);
    const token = newToken();
    const expiresAt =
      expiresInDays !== undefined ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

    const row = await db.automation_tokens.create({
      data: {
        user_id: req.auth.user.id,
        name,
        token_hash: hashToken(token),
        scopes: cleanScopes,
        expires_at: expiresAt,
      },
    });

    res.status(201).json({ ...automationTokenToObject(row), token });
  });

  router.patch('/:id', manageTokens, async (req, res) => {
    requireObjectBody(req);
    const { name, scopes } = req.body;
    if (name === undefined && scopes === undefined) {
      throw fieldErrors([{ field: 'body', message: 'Provide at least name or scopes.' }]);
    }

    const targetId = Number(req.params.id);
    const row =
      Number.isSafeInteger(targetId) && targetId > 0
        ? await db.automation_tokens.findUnique({ where: { id: targetId } })
        : null;
    if (!row) throw notFound();
    if (Number(row.user_id) !== Number(req.auth.user.id) && req.auth.user.role !== 'admin') {
      throw forbidden("Only an admin can modify another account's tokens.");
    }

    if (
      name !== undefined &&
      (typeof name !== 'string' || name.trim().length === 0 || name.length > 80)
    ) {
      throw fieldErrors([
        { field: 'name', message: 'Name must be a non-empty string of at most 80 characters.' },
      ]);
    }
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (scopes !== undefined) patch.scopes = validateScopes(scopes, req.auth.scopes);

    const updated = await db.automation_tokens.update({ where: { id: targetId }, data: patch });

    res.json(automationTokenToObject(updated));
  });

  // The counterpart of `DELETE /sessions/current`: an automation token that
  // revokes itself, without the caller having to know its own id. A session is
  // not a token, so it has no row here to delete and is told so rather than
  // having a session id matched against this table.
  router.delete('/current', requireAuth, async (req, res) => {
    if (req.auth.tokenType !== 'automation') {
      throw forbidden('This is a session; use DELETE /sessions/current to end it.');
    }
    await db.automation_tokens.deleteMany({ where: { id: req.auth.tokenId } });
    res.status(204).end();
  });

  router.delete('/:id', manageTokens, async (req, res) => {
    const targetId = Number(req.params.id);
    const row =
      Number.isSafeInteger(targetId) && targetId > 0
        ? await db.automation_tokens.findUnique({ where: { id: targetId } })
        : null;
    if (!row) throw notFound();
    if (Number(row.user_id) !== Number(req.auth.user.id) && req.auth.user.role !== 'admin') {
      throw forbidden("Only an admin can revoke another account's tokens.");
    }
    await db.automation_tokens.deleteMany({ where: { id: targetId } });
    res.status(204).end();
  });

  return router;
}
