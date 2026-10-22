import { Prisma } from '../prisma/generated/client/index.js';
import { conflict, notFound } from './errors.js';
import { audit } from './audit.js';
import { isOrganizationOwner, organizationsOwnedBy } from './auth.js';
import { acquireAdvisoryLocks } from './locks.js';
import {
  notifyOwnerCandidate,
  transferRequestedMessage,
  transferOutcomeMessage,
} from './notify.js';

// Every table keyed on the extension's address rather than on its id. Moving the
// extension means moving all of it in one transaction: a transfer that committed
// some of these would leave versions that resolve and tags that do not, which is
// worse than refusing.
//
// The WHERE on every statement below includes extension_id, which is what keeps
// a namespace-wide webhook (extension_id IS NULL) on the sender: it belongs to
// the namespace, not to anything published under it.
const MOVED_TABLES = [
  '"Versions"',
  '"DistTags"',
  '"ExtensionOwners"',
  '"ExtensionOwnerInvites"',
  '"Webhooks"',
  '"DownloadEvents"',
  '"ExtensionDailyDownloads"',
  '"ExtensionVersionDailyDownloads"',
];

// The subset whose key includes the address and would therefore collide if the
// destination already had rows under it. Clearing them first is not tidiness:
// deleting an extension deliberately leaves its owners, tags, webhooks, download
// history and daily counters behind (the owner rows have to
// survive, and the download tables are append-only history nobody prunes). So a
// namespace that published `widget` last year and deleted it can still be the
// destination of a transfer of `widget` today, and without this the move would
// fail on a primary key.
const ADDRESS_KEYED = MOVED_TABLES.filter((table) => table !== '"Versions"');

const DEFAULT_QUOTA = 64 * 1024 * 1024;

function quotaFor(config, account) {
  return account?.MaxBlobBytes ?? config?.limits?.maxAccountBlobBytes ?? DEFAULT_QUOTA;
}

// The bytes the extension charges its namespace account, which is what has to
// move with it.
function chargedBytes(versions) {
  return versions.reduce(
    (sum, row) => sum + Number(row.BlobSize ?? 0) + Number(row.SourceSize ?? 0),
    0,
  );
}

// Who may offer an extension away, and who may take one in. Both are narrower
// than the extension owner list, on purpose.
//
// Offering is the namespace account's own decision. A co-owner can publish to
// somebody else's extension, but moving it out from under its address is not
// theirs to do, and neither is removing the address holder. An organization
// owner speaks for the organization; an admin can act for either side.
export async function mayOfferTransfer(db, user, namespace) {
  if (user.Role === 'admin') return true;
  if (user.Namespace === namespace) return true;
  return isOrganizationOwner(db, user, namespace);
}

export async function mayReceiveTransfer(db, user, toNamespace) {
  if (user.Role === 'admin') return true;
  if (user.Namespace === toNamespace) return true;
  return isOrganizationOwner(db, user, toNamespace);
}

export async function loadNamespaceAccount(db, namespace) {
  const row = await db.Users.findUnique({
    where: { Namespace: namespace },
    select: {
      Id: true,
      Namespace: true,
      DisplayName: true,
      Kind: true,
      BlobBytes: true,
      MaxBlobBytes: true,
    },
  });
  return row ?? null;
}

// An organization with no owners on its list cannot be acted for by anybody, so
// it could accept a transfer and then never publish to it. The org routes refuse
// to create that state; this covers an extension arriving at one.
export async function hasOrgOwner(db, orgId) {
  const row = await db.OrganizationOwners.findFirst({
    where: { OrgId: orgId },
    select: { OrgId: true },
  });
  return Boolean(row);
}

// A transfer is a move of the address, so the destination has to be free. An
// address that is itself a redirect holds no versions and so passes the first
// check, but taking it over would leave that redirect pointing at the extension
// the transfer just delivered, which is a loop. Refusing is clearer than
// following it.
async function assertDestinationIsFree(tx, toNamespace, id) {
  const existing = await tx.Versions.findFirst({
    where: { Namespace: toNamespace, ExtensionId: id, Status: { not: 'rejected' } },
    select: { Id: true },
  });
  if (existing) {
    throw conflict(`@${toNamespace}/${id} already exists, so it cannot be transferred into.`);
  }
  const redirect = await tx.ExtensionRedirects.findFirst({
    where: { FromNamespace: toNamespace, FromExtensionId: id },
    select: { FromNamespace: true },
  });
  if (redirect) {
    throw conflict(
      `@${toNamespace}/${id} has itself been transferred away, so it cannot receive one.`,
    );
  }
}

// Opening the offer. Kept separate from the move so the recipient is the one who
// decides, and so the sender can name a namespace that has not asked for this
// yet. The quota is checked here as well as on accept: refusing now tells the
// sender to pick a different destination, where refusing at accept tells them
// after the recipient has already said yes.
export async function openTransfer(tx, { config, actor, namespace, id, toNamespace, recipient }) {
  const pending = await tx.ExtensionTransfers.findFirst({
    where: { Namespace: namespace, ExtensionId: id, ToNamespace: toNamespace },
    select: { Namespace: true },
  });
  if (pending) {
    throw conflict(`@${namespace}/${id} has already been offered to @${toNamespace}.`);
  }

  const versions = await tx.Versions.findMany({
    where: { Namespace: namespace, ExtensionId: id },
    select: { BlobSize: true, SourceSize: true, Status: true },
  });
  if (versions.length === 0) throw notFound(`@${namespace}/${id} does not exist.`);
  if (versions.some((row) => row.Status === 'staging')) {
    throw conflict('A publish is in progress for this extension.');
  }

  // A destination that is taken or is itself a redirect cannot ever be delivered
  // to, and saying so now saves the recipient from accepting something that is
  // bound to be refused.
  await assertDestinationIsFree(tx, toNamespace, id);

  const charged = chargedBytes(versions);
  const room = Number(recipient.BlobBytes ?? 0) + charged;
  const limit = quotaFor(config, recipient);
  if (room > limit) {
    throw conflict(
      `@${toNamespace} does not have room for ${charged} bytes; its limit is ${limit} and it holds ${recipient.BlobBytes ?? 0}.`,
    );
  }

  await tx.ExtensionTransfers.create({
    data: {
      Namespace: namespace,
      ExtensionId: id,
      ToNamespace: toNamespace,
      RequestedBy: actor.Id,
    },
  });

  // The recipient is the one who has to act, and an organization has no inbox of
  // its own, so every account on its owner list is told.
  await notifyOwnerCandidate(
    tx,
    recipient,
    'extension.transfer.requested',
    transferRequestedMessage(actor.Namespace, namespace, id, toNamespace),
    { namespace, id, to: toNamespace },
  );
  await audit(tx, actor, 'extension.transfer.request', { namespace, id }, { to: toNamespace });
}

export async function withdrawTransfer(tx, { actor, namespace, id, toNamespace, recipient }) {
  const { count } = await tx.ExtensionTransfers.deleteMany({
    where: { Namespace: namespace, ExtensionId: id, ToNamespace: toNamespace },
  });
  if (count === 0)
    throw notFound(`@${namespace}/${id} has no transfer waiting for @${toNamespace}.`);
  await notifyOwnerCandidate(
    tx,
    recipient,
    'extension.transfer.completed',
    transferOutcomeMessage(actor.Namespace, namespace, id, toNamespace, 'withdrawn'),
    { namespace, id, to: toNamespace },
  );
  await audit(tx, actor, 'extension.transfer.withdraw', { namespace, id }, { to: toNamespace });
}

// The move, and the only place the address changes.
//
// Both addresses take the same per-extension advisory lock publishVersion uses,
// acquired in a fixed order so two transfers that meet in the middle cannot
// deadlock each other. It is held to the end of the transaction, so a publish
// against either address either happens entirely before or entirely after.
export async function acceptTransfer(tx, { config, actor, namespace, id, toNamespace, recipient }) {
  await acquireAdvisoryLocks(tx, [`${namespace}/${id}`, `${toNamespace}/${id}`]);

  // Re-read everything the open checked. The offer may be months old: the
  // destination may have published its own `id` in the meantime, or filled up.
  const { count: offerCount } = await tx.ExtensionTransfers.deleteMany({
    where: { Namespace: namespace, ExtensionId: id, ToNamespace: toNamespace },
  });
  if (offerCount === 0)
    throw notFound(`@${namespace}/${id} has no transfer waiting for @${toNamespace}.`);

  const versions = await tx.Versions.findMany({
    where: { Namespace: namespace, ExtensionId: id },
    select: { BlobSize: true, SourceSize: true, Status: true },
  });
  if (versions.length === 0) throw notFound(`@${namespace}/${id} no longer exists.`);
  if (versions.some((row) => row.Status === 'staging')) {
    throw conflict('A publish is in progress for this extension.');
  }
  await assertDestinationIsFree(tx, toNamespace, id);

  // The charge follows the extension and the quota stays a hard limit, so a
  // transfer is not a way around one. The receiving row is locked before the
  // charge is read, so a concurrent accept cannot both pass the check.
  const [account] = await tx.$queryRaw`
    SELECT "Id", "BlobBytes", "MaxBlobBytes" FROM "Users" WHERE "Id" = ${recipient.Id} FOR UPDATE
  `;
  if (!account) throw notFound('No such receiving account.');
  const charged = chargedBytes(versions);
  const limit = quotaFor(config, account);
  if (Number(account.BlobBytes ?? 0) + charged > limit) {
    throw conflict(
      `@${toNamespace} does not have room for ${charged} bytes; its limit is ${limit} and it holds ${account.BlobBytes ?? 0}.`,
    );
  }

  // The table names come from the constant lists above, never from a request.
  for (const table of ADDRESS_KEYED) {
    await tx.$executeRaw`
      DELETE FROM ${Prisma.raw(table)}
      WHERE "Namespace" = ${toNamespace} AND "ExtensionId" = ${id}
    `;
  }
  await tx.$executeRaw`
    DELETE FROM "ExtensionOwners"
    WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${id}
      AND "OwnerId" = (SELECT "Id" FROM "Users" WHERE "Namespace" = ${namespace})
  `;
  for (const table of MOVED_TABLES) {
    await tx.$executeRaw`
      UPDATE ${Prisma.raw(table)} SET "Namespace" = ${toNamespace}
      WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${id}
    `;
  }
  await tx.$executeRaw`
    UPDATE "Versions" SET "Author" = ${recipient.DisplayName}
    WHERE "Namespace" = ${toNamespace} AND "ExtensionId" = ${id}
  `;

  // Move only reports linked to this identity, leaving reports about deleted
  // extensions at their original address. An open report that would collide
  // at the destination keeps its address and identity link. If earlier moves
  // left multiple open reports from one reporter linked here, move the oldest.
  // The correlated conflict check cannot be expressed by the typed client.
  await tx.$executeRaw`
    UPDATE "Reports" r SET "TargetNamespace" = ${toNamespace}, "UpdatedAt" = now()
    WHERE r."TargetExtensionRefId" = (
      SELECT "Id" FROM "Extensions"
      WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${id}
    )
      AND (r."Status" <> 'open' OR NOT EXISTS (
        SELECT 1 FROM "Reports" existing
        WHERE existing."ReporterId" = r."ReporterId"
          AND existing."TargetType" = r."TargetType"
          AND existing."TargetExtensionId" = r."TargetExtensionId"
          AND existing."Status" = 'open'
          AND (
            existing."TargetNamespace" = ${toNamespace}
            OR (existing."TargetExtensionRefId" = r."TargetExtensionRefId" AND existing."Id" < r."Id")
          )
      ))
  `;

  // The extension's identity row moves with it: the address it is published
  // under is now the destination's. The row keeps its id, so the reports filed
  // about the extension keep their link to it, and only the address they name
  // changes. A stale row at the destination is cleared first, the same way the
  // address-keyed tables above are.
  await tx.Extensions.deleteMany({ where: { Namespace: toNamespace, ExtensionId: id } });
  await tx.Extensions.updateMany({
    where: { Namespace: namespace, ExtensionId: id },
    data: { Namespace: toNamespace, NamespaceId: account.Id },
  });

  await tx.ExtensionOwners.createMany({
    data: [
      {
        OwnerId: account.Id,
        Namespace: toNamespace,
        ExtensionId: id,
        AddedBy: actor.Id,
      },
    ],
    skipDuplicates: true,
  });

  // versions.owner_id is the account that ran the publish, not the namespace, so
  // it is deliberately left alone: who pushed 1.0.0 stays on the version, which
  // is what keeps the audit trail readable after the move.
  if (charged > 0) {
    await tx.$executeRaw`
      UPDATE "Users" SET "BlobBytes" = GREATEST("BlobBytes" - ${charged}, 0)
      WHERE "Namespace" = ${namespace}
    `;
    await tx.$executeRaw`UPDATE "Users" SET "BlobBytes" = "BlobBytes" + ${charged} WHERE "Namespace" = ${toNamespace}`;
  }

  // The destination deliberately does not become `has_published`. That flag is
  // what lets a namespace publish without an admin reading the version first, so
  // setting it here would mean any two accounts could sell each other the
  // review gate: receive an extension, then publish whatever, unreviewed. The
  // versions that move were reviewed for the address they were published under
  // and they carry that with them; they do not vouch for what the destination
  // publishes next, so its first own version is still held for review.

  // Point the old address at the new one and collapse whatever already pointed
  // at the old address onto the new one, so a chain never forms and a lookup
  // never has to follow one. The destination is known not to be a redirect, so
  // this cannot introduce a cycle. Kept raw: the conflicting update reads
  // EXCLUDED in the same statement, which the typed upsert cannot express.
  await tx.$executeRaw`
    INSERT INTO "ExtensionRedirects" ("FromNamespace", "FromExtensionId", "ToNamespace", "ToExtensionId")
    VALUES (${namespace}, ${id}, ${toNamespace}, ${id})
    ON CONFLICT ("FromNamespace", "FromExtensionId")
    DO UPDATE SET "ToNamespace" = EXCLUDED."ToNamespace",
                  "ToExtensionId" = EXCLUDED."ToExtensionId"
  `;
  await tx.$executeRaw`
    UPDATE "ExtensionRedirects" SET "ToNamespace" = ${toNamespace}, "ToExtensionId" = ${id}
    WHERE "ToNamespace" = ${namespace} AND "ToExtensionId" = ${id}
  `;

  // Offers made against the old address now name an address that holds nothing,
  // and an offer of this extension to somebody else was made about the address
  // as it was before. Both are dropped rather than rewritten: neither can be
  // accepted, and rewriting the second would have somebody else's offer reappear
  // against the new address as though they had asked for it.
  await tx.ExtensionTransfers.deleteMany({ where: { Namespace: namespace, ExtensionId: id } });
  await tx.ExtensionTransfers.deleteMany({
    where: { ToNamespace: namespace, ExtensionId: id },
  });

  // The sender is the one being told something they did not do. The recipient
  // accepted the offer a moment ago and already knows, so telling it as well
  // would be noise in the one inbox that has just acted.
  const sender = await loadNamespaceAccount(tx, namespace);
  await notifyOwnerCandidate(
    tx,
    sender,
    'extension.transfer.completed',
    transferOutcomeMessage(actor.Namespace, namespace, id, toNamespace, 'accepted'),
    { namespace, id, to: toNamespace },
  );
  await audit(
    tx,
    actor,
    'extension.transfer',
    { namespace: toNamespace, id },
    { from: namespace, to: toNamespace, versions: versions.length, bytesMoved: charged },
  );

  return { versions: versions.length, bytesMoved: charged };
}

// What has been offered at this address, to a namespace the caller can answer
// for. An organization holds no inbox, so an account acting for one sees what is
// waiting on the organization as well as on itself.
export async function pendingTransfersFor(db, user, namespace, id) {
  const organizations = await organizationsOwnedBy(db, user);
  const rows = await db.$queryRaw`
    SELECT t."ToNamespace", u."DisplayName", u."Kind", t."CreatedAt",
           a."Namespace" AS "RequestedByNamespace"
    FROM "ExtensionTransfers" t
    JOIN "Users" u ON u."Namespace" = t."ToNamespace"
    LEFT JOIN "Users" a ON a."Id" = t."RequestedBy"
    WHERE t."Namespace" = ${namespace} AND t."ExtensionId" = ${id}
      AND (
        t."ToNamespace" = ${user.Namespace}
        OR t."ToNamespace" = ANY (${organizations}::text[])
      )
    ORDER BY t."CreatedAt"
  `;
  return rows.map((row) => ({
    to: row.ToNamespace,
    display_name: row.DisplayName,
    kind: row.Kind,
    created_at: row.CreatedAt.toISOString(),
    requested_by: row.RequestedByNamespace,
  }));
}

// Where an address used to point, or null. One lookup with no loop, because the
// table is kept collapsed.
export async function redirectFor(db, namespace, id) {
  const row = await db.ExtensionRedirects.findUnique({
    where: {
      FromNamespace_FromExtensionId: { FromNamespace: namespace, FromExtensionId: id },
    },
  });
  if (!row) return null;
  return { namespace: row.ToNamespace, id: row.ToExtensionId };
}
