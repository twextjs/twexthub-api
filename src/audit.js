// Append-only audit trail. Writers pass their transaction when the audited
// action is transactional so the entry commits or rolls back with it; the
// fire-and-forget form is for actions that already committed (yank, delete).
export async function audit(tx, actor, action, target = {}, detail = {}) {
  await tx`
    INSERT INTO audit_log (actor_id, actor_namespace, action, target_namespace, target_extension_id, target_version, detail)
    VALUES (
      ${actor?.id ?? null},
      ${actor?.namespace ?? 'system'},
      ${action},
      ${target.namespace ?? null},
      ${target.id ?? null},
      ${target.version ?? null},
      ${tx.json(detail)}::jsonb
    )
  `;
}

// For post-commit actions where a failed audit insert should not fail the
// request. Errors are logged, not surfaced.
export function auditSoon(sql, actor, action, target = {}, detail = {}) {
  audit(sql, actor, action, target, detail).catch((error) => {
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
