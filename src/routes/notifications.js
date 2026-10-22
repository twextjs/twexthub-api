import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { fieldErrors, HttpError, notFound } from '../errors.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { notificationToObject } from '../serialize.js';
import { requireObjectBody } from './shared.js';

const MAX_MARK_READ = 100;

export function makeNotificationsRouter({ db, config }) {
  const router = Router();
  const guard = [requireAuth];

  router.get('/', guard, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const { unread } = req.query;
    if (unread !== undefined && unread !== 'true') {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid unread.' });
    }

    const rows = await db.notifications.findMany({
      where: {
        user_id: req.auth.user.id,
        ...(unread === 'true' ? { read_at: null } : {}),
        ...(cursor ? (back ? { id: { gt: cursor.i } } : { id: { lt: cursor.i } }) : {}),
      },
      orderBy: { id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });

    // Only the unread tally is read out; a filtered count keeps it one column.
    const unreadCount = await db.notifications.count({
      where: { user_id: req.auth.user.id, read_at: null },
    });

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: notificationToObject,
        keyOf: (row) => ({ i: Number(row.id) }),
        extra: { unreadCount },
      }),
    );
  });

  // Read state is a property of the notification, so it is patched on the
  // resource: the collection form for a client's whole mailbox or a chosen set,
  // and the single form for the one it just rendered.
  router.patch('/', guard, async (req, res) => {
    requireObjectBody(req);
    const { ids, all } = req.body;
    if ((ids === undefined) === (all === undefined)) {
      throw fieldErrors([
        { field: 'ids', message: 'Provide either "ids" or "all", not both or neither.' },
      ]);
    }

    if (all !== undefined) {
      if (all !== true) {
        throw fieldErrors([{ field: 'all', message: 'Must be true when provided.' }]);
      }
      const updated = await db.notifications.updateMany({
        where: { user_id: req.auth.user.id, read_at: null },
        data: { read_at: new Date() },
      });
      return res.json({ updated: updated.count });
    }

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MARK_READ) {
      throw fieldErrors([
        { field: 'ids', message: `Must be a non-empty array of at most ${MAX_MARK_READ} ids.` },
      ]);
    }
    const parsed = [];
    for (const id of ids) {
      const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN;
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw fieldErrors([{ field: 'ids', message: 'Ids must be positive integers.' }]);
      }
      parsed.push(n);
    }

    const updated = await db.notifications.updateMany({
      where: { user_id: req.auth.user.id, id: { in: parsed }, read_at: null },
      data: { read_at: new Date() },
    });
    res.json({ updated: updated.count });
  });

  router.patch('/:id', guard, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const updated = await db.notifications.updateMany({
      where: { id, user_id: req.auth.user.id },
      data: { read_at: new Date() },
    });
    if (updated.count === 0) throw notFound();
    const row = await db.notifications.findUnique({ where: { id } });
    res.json(notificationToObject(row));
  });

  return router;
}
