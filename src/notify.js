// Pre-rendered notification messages and insert helpers. Every insert takes
// the caller's transaction so a notification can never outlive the event that
// produced it.
export async function notifyUser(tx, userId, kind, message, payload = {}) {
  await tx`
    INSERT INTO notifications (user_id, kind, message, payload)
    VALUES (${userId}, ${kind}, ${message}, ${tx.json(payload)}::jsonb)
  `;
}

// Fan out to every user matching a WHERE fragment (used for terms bumps and
// broadcasts). Returns the number of rows inserted.
export async function notifyUsersMatching(tx, where, kind, message, payload = {}) {
  const rows = await tx`
    INSERT INTO notifications (user_id, kind, message, payload)
    SELECT id, ${kind}, ${message}, ${tx.json(payload)}::jsonb FROM users ${where}
    RETURNING 1
  `;
  return rows.length;
}

// An organization holds no inbox of its own, so anything addressed to one goes
// to the accounts on its owner list -- each of which can act for it, and each of
// which is the one that would have to accept an invitation.
export async function notifyOwnerCandidate(tx, candidate, kind, message, payload = {}) {
  if (candidate.kind !== 'organization') {
    await notifyUser(tx, candidate.id, kind, message, payload);
    return 1;
  }
  return notifyUsersMatching(
    tx,
    tx`WHERE id IN (SELECT user_id FROM organization_owners WHERE org_id = ${candidate.id})`,
    kind,
    message,
    payload,
  );
}

export function reviewApprovedMessage(namespace, id, version) {
  return `${id}@${version} was approved and is live. View it at @${namespace}/${id}.`;
}

export function reviewRejectedMessage(id, version, reason) {
  return `${id}@${version} was rejected: ${reason.trim()}`;
}

export function termsBumpedMessage(version) {
  return `The Terms of Service were updated to version ${version}. Accept the new version before publishing again.`;
}

export function tokensRevokedMessage(actorNamespace) {
  return `Your password was reset by an admin (@${actorNamespace}); all sessions and automation tokens were revoked.`;
}

export function roleChangedMessage(role) {
  return `Your account role changed to "${role}".`;
}

export function addedAsOwnerMessage(actorNamespace, namespace, id) {
  return `You can now manage @${namespace}/${id} (added by @${actorNamespace}).`;
}

export function removedAsOwnerMessage(actorNamespace, namespace, id) {
  return `You were removed as an owner of @${namespace}/${id} by @${actorNamespace}.`;
}

// An invitation is not a grant, so it says what is still owed rather than what
// was given.
export function invitedAsOwnerMessage(actorNamespace, namespace, id) {
  return `You can now accept management of @${namespace}/${id}, invited by @${actorNamespace}.`;
}

export function withdrawnAsOwnerMessage(actorNamespace, namespace, id) {
  return `The invitation to manage @${namespace}/${id} was withdrawn by @${actorNamespace}.`;
}

// A transfer moves the address itself, so the message names both ends: what is
// being offered, and where it would land.
export function transferRequestedMessage(actorNamespace, namespace, id, toNamespace) {
  return `@${namespace}/${id} was offered to @${toNamespace} by @${actorNamespace}. Accept it to take the extension over.`;
}

export function transferOutcomeMessage(actorNamespace, namespace, id, toNamespace, outcome) {
  if (outcome === 'accepted') {
    return `@${namespace}/${id} now belongs to @${toNamespace}, accepted by @${actorNamespace}. The old address redirects.`;
  }
  return `The transfer of @${namespace}/${id} to @${toNamespace} was withdrawn by @${actorNamespace}.`;
}

// An organization names people rather than extensions, so these are the same
// two messages with the extension id left off.
export function addedAsOrgOwnerMessage(actorNamespace, namespace) {
  return `You can now manage @${namespace} (added by @${actorNamespace}).`;
}

export function removedAsOrgOwnerMessage(actorNamespace, namespace) {
  return `You were removed as an owner of @${namespace} by @${actorNamespace}.`;
}
