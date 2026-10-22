import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { conflict, fieldErrors, forbidden, notFound } from '../errors.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { requireObjectBody } from './shared.js';
import { audit } from '../audit.js';

const REASON_MAX_LENGTH = 2000;

function reportToObject(row) {
  return {
    id: String(row.Id),
    reporterId: row.ReporterId ? String(row.ReporterId) : null,
    targetType: row.TargetType,
    targetNamespace: row.TargetNamespace ?? null,
    targetExtensionId: row.TargetExtensionId ?? null,
    targetUserId: row.TargetUserId ? String(row.TargetUserId) : null,
    reason: row.Reason,
    description: row.Description,
    status: row.Status,
    reviewedBy: row.ReviewedBy ? String(row.ReviewedBy) : null,
    reviewedAt: row.ReviewedAt ? row.ReviewedAt.toISOString() : null,
    resolutionNote: row.ResolutionNote ?? null,
    createdAt: row.CreatedAt.toISOString(),
    updatedAt: row.UpdatedAt.toISOString(),
  };
}

function normalizeTargetType(type) {
  if (typeof type !== 'string') return null;
  const t = type.trim().toLowerCase();
  if (t === 'user' || t === 'account') return 'user';
  if (t === 'org' || t === 'organization') return 'organization';
  if (t === 'extension' || t === 'package') return 'extension';
  return t;
}

export function makeReportsRouter({ db, config, rateLimiter }) {
  const router = Router();

  router.post('/reports', requireAuth, async (req, res) => {
    requireObjectBody(req);
    const body = req.body;

    const targetType = normalizeTargetType(body.targetType ?? body.type);
    if (!targetType) {
      throw fieldErrors([{ field: 'targetType', message: 'targetType is required.' }]);
    }
    if (!['user', 'organization', 'extension'].includes(targetType)) {
      throw fieldErrors([{ field: 'targetType', message: 'Invalid targetType.' }]);
    }

    if (targetType === 'extension') {
      if (typeof body.targetNamespace !== 'string' || typeof body.targetExtensionId !== 'string') {
        throw fieldErrors([
          { field: 'targetNamespace', message: 'targetNamespace is required.' },
          { field: 'targetExtensionId', message: 'targetExtensionId is required.' },
        ]);
      }
    } else if (targetType === 'user' || targetType === 'organization') {
      if (typeof body.targetNamespace !== 'string') {
        throw fieldErrors([{ field: 'targetNamespace', message: 'targetNamespace is required.' }]);
      }
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length === 0 || reason.length > REASON_MAX_LENGTH) {
      throw fieldErrors([
        { field: 'reason', message: `Reason must be between 1 and ${REASON_MAX_LENGTH} characters.` },
      ]);
    }

    const description =
      typeof body.description === 'string'
        ? body.description.trim()
        : typeof body.body === 'string'
          ? body.body.trim()
          : '';
    if (description.length === 0 || description.length > REASON_MAX_LENGTH) {
      throw fieldErrors([
        { field: 'description', message: `Description must be between 1 and ${REASON_MAX_LENGTH} characters.` },
      ]);
    }

    // Rate limit submissions
    if (rateLimiter) {
      await rateLimiter.signupCheck?.(`report:${req.auth.user.Id}`)();
      // Fallback to general rate limiting pattern if needed
    }

    let targetUserId = null;
    if (targetType === 'user' || targetType === 'organization') {
      const targetUser = await db.Users.findUnique({
        where: { Namespace: body.targetNamespace },
      });
      if (!targetUser) {
        throw notFound('No such account.');
      }
      // For org, also ensure it's an org? The requirement says "user accounts, extensions, and organizations"
      targetUserId = targetUser.Id;
    } else if (targetType === 'extension') {
      // Verify extension exists
      const version = await db.Versions.findFirst({
        where: {
          Namespace: body.targetNamespace,
          ExtensionId: body.targetExtensionId,
          Status: { in: ['published', 'deprecated', 'pending', 'approved'] },
        },
      });
      // Also just check existence broadly
      if (!version) {
        const anyVersion = await db.Versions.findFirst({
          where: {
            Namespace: body.targetNamespace,
            ExtensionId: body.targetExtensionId,
          },
        });
        if (!anyVersion) {
          throw notFound('No such extension.');
        }
      }
    }

    // Prevent repeated open reports from the same reporter for the same target
    const existingOpen = await db.Reports.findFirst({
      where: {
        ReporterId: req.auth.user.Id,
        Status: 'open',
        TargetType: targetType,
        ...(targetType === 'extension'
          ? {
              TargetNamespace: body.targetNamespace,
              TargetExtensionId: body.targetExtensionId,
            }
          : { TargetUserId: targetUserId }),
      },
    });
    if (existingOpen) {
      throw conflict('You already have an open report for this target.');
    }

    const created = await db.Reports.create({
      data: {
        ReporterId: req.auth.user.Id,
        TargetType: targetType,
        TargetNamespace: body.targetNamespace ?? null,
        TargetExtensionId: targetType === 'extension' ? body.targetExtensionId ?? null : null,
        TargetUserId: targetType !== 'extension' ? targetUserId : null,
        Reason: reason,
        Description: description,
        Status: 'open',
      },
    });

    res.status(201).json(reportToObject(created));
  });

  return router;
}

export function makeAdminReportsRouter({ db, config }) {
  const router = Router();
  router.use(requireAdmin);

  router.get('/admin/reports', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    const where = {};
    if (status) {
      where.Status = status;
    }
    if (cursor) {
      where.Id = back ? { gt: cursor.i } : { lt: cursor.i };
    }

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

  router.get('/admin/reports/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const row = await db.Reports.findUnique({ where: { Id: id } });
    if (!row) throw notFound();
    res.json(reportToObject(row));
  });

  router.patch('/admin/reports/:id', async (req, res) => {
    requireObjectBody(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    const existing = await db.Reports.findUnique({ where: { Id: id } });
    if (!existing) throw notFound();

    const updates = {};
    if (typeof req.body.status === 'string') {
      const s = req.body.status;
      if (s !== 'open' && s !== 'resolved' && s !== 'dismissed') {
        throw fieldErrors([{ field: 'status', message: 'Invalid status.' }]);
      }
      updates.Status = s;
    } else if (req.body.resolution === 'resolved' || req.body.resolution === 'dismissed') {
      updates.Status = req.body.resolution;
    }

    if (req.body.resolutionNote !== undefined) {
      if (req.body.resolutionNote === null) {
        updates.ResolutionNote = null;
      } else if (typeof req.body.resolutionNote === 'string') {
        updates.ResolutionNote = req.body.resolutionNote.trim();
      } else {
        throw fieldErrors([{ field: 'resolutionNote', message: 'Must be a string or null.' }]);
      }
    } else if (req.body.resolution !== undefined && typeof req.body.resolution === 'string' && req.body.resolution !== 'open') {
      // allow passing resolution as note?
    }

    if (updates.Status && updates.Status !== 'open') {
      updates.ReviewedBy = req.auth.user.Id;
      updates.ReviewedAt = new Date();
    } else if (updates.Status === 'open') {
      updates.ReviewedBy = null;
      updates.ReviewedAt = null;
      updates.ResolutionNote = null;
    }

    updates.UpdatedAt = new Date();

    const row = await db.Reports.update({
      where: { Id: id },
      data: updates,
    });

    await audit(
      db,
      req.auth.user,
      'report.resolve',
      { namespace: existing.TargetNamespace, id: existing.TargetExtensionId },
      { reportId: String(id), status: row.Status },
    );

    res.json(reportToObject(row));
  });

  return router;
}
