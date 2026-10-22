// The reports queue: what a report may say, what it may be about, and how the
// target behind it is resolved to something that exists right now.
//
// Nothing in this file acts on a target. A report is a queue entry for a
// moderator to read, and what happens to what was reported is a decision
// somebody makes by hand: no count of reports suspends, hides, or removes
// anything.
import { notFound } from './errors.js';
import { redirectFor } from './transfer.js';

// The categories a report may be filed under. A fixed list rather than free
// text, because sorting the queue is the first thing a reviewer does with it,
// and a list is something a queue can be sorted by.
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'malicious_code',
  'copyright',
  'impersonation',
  'other',
];

// What a report may be about.
export const REPORT_TARGET_TYPES = ['user', 'organization', 'extension'];

// The states a report is in. `open` is the queue waiting for a reviewer; the
// other two are the outcomes a reviewer records.
export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'];

// The outcomes a reviewer may record. There is no way back to `open`: a
// decided report stays decided, and a later complaint about the same target is
// a new report rather than a reopened one.
export const REPORT_DECISIONS = ['resolved', 'dismissed'];

// How much a report may say. The description is the one part of the record a
// stranger must never read, so it is bounded rather than merely stored.
export const MAX_REPORT_DESCRIPTION = 2000;

// How much a reviewer may write about a decision. The note is the reason the
// decision was made, so it is kept with the report and with the audit entry.
export const MAX_REPORT_RESOLUTION_NOTE = 2000;

// The account kind each account-shaped target type has to name. A report filed
// as "user" against a namespace that is an organization is a mistake in the
// report rather than a different kind of target, so it is refused instead of
// quietly recorded as something else.
const ACCOUNT_KINDS = { user: 'user', organization: 'organization' };

// Only versions that have been public make an extension reportable.
const EXISTING_VERSION_STATUSES = ['published', 'deprecated', 'yanked'];

// The target a report is about, resolved to the address it lives at now and to
// the row it is held by.
//
// An extension that has been transferred is reported against the address it
// has now rather than the one it had when the report was filed: the report is
// about the extension, and the address is only where the extension can be
// found. The same rule keeps a report useful after a transfer -- the report
// moves with the extension.
//
// The address is kept in the report as well as the link, because the address
// is what a reviewer reads and what the report still says once the target is
// gone.
export async function resolveReportTarget(db, { targetType, namespace, extensionId }) {
  if (targetType === 'extension') {
    const address = await resolveExtensionAddress(db, namespace, extensionId);
    if (!address) throw notFound('No such extension.');
    return {
      namespace: address.namespace,
      extensionId: address.extensionId,
      extensionRefId: await extensionIdentityId(db, address.namespace, address.extensionId),
    };
  }
  const account = await db.Users.findUnique({ where: { Namespace: namespace } });
  if (!account || account.Kind !== ACCOUNT_KINDS[targetType]) {
    throw notFound('No such account.');
  }
  return { namespace: account.Namespace, accountId: account.Id };
}

// The id of the row that gives an extension its identity.
//
// The row is written by the publish path and by the migration that introduced
// the table, so it is normally already there. Creating it here as well keeps a
// report from being refused over a row that only the registry is missing: the
// extension is there, so the report about it has somewhere to point.
async function extensionIdentityId(db, namespace, extensionId) {
  const found = await db.Extensions.findUnique({
    where: { Namespace_ExtensionId: { Namespace: namespace, ExtensionId: extensionId } },
    select: { Id: true },
  });
  if (found) return found.Id;
  const account = await db.Users.findUnique({
    where: { Namespace: namespace },
    select: { Id: true },
  });
  await db.Extensions.createMany({
    data: [{ Namespace: namespace, ExtensionId: extensionId, NamespaceId: account?.Id ?? null }],
    skipDuplicates: true,
  });
  const created = await db.Extensions.findUnique({
    where: { Namespace_ExtensionId: { Namespace: namespace, ExtensionId: extensionId } },
    select: { Id: true },
  });
  return created?.Id ?? null;
}

async function resolveExtensionAddress(db, namespace, extensionId) {
  if (await extensionExists(db, namespace, extensionId)) {
    return { namespace, extensionId };
  }
  // The address may have been transferred: the extension lives under the
  // namespace it was moved to and the old address redirects there. Following
  // the redirect is what makes a report filed against an address a user still
  // sees land on the extension itself.
  const moved = await redirectFor(db, namespace, extensionId);
  if (!moved) return null;
  if (!(await extensionExists(db, moved.namespace, moved.id))) return null;
  return { namespace: moved.namespace, extensionId: moved.id };
}

async function extensionExists(db, namespace, extensionId) {
  const row = await db.Versions.findFirst({
    where: {
      Namespace: namespace,
      ExtensionId: extensionId,
      Status: { in: EXISTING_VERSION_STATUSES },
    },
    select: { Id: true },
  });
  return row !== null;
}
