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

    const rows = await db.Notifications.findMany({
      where: {
        UserId: req.auth.user.Id,
        ...(unread === 'true' ? { ReadAt: null } : {}),
        ...(cursor ? (back ? { Id: { gt: cursor.i } } : { Id: { lt: cursor.i } }) : {}),
      },
      orderBy: { Id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });

    // Only the unread tally is read out; a filtered count keeps it one column.
    const unreadCount = await db.Notifications.count({
      where: { UserId: req.auth.user.Id, ReadAt: null },
    });

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: notificationToObject,
        keyOf: (row) => ({ i: Number(row.Id) }),
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
      const updated = await db.Notifications.updateMany({
        where: { UserId: req.auth.user.Id, ReadAt: null },
        data: { ReadAt: new Date() },
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

    const updated = await db.Notifications.updateMany({
      where: { UserId: req.auth.user.Id, Id: { in: parsed }, ReadAt: null },
      data: { ReadAt: new Date() },
    });
    res.json({ updated: updated.count });
  });

  router.patch('/:id', guard, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const updated = await db.Notifications.updateMany({
      where: { Id: id, UserId: req.auth.user.Id },
      data: { ReadAt: new Date() },
    });
    if (updated.count === 0) throw notFound();
    const row = await db.Notifications.findUnique({ where: { Id: id } });
    res.json(notificationToObject(row));
  });

  return router;
}
