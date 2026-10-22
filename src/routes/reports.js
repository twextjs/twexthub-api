import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { uniqueViolation } from '../db.js';
import { conflict, fieldErrors, notFound } from '../errors.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { reportToOwnerObject } from '../serialize.js';
import { isValidExtensionId, isValidNamespace } from '../util.js';
import {
  MAX_REPORT_DESCRIPTION,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  resolveReportTarget,
} from '../reports.js';
import { requireObjectBody } from './shared.js';

// The router is mounted at /reports, so the paths below are relative to it.
//
// Two audiences read this queue. The account that filed a report may look at
// its own reports to see whether they were decided, and it sees only that:
// the description, the reviewer's identity and the reviewer's note are the
// reviewer's business. The reviewer sees the whole record, through the admin
// endpoints, which are the only ones that hand it out.
export function makeReportsRouter({ db, config, rateLimiter, termsGate }) {
  const router = Router();

  router.post('/', requireAuth, termsGate, async (req, res) => {
    requireObjectBody(req);
    const body = req.body;

    const targetType = body.targetType;
    if (typeof targetType !== 'string' || !REPORT_TARGET_TYPES.includes(targetType)) {
      throw fieldErrors([
        { field: 'targetType', message: `Must be one of: ${REPORT_TARGET_TYPES.join(', ')}.` },
      ]);
    }

    const namespace = body.targetNamespace;
    if (typeof namespace !== 'string' || !isValidNamespace(namespace)) {
      throw fieldErrors([{ field: 'targetNamespace', message: 'Must be a valid namespace.' }]);
    }

    let extensionId = '';
    if (targetType === 'extension') {
      if (
        typeof body.targetExtensionId !== 'string' ||
        !isValidExtensionId(body.targetExtensionId)
      ) {
        throw fieldErrors([
          { field: 'targetExtensionId', message: 'Must be a valid extension id.' },
        ]);
      }
      extensionId = body.targetExtensionId;
    } else if (body.targetExtensionId !== undefined) {
      throw fieldErrors([
        { field: 'targetExtensionId', message: 'Only a report about an extension names one.' },
      ]);
    }

    const reason = body.reason;
    if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason)) {
      throw fieldErrors([
        { field: 'reason', message: `Must be one of: ${REPORT_REASONS.join(', ')}.` },
      ]);
    }

    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length === 0 || description.length > MAX_REPORT_DESCRIPTION) {
      throw fieldErrors([
        {
          field: 'description',
          message: `Must be between 1 and ${MAX_REPORT_DESCRIPTION} characters.`,
        },
      ]);
    }

    // One window per reporter. The complaint is about somebody else's account,
    // so the rate that matters is the one at which a single account can fill
    // the moderators' queue, not the one at which the queue is read.
    await rateLimiter.reportCheck(`report:${req.auth.user.Namespace}`)();

    // The report has to be about something that is there: a report about an
    // account that never existed, or an extension that was never published,
    // is nothing a reviewer could act on. The address the report is filed
    // against is the one the target lives at now, which is what keeps a
    // report aimed at a transferred extension pointing at the extension, and
    // the target is linked to the row it is held by so the report says which
    // one it is about.
    const target = await resolveReportTarget(db, { targetType, namespace, extensionId });

    let created;
    try {
      created = await db.Reports.create({
        data: {
          ReporterId: req.auth.user.Id,
          ReporterNamespace: req.auth.user.Namespace,
          TargetType: targetType,
          TargetNamespace: target.namespace,
          TargetExtensionId: target.extensionId ?? '',
          TargetAccountId: target.accountId ?? null,
          TargetExtensionRefId: target.extensionRefId ?? null,
          Reason: reason,
          Description: description,
          Status: 'open',
        },
      });
    } catch (error) {
      // The only unique constraint a report carries is the one that keeps a
      // second open report about the same target out of the queue. The rule is
      // in the index rather than in a lookup before the insert, so two reports
      // filed at the same moment cannot both get in.
      if (uniqueViolation(error)) {
        throw conflict('You already have an open report about this target.');
      }
      throw error;
    }

    res.status(201).json(reportToOwnerObject(created));
  });

  router.get('/', requireAuth, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const rows = await db.Reports.findMany({
      where: {
        ReporterId: req.auth.user.Id,
        ...(cursor ? (back ? { Id: { gt: cursor.i } } : { Id: { lt: cursor.i } }) : {}),
      },
      orderBy: { Id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });
    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: reportToOwnerObject,
        keyOf: (row) => ({ i: Number(row.Id) }),
      }),
    );
  });

  router.get('/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
    // A report that belongs to somebody else is a 404 rather than a 403, so
    // the call does not reveal that it exists.
    const row = await db.Reports.findFirst({
      where: { Id: id, ReporterId: req.auth.user.Id },
    });
    if (!row) throw notFound();
    res.json(reportToOwnerObject(row));
  });

  return router;
}
