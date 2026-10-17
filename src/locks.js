import { Prisma } from '../prisma/generated/client/index.js';

// Interactive transactions here hold advisory locks while they wait on a peer
// and, in the publish path, while a slow build or file hash runs. The Prisma
// defaults (5s) are too short for either, so both windows are widened.
export const TRANSACTION_TIMEOUT_MS = 120_000;
export const TRANSACTION_MAX_WAIT_MS = 30_000;

// An advisory lock keyed either by an explicit integer (the boot-time and
// migration locks) or by a name, which Postgres hashes the same way everywhere.
// Accepts bare keys or { key, shared }.
function advisoryKey(key) {
  return typeof key === 'number'
    ? Prisma.sql`${key}::bigint`
    : Prisma.sql`hashtextextended(${key}, 0)`;
}

function normalizeLock(lock) {
  return typeof lock === 'object' && lock !== null ? lock : { key: lock, shared: false };
}

// Acquires each lock in a fixed order so two callers asking for the same set in
// opposite orders cannot deadlock. Callers run this inside a transaction: the
// xact-scoped lock releases when that transaction commits or rolls back.
export async function acquireAdvisoryLocks(client, locks) {
  const normalized = locks.map(normalizeLock);
  normalized.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  for (const { key, shared } of normalized) {
    const fn = shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    // `::text` because the lock functions return void, which the client cannot
    // deserialize.
    await client.$queryRaw`SELECT ${Prisma.raw(fn)}(${advisoryKey(key)})::text`;
  }
}

// Runs `run` in a transaction that holds `locks`, keeping the locks until that
// callback resolves and the transaction commits. Whatever `run` returns comes
// back to the caller.
export async function withLocks(db, locks, run, options = {}) {
  return db.$transaction(
    async (tx) => {
      await acquireAdvisoryLocks(tx, locks);
      return run(tx);
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS, ...options },
  );
}
