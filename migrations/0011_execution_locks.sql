-- Step 3 of the autonomous-trading build: atomic execution locks and an idempotency ledger.
-- eti_execution_locks: one row per lock key. A row whose expires_at has passed may be taken over.
-- eti_idempotency: one row per operation key. State is pending, done, failed or indeterminate.
-- failed means the operation definitively never reached the venue and may be retried. indeterminate means the outcome
-- is unknown and must be resolved by reconciliation, never re-sent automatically.

CREATE TABLE IF NOT EXISTS eti_execution_locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eti_idempotency (
  idem_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'indeterminate')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eti_idempotency_scope ON eti_idempotency (scope, state);
