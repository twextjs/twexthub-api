import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { fieldErrors, HttpError, notFound } from '../errors.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { notificationToObject } from '../serialize.js';
import { requireObjectBody } from './shared.js';

const MAX_MARK_READ = 100;

export function makeNotificationsRouter({ sql, config }) {
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

    const rows = await sql`
      SELECT * FROM notifications
      WHERE user_id = ${req.auth.user.id}
        ${unread === 'true' ? sql`AND read_at IS NULL` : sql``}
        ${cursor ? (back ? sql`AND id > ${cursor.i}` : sql`AND id < ${cursor.i}`) : sql``}
      ORDER BY id ${back ? sql`ASC` : sql`DESC`}
      LIMIT ${limit + 1}
    `;

    const [counts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE read_at IS NULL) AS unread,
        COUNT(*) AS total
      FROM notifications
      WHERE user_id = ${req.auth.user.id}
    `;

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: notificationToObject,
        keyOf: (row) => ({ i: Number(row.id) }),
        extra: { unreadCount: Number(counts.unread) },
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
      const updated = await sql`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${req.auth.user.id} AND read_at IS NULL
      `;
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

    const updated = await sql`
      UPDATE notifications SET read_at = now()
      WHERE user_id = ${req.auth.user.id} AND id IN ${sql(parsed)} AND read_at IS NULL
      RETURNING id
    `;
    res.json({ updated: updated.count });
  });

  router.patch('/:id', guard, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const [row] = await sql`
      UPDATE notifications SET read_at = now()
      WHERE id = ${id} AND user_id = ${req.auth.user.id}
      RETURNING *
    `;
    if (!row) throw notFound();
    res.json(notificationToObject(row));
  });

  return router;
}
