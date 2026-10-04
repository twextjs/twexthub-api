import { conflict, notFound } from './errors.js';
import { audit } from './audit.js';
import { isOrganizationOwner, organizationsOwnedBy } from './auth.js';
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
  'versions',
  'dist_tags',
  'extension_owners',
  'extension_owner_invites',
  'extension_access',
  'webhooks',
  'download_events',
  'extension_daily_downloads',
];

// The subset whose key includes the address and would therefore collide if the
// destination already had rows under it. Clearing them first is not tidiness:
// deleting an extension deliberately leaves its owners, tags, access grants,
// webhooks, download history and daily counters behind (the owner rows have to
// survive, and the download tables are append-only history nobody prunes). So a
// namespace that published `widget` last year and deleted it can still be the
// destination of a transfer of `widget` today, and without this the move would
// fail on a primary key.
const ADDRESS_KEYED = MOVED_TABLES.filter((table) => table !== 'versions');

const DEFAULT_QUOTA = 64 * 1024 * 1024;

function quotaFor(config, account) {
  return account?.max_blob_bytes ?? config?.limits?.maxAccountBlobBytes ?? DEFAULT_QUOTA;
}

// The bytes the extension charges its namespace account, which is what has to
// move with it.
function chargedBytes(versions) {
  return versions.reduce(
    (sum, row) => sum + Number(row.blob_size ?? 0) + Number(row.source_size ?? 0),
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
export async function mayOfferTransfer(sql, user, namespace) {
  if (user.role === 'admin') return true;
  if (user.namespace === namespace) return true;
  return isOrganizationOwner(sql, user, namespace);
}

export async function mayReceiveTransfer(sql, user, toNamespace) {
  if (user.role === 'admin') return true;
  if (user.namespace === toNamespace) return true;
  return isOrganizationOwner(sql, user, toNamespace);
}

export async function loadNamespaceAccount(sql, namespace) {
  const [row] = await sql`
    SELECT id, namespace, display_name, kind, blob_bytes, max_blob_bytes
    FROM users WHERE namespace = ${namespace}
  `;
  return row ?? null;
}

// An organization with no owners on its list cannot be acted for by anybody, so
// it could accept a transfer and then never publish to it. The org routes refuse
// to create that state; this covers an extension arriving at one.
export async function hasOrgOwner(sql, orgId) {
  const [row] = await sql`SELECT 1 FROM organization_owners WHERE org_id = ${orgId} LIMIT 1`;
  return Boolean(row);
}

// A transfer is a move of the address, so the destination has to be free. An
// address that is itself a redirect holds no versions and so passes the first
// check, but taking it over would leave that redirect pointing at the extension
// the transfer just delivered, which is a loop. Refusing is clearer than
// following it.
async function assertDestinationIsFree(tx, toNamespace, id) {
  const [existing] = await tx`
    SELECT 1 FROM versions
    WHERE namespace = ${toNamespace} AND extension_id = ${id} AND status <> 'rejected'
  `;
  if (existing) {
    throw conflict(`@${toNamespace}/${id} already exists, so it cannot be transferred into.`);
  }
  const [redirect] = await tx`
    SELECT 1 FROM extension_redirects
    WHERE from_namespace = ${toNamespace} AND from_extension_id = ${id}
  `;
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
  const [pending] = await tx`
    SELECT 1 FROM extension_transfers
    WHERE namespace = ${namespace} AND extension_id = ${id} AND to_namespace = ${toNamespace}
  `;
  if (pending) {
    throw conflict(`@${namespace}/${id} has already been offered to @${toNamespace}.`);
  }

  const versions = await tx`
    SELECT blob_size, source_size, status FROM versions
    WHERE namespace = ${namespace} AND extension_id = ${id}
  `;
  if (versions.length === 0) throw notFound(`@${namespace}/${id} does not exist.`);
  if (versions.some((row) => row.status === 'staging')) {
    throw conflict('A publish is in progress for this extension.');
  }

  // A destination that is taken or is itself a redirect cannot ever be delivered
  // to, and saying so now saves the recipient from accepting something that is
  // bound to be refused.
  await assertDestinationIsFree(tx, toNamespace, id);

  const charged = chargedBytes(versions);
  const room = Number(recipient.blob_bytes ?? 0) + charged;
  const limit = quotaFor(config, recipient);
  if (room > limit) {
    throw conflict(
      `@${toNamespace} does not have room for ${charged} bytes; its limit is ${limit} and it holds ${recipient.blob_bytes ?? 0}.`,
    );
  }

  await tx`
    INSERT INTO extension_transfers (namespace, extension_id, to_namespace, requested_by)
    VALUES (${namespace}, ${id}, ${toNamespace}, ${actor.id})
  `;

  // The recipient is the one who has to act, and an organization has no inbox of
  // its own, so every account on its owner list is told.
  await notifyOwnerCandidate(
    tx,
    recipient,
    'extension.transfer.requested',
    transferRequestedMessage(actor.namespace, namespace, id, toNamespace),
    { namespace, id, to: toNamespace },
  );
  await audit(tx, actor, 'extension.transfer.request', { namespace, id }, { to: toNamespace });
}

export async function withdrawTransfer(tx, { actor, namespace, id, toNamespace, recipient }) {
  const [removed] = await tx`
    DELETE FROM extension_transfers
    WHERE namespace = ${namespace} AND extension_id = ${id} AND to_namespace = ${toNamespace}
    RETURNING 1
  `;
  if (!removed) throw notFound(`@${namespace}/${id} has no transfer waiting for @${toNamespace}.`);
  await notifyOwnerCandidate(
    tx,
    recipient,
    'extension.transfer.completed',
    transferOutcomeMessage(actor.namespace, namespace, id, toNamespace, 'withdrawn'),
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
  const keys = [`${namespace}/${id}`, `${toNamespace}/${id}`].sort();
  for (const key of keys) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Re-read everything the open checked. The offer may be months old: the
  // destination may have published its own `id` in the meantime, or filled up.
  const [offer] = await tx`
    DELETE FROM extension_transfers
    WHERE namespace = ${namespace} AND extension_id = ${id} AND to_namespace = ${toNamespace}
    RETURNING 1
  `;
  if (!offer) throw notFound(`@${namespace}/${id} has no transfer waiting for @${toNamespace}.`);

  const versions = await tx`
    SELECT blob_size, source_size, status FROM versions
    WHERE namespace = ${namespace} AND extension_id = ${id}
  `;
  if (versions.length === 0) throw notFound(`@${namespace}/${id} no longer exists.`);
  if (versions.some((row) => row.status === 'staging')) {
    throw conflict('A publish is in progress for this extension.');
  }
  await assertDestinationIsFree(tx, toNamespace, id);

  // The charge follows the extension and the quota stays a hard limit, so a
  // transfer is not a way around one.
  const [account] = await tx`
    SELECT id, blob_bytes, max_blob_bytes FROM users WHERE id = ${recipient.id} FOR UPDATE
  `;
  if (!account) throw notFound('No such receiving account.');
  const charged = chargedBytes(versions);
  const limit = quotaFor(config, account);
  if (Number(account.blob_bytes ?? 0) + charged > limit) {
    throw conflict(
      `@${toNamespace} does not have room for ${charged} bytes; its limit is ${limit} and it holds ${account.blob_bytes ?? 0}.`,
    );
  }

  for (const table of ADDRESS_KEYED) {
    await tx`
      DELETE FROM ${tx(table)}
      WHERE namespace = ${toNamespace} AND extension_id = ${id}
    `;
  }
  await tx`
    DELETE FROM extension_owners
    WHERE namespace = ${namespace} AND extension_id = ${id}
      AND owner_id = (SELECT id FROM users WHERE namespace = ${namespace})
  `;
  for (const table of MOVED_TABLES) {
    await tx`
      UPDATE ${tx(table)} SET namespace = ${toNamespace}
      WHERE namespace = ${namespace} AND extension_id = ${id}
    `;
  }
  await tx`
    UPDATE versions SET author = ${recipient.display_name}
    WHERE namespace = ${toNamespace} AND extension_id = ${id}
  `;

  await tx`
    INSERT INTO extension_owners (owner_id, namespace, extension_id, added_by)
    VALUES (${account.id}, ${toNamespace}, ${id}, ${actor.id})
    ON CONFLICT (namespace, extension_id, owner_id) DO NOTHING
  `;

  // versions.owner_id is the account that ran the publish, not the namespace, so
  // it is deliberately left alone: who pushed 1.0.0 stays on the version, which
  // is what keeps the audit trail readable after the move.
  if (charged > 0) {
    await tx`
      UPDATE users SET blob_bytes = GREATEST(blob_bytes - ${charged}, 0)
      WHERE namespace = ${namespace}
    `;
    await tx`UPDATE users SET blob_bytes = blob_bytes + ${charged} WHERE namespace = ${toNamespace}`;
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
  // this cannot introduce a cycle.
  await tx`
    INSERT INTO extension_redirects (from_namespace, from_extension_id, to_namespace, to_extension_id)
    VALUES (${namespace}, ${id}, ${toNamespace}, ${id})
    ON CONFLICT (from_namespace, from_extension_id)
    DO UPDATE SET to_namespace = EXCLUDED.to_namespace,
                  to_extension_id = EXCLUDED.to_extension_id
  `;
  await tx`
    UPDATE extension_redirects SET to_namespace = ${toNamespace}, to_extension_id = ${id}
    WHERE to_namespace = ${namespace} AND to_extension_id = ${id}
  `;

  // Offers made against the old address now name an address that holds nothing,
  // and an offer of this extension to somebody else was made about the address
  // as it was before. Both are dropped rather than rewritten: neither can be
  // accepted, and rewriting the second would have somebody else's offer reappear
  // against the new address as though they had asked for it.
  await tx`DELETE FROM extension_transfers WHERE namespace = ${namespace} AND extension_id = ${id}`;
  await tx`DELETE FROM extension_transfers WHERE to_namespace = ${namespace} AND extension_id = ${id}`;

  // The sender is the one being told something they did not do. The recipient
  // accepted the offer a moment ago and already knows, so telling it as well
  // would be noise in the one inbox that has just acted.
  const sender = await loadNamespaceAccount(tx, namespace);
  await notifyOwnerCandidate(
    tx,
    sender,
    'extension.transfer.completed',
    transferOutcomeMessage(actor.namespace, namespace, id, toNamespace, 'accepted'),
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
export async function pendingTransfersFor(sql, user, namespace, id) {
  const organizations = await organizationsOwnedBy(sql, user);
  const rows = await sql`
    SELECT t.to_namespace, u.display_name, u.kind, t.created_at, a.namespace AS requested_by_namespace
    FROM extension_transfers t
    JOIN users u ON u.namespace = t.to_namespace
    LEFT JOIN users a ON a.id = t.requested_by
    WHERE t.namespace = ${namespace} AND t.extension_id = ${id}
      AND (
        t.to_namespace = ${user.namespace}
        OR t.to_namespace = ANY (${sql.array(organizations)}::text[])
      )
    ORDER BY t.created_at
  `;
  return rows.map((row) => ({
    to: row.to_namespace,
    display_name: row.display_name,
    kind: row.kind,
    created_at: row.created_at.toISOString(),
    requested_by: row.requested_by_namespace,
  }));
}

// Where an address used to point, or null. One lookup with no loop, because the
// table is kept collapsed.
export async function redirectFor(sql, namespace, id) {
  const [row] = await sql`
    SELECT to_namespace, to_extension_id FROM extension_redirects
    WHERE from_namespace = ${namespace} AND from_extension_id = ${id}
  `;
  if (!row) return null;
  return { namespace: row.to_namespace, id: row.to_extension_id };
}
