// Append-only audit trail. Writers pass their transaction when the audited
// action is transactional so the entry commits or rolls back with it; the
// fire-and-forget form is for actions that already committed (yank, delete).
// `tx` is either the root client or an interactive-transaction client, both of
// which expose the same `auditLog` delegate.
export async function audit(tx, actor, action, target = {}, detail = {}) {
  await tx.audit_log.create({
    data: {
      actor_id: actor?.id ?? null,
      actor_namespace: actor?.namespace ?? 'system',
      action,
      target_namespace: target.namespace ?? null,
      target_extension_id: target.id ?? null,
      target_version: target.version ?? null,
      detail,
    },
  });
}

// For post-commit actions where a failed audit insert should not fail the
// request. Errors are logged, not surfaced.
export function auditSoon(db, actor, action, target = {}, detail = {}) {
  audit(db, actor, action, target, detail).catch((error) => {
    console.error(`audit write failed for ${action}:`, error.message);
  });
}

export function auditRowToObject(row) {
  return {
    id: String(row.id),
    actor: row.actor_namespace,
    action: row.action,
    target: {
      namespace: row.target_namespace,
      id: row.target_extension_id,
      version: row.target_version,
    },
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  };
}
