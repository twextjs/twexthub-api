// Append-only audit trail. Writers pass their transaction when the audited
// action is transactional so the entry commits or rolls back with it; the
// fire-and-forget form is for actions that already committed (yank, delete).
// `tx` is either the root client or an interactive-transaction client, both of
// which expose the same `AuditLog` delegate.
export async function audit(tx, actor, action, target = {}, detail = {}) {
  await tx.AuditLog.create({
    data: {
      ActorId: actor?.Id ?? null,
      ActorNamespace: actor?.Namespace ?? 'system',
      Action: action,
      TargetNamespace: target.namespace ?? null,
      TargetExtensionId: target.id ?? null,
      TargetVersion: target.version ?? null,
      Detail: detail,
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
    id: String(row.Id),
    actor: row.ActorNamespace,
    action: row.Action,
    target: {
      namespace: row.TargetNamespace,
      id: row.TargetExtensionId,
      version: row.TargetVersion,
    },
    detail: row.Detail,
    createdAt: row.CreatedAt.toISOString(),
  };
}
