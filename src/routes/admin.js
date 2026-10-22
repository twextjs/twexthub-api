import { Router } from 'express';
import { Prisma } from '../../prisma/generated/client/index.js';
import { requireAdmin } from '../auth.js';
import { renderRegistryMetrics } from '../observability.js';
import { fieldErrors, notFound } from '../errors.js';
import { legalDocumentToObject, reportToObject } from '../serialize.js';
import { notifyUsersMatching, termsBumpedMessage } from '../notify.js';
import { audit, auditRowToObject } from '../audit.js';
import {
  applyServerConfig,
  configStorage,
  editableSettings,
  EDITABLE_SETTINGS,
} from '../server-config.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import {
  MAX_REPORT_RESOLUTION_NOTE,
  REPORT_DECISIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from '../reports.js';

// trim() is applied to the broadcast message before insert, so this limit
// applies to the trimmed length.
const BROADCAST_MAX_LENGTH = 280;
import { requireObjectBody } from './shared.js';

export function makeAdminRouter({ db, config, termsGate, storageProbe = {} }) {
  const router = Router();

  router.get('/admin/metrics', requireAdmin, async (req, res) => {
    res
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(await renderRegistryMetrics(db, req.app.locals.telemetry));
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
      await audit(db, req.auth.user, 'config.update', {}, { changed: result.changes });
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
      const row = await db.$transaction(async (tx) => {
        const doc = await tx.LegalDocuments.upsert({
          where: { Kind: kind },
          create: { Kind: kind, Body: body },
          update: { Version: { increment: 1 }, Body: body, UpdatedAt: new Date() },
        });
        // A first insert (version 1) is not a bump, and only accounts that
        // accepted a previous version are blocked by the gate afterwards.
        if (kind === 'terms' && doc.Version > 1) {
          await notifyUsersMatching(
            tx,
            Prisma.sql`WHERE "TermsAcceptedVersion" IS NOT NULL`,
            'terms.bumped',
            termsBumpedMessage(doc.Version),
            { version: doc.Version, previousVersion: doc.Version - 1 },
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
    const created = await db.$transaction((tx) =>
      notifyUsersMatching(tx, Prisma.empty, 'broadcast', message.trim()),
    );
    res.status(201).json({ created });
  });

  router.patch('/admin/users/:namespace/quota', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const user = await db.Users.findUnique({ where: { Namespace: req.params.namespace } });
    if (!user) throw notFound('No such account.');
    const { maxBlobBytes } = req.body;
    if (maxBlobBytes !== null && (!Number.isInteger(maxBlobBytes) || maxBlobBytes <= 0)) {
      throw fieldErrors([
        { field: 'maxBlobBytes', message: 'Must be a positive integer, or null for the default.' },
      ]);
    }
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.Users.update({
        where: { Id: user.Id },
        data: { MaxBlobBytes: maxBlobBytes },
        select: { Id: true, Namespace: true, BlobBytes: true, MaxBlobBytes: true },
      });
      // The audit detail is a JSON column, so the previous quota is folded to a
      // number rather than handed over as a BigInt.
      await audit(
        tx,
        req.auth.user,
        'quota.set',
        { namespace: user.Namespace },
        {
          maxBlobBytes,
          previousMaxBlobBytes: user.MaxBlobBytes === null ? null : Number(user.MaxBlobBytes),
        },
      );
      return row;
    });
    res.json({
      namespace: updated.Namespace,
      blobBytes: Number(updated.BlobBytes),
      maxBlobBytes: updated.MaxBlobBytes === null ? null : Number(updated.MaxBlobBytes),
    });
  });

  router.get('/admin/users/:namespace/quota', requireAdmin, async (req, res) => {
    const user = await db.Users.findUnique({
      where: { Namespace: req.params.namespace },
      select: { Namespace: true, BlobBytes: true, MaxBlobBytes: true },
    });
    if (!user) throw notFound('No such account.');
    res.json({
      namespace: user.Namespace,
      blobBytes: Number(user.BlobBytes),
      maxBlobBytes: user.MaxBlobBytes === null ? null : Number(user.MaxBlobBytes),
    });
  });

  // The report queue. A report is read here and nowhere else: the account
  // that filed it may look at its own, and a reviewer looks at these. Deciding
  // a report records who decided it, when, and why -- it does not act on the
  // target. Nothing counts reports and suspends anybody; enforcement stays a
  // decision somebody makes by hand.
  router.get('/admin/reports', requireAdmin, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const where = {};
    const { status, targetType } = req.query;
    if (status !== undefined) {
      if (typeof status !== 'string' || !REPORT_STATUSES.includes(status)) {
        throw fieldErrors([
          { field: 'status', message: `Must be one of: ${REPORT_STATUSES.join(', ')}.` },
        ]);
      }
      where.Status = status;
    }
    if (targetType !== undefined) {
      if (typeof targetType !== 'string' || !REPORT_TARGET_TYPES.includes(targetType)) {
        throw fieldErrors([
          {
            field: 'targetType',
            message: `Must be one of: ${REPORT_TARGET_TYPES.join(', ')}.`,
          },
        ]);
      }
      where.TargetType = targetType;
    }
    if (cursor) where.Id = back ? { gt: cursor.i } : { lt: cursor.i };
    const rows = await db.Reports.findMany({
      where,
      orderBy: { Id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });
    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: reportToObject,
        keyOf: (row) => ({ i: Number(row.Id) }),
      }),
    );
  });

  router.get('/admin/reports/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const row = await db.Reports.findUnique({ where: { Id: id } });
    if (!row) throw notFound();
    res.json(reportToObject(row));
  });

  router.patch('/admin/reports/:id', requireAdmin, async (req, res) => {
    requireObjectBody(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const status = req.body.status;
    if (typeof status !== 'string' || !REPORT_DECISIONS.includes(status)) {
      throw fieldErrors([
        { field: 'status', message: `Must be one of: ${REPORT_DECISIONS.join(', ')}.` },
      ]);
    }
    const note = req.body.note ?? null;
    if (
      note !== null &&
      (typeof note !== 'string' ||
        note.trim().length === 0 ||
        note.length > MAX_REPORT_RESOLUTION_NOTE)
    ) {
      throw fieldErrors([
        {
          field: 'note',
          message: `Must be a non-empty string of at most ${MAX_REPORT_RESOLUTION_NOTE} characters.`,
        },
      ]);
    }
    const existing = await db.Reports.findUnique({ where: { Id: id } });
    if (!existing) throw notFound();
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.Reports.update({
        where: { Id: id },
        data: {
          Status: status,
          ReviewedBy: req.auth.user.Id,
          ReviewedByNamespace: req.auth.user.Namespace,
          ReviewedAt: new Date(),
          ResolutionNote: note === null ? null : note.trim(),
          UpdatedAt: new Date(),
        },
      });
      // The decision is the accountable half of a report, so it is written to
      // the audit trail with the reviewer who made it. A decision may be
      // revised; the trail keeps the earlier one.
      await audit(
        tx,
        req.auth.user,
        status === 'resolved' ? 'report.resolve' : 'report.dismiss',
        { namespace: row.TargetNamespace, id: row.TargetExtensionId || null },
        { reportId: String(row.Id), status: row.Status, note: row.ResolutionNote },
      );
      return row;
    });
    res.json(reportToObject(updated));
  });

  router.get('/admin/audit', requireAdmin, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const rows = await db.AuditLog.findMany({
      where: cursor ? (back ? { Id: { gt: cursor.i } } : { Id: { lt: cursor.i } }) : {},
      orderBy: { Id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });
    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: auditRowToObject,
        keyOf: (row) => ({ i: Number(row.Id) }),
      }),
    );
  });

  return router;
}
