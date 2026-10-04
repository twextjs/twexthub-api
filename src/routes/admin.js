import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { renderRegistryMetrics } from '../observability.js';
import { fieldErrors, notFound } from '../errors.js';
import { legalDocumentToObject } from '../serialize.js';
import { notifyUsersMatching, termsBumpedMessage } from '../notify.js';
import { audit, auditRowToObject } from '../audit.js';
import {
  applyServerConfig,
  configStorage,
  editableSettings,
  EDITABLE_SETTINGS,
} from '../server-config.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';

// trim() is applied to the broadcast message before insert, so this limit
// applies to the trimmed length.
const BROADCAST_MAX_LENGTH = 280;
import { requireObjectBody } from './shared.js';

export function makeAdminRouter({ sql, config, termsGate, storageProbe = {} }) {
  const router = Router();

  router.get('/admin/metrics', requireAdmin, async (req, res) => {
    res
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(await renderRegistryMetrics(sql, req.app.locals.telemetry));
  });

  // The instance's own configuration, as far as an admin is allowed to change
  // it. editable is false when the file cannot hold a change -- see
  // configStorage for why a file inside the container counts as read-only.
  router.get('/admin/config', requireAdmin, async (req, res) => {
    const storage = configStorage(config.configPath ?? 'config.yaml', storageProbe);
    res.json({
      editable: storage.persistent,
      reason: storage.reason,
      configPath: storage.path,
      settings: editableSettings(config),
    });
  });

  router.put('/admin/config', requireAdmin, async (req, res) => {
    requireObjectBody(req);
    const patch = req.body.settings;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw fieldErrors([{ field: 'settings', message: 'Must be an object of settings.' }]);
    }
    const known = new Set(EDITABLE_SETTINGS.map((setting) => setting.key));
    const unknown = Object.keys(patch).filter((key) => !known.has(key));
    if (unknown.length) {
      // Refused rather than ignored: silently dropping a key an admin believed
      // they had set is how somebody ends up believing the database URL moved.
      throw fieldErrors(
        unknown.map((key) => ({
          field: key,
          message: 'This setting cannot be changed from the admin interface.',
        })),
      );
    }

    const result = applyServerConfig({
      config,
      configPath: config.configPath ?? 'config.yaml',
      patch,
      ...storageProbe,
    });

    if (Object.keys(result.changes).length) {
      // Awaited, unlike the post-commit actions elsewhere. applyServerConfig has
      // already rewritten the file and the live config, and a file write cannot
      // be rolled back, so this row is the only record that the change happened.
      // Awaiting it does not make the two atomic; it makes a failed write reach
      // the admin instead of leaving an unlogged change behind a 200.
      await audit(sql, req.auth.user, 'config.update', {}, { changed: result.changes });
    }
    res.json({
      changed: result.changes,
      restartRequired: result.restartRequired,
      settings: editableSettings(config),
    });
  });

  function makeLegalDocumentHandler(kind, bodyError) {
    return async (req, res) => {
      requireObjectBody(req);
      const body = req.body.body;
      if (typeof body !== 'string' || body.length === 0) {
        throw fieldErrors([{ field: 'body', message: bodyError }]);
      }
      const row = await sql.begin(async (tx) => {
        const [doc] = await tx`
          INSERT INTO legal_documents (kind, body)
          VALUES (${kind}, ${body})
          ON CONFLICT (kind)
          DO UPDATE SET
            version = legal_documents.version + 1,
            body = EXCLUDED.body,
            updated_at = now()
          RETURNING *
        `;
        // A first insert (version 1) is not a bump, and only accounts that
        // accepted a previous version are blocked by the gate afterwards.
        if (kind === 'terms' && doc.version > 1) {
          await notifyUsersMatching(
            tx,
            tx`WHERE terms_accepted_version IS NOT NULL`,
            'terms.bumped',
            termsBumpedMessage(doc.version),
            { version: doc.version, previousVersion: doc.version - 1 },
          );
        }
        return doc;
      });
      termsGate.invalidate?.();
      res.json(legalDocumentToObject(row));
    };
  }

  router.patch(
    '/admin/terms',
    requireAdmin,
    termsGate,
    makeLegalDocumentHandler('terms', 'Terms body is required.'),
  );
  router.patch(
    '/admin/privacy',
    requireAdmin,
    termsGate,
    makeLegalDocumentHandler('privacy', 'Privacy body is required.'),
  );

  router.post('/admin/notifications', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const { message } = req.body;
    if (
      typeof message !== 'string' ||
      message.trim().length === 0 ||
      message.length > BROADCAST_MAX_LENGTH
    ) {
      throw fieldErrors([
        {
          field: 'message',
          message: `A message is required, at most ${BROADCAST_MAX_LENGTH} characters.`,
        },
      ]);
    }
    const created = await sql.begin((tx) =>
      notifyUsersMatching(tx, tx``, 'broadcast', message.trim()),
    );
    res.status(201).json({ created });
  });

  router.patch('/admin/users/:namespace/quota', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${req.params.namespace}`;
    if (!user) throw notFound('No such account.');
    const { maxBlobBytes } = req.body;
    if (maxBlobBytes !== null && (!Number.isInteger(maxBlobBytes) || maxBlobBytes <= 0)) {
      throw fieldErrors([
        { field: 'maxBlobBytes', message: 'Must be a positive integer, or null for the default.' },
      ]);
    }
    const updated = await sql.begin(async (tx) => {
      const [row] = await tx`
        UPDATE users SET max_blob_bytes = ${maxBlobBytes}
        WHERE id = ${user.id}
        RETURNING id, namespace, blob_bytes, max_blob_bytes
      `;
      await audit(
        tx,
        req.auth.user,
        'quota.set',
        { namespace: user.namespace },
        {
          maxBlobBytes,
          previousMaxBlobBytes: user.max_blob_bytes,
        },
      );
      return row;
    });
    res.json({
      namespace: updated.namespace,
      blobBytes: Number(updated.blob_bytes),
      maxBlobBytes: updated.max_blob_bytes === null ? null : Number(updated.max_blob_bytes),
    });
  });

  router.get('/admin/users/:namespace/quota', requireAdmin, async (req, res) => {
    const [user] = await sql`
      SELECT namespace, blob_bytes, max_blob_bytes FROM users
      WHERE namespace = ${req.params.namespace}
    `;
    if (!user) throw notFound('No such account.');
    res.json({
      namespace: user.namespace,
      blobBytes: Number(user.blob_bytes),
      maxBlobBytes: user.max_blob_bytes === null ? null : Number(user.max_blob_bytes),
    });
  });

  router.get('/admin/audit', requireAdmin, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const rows = await sql`
      SELECT * FROM audit_log
      ${cursor ? (back ? sql`WHERE id > ${cursor.i}` : sql`WHERE id < ${cursor.i}`) : sql``}
      ORDER BY id ${back ? sql`ASC` : sql`DESC`}
      LIMIT ${limit + 1}
    `;
    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: auditRowToObject,
        keyOf: (row) => ({ i: Number(row.id) }),
      }),
    );
  });

  return router;
}
