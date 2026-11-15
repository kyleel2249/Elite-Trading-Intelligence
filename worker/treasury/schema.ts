/**
 * Treasury schema. The same CREATE/INSERT statements live in migrations/0010_treasury.sql (worker/treasury/model.test.ts fails if they
 * drift apart) and are also run once per isolate by the API, so a deploy that does not apply D1 migrations still works.
 *
 * Immutability: the ledger tables (treasury_entries, treasury_lines) have no update or delete route, every entry carries a hash chained to the
 * previous entry of its environment (verifiable at /api/treasury/verify), and the TRIGGERS below make the database itself refuse UPDATE and DELETE.
 * The triggers are created at runtime (not in the migration file) so that a D1 deployment without trigger support cannot block a deploy;
 * /api/treasury/verify reports whether they are present.
 *
 * Invariants enforced by the database inside one transaction (D1 batch): non-negative bucket balances (balance_guard), a single writer per
 * environment chain (chain_guard), policy/state preconditions (policy_guard) and loss tracking that never goes negative (loss_guard).
 */
export const SCHEMA: string[] = [
`CREATE TABLE IF NOT EXISTS treasury_chain (
  environment TEXT PRIMARY KEY CHECK (environment IN ('actual','simulated')),
  seq INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT NOT NULL DEFAULT 'GENESIS'
)`,
`INSERT OR IGNORE INTO treasury_chain (environment, seq, head_hash) VALUES ('actual', 0, 'GENESIS'), ('simulated', 0, 'GENESIS')`,
`CREATE TABLE IF NOT EXISTS treasury_state (
  environment TEXT PRIMARY KEY CHECK (environment IN ('actual','simulated')),
  unrecovered_loss_cents INTEGER NOT NULL DEFAULT 0 CONSTRAINT loss_guard CHECK (unrecovered_loss_cents >= 0)
)`,
`INSERT OR IGNORE INTO treasury_state (environment, unrecovered_loss_cents) VALUES ('actual', 0), ('simulated', 0)`,
`CREATE TABLE IF NOT EXISTS treasury_guard (
  chain_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT chain_guard CHECK (chain_ok = 1),
  policy_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT policy_guard CHECK (policy_ok = 1)
)`,
`CREATE TABLE IF NOT EXISTS treasury_balances (
  environment TEXT NOT NULL CHECK (environment IN ('actual','simulated')),
  account_code TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '*',
  allow_negative INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, account_code, department_id),
  CONSTRAINT balance_guard CHECK (allow_negative = 1 OR balance_cents >= 0)
)`,
`CREATE TABLE IF NOT EXISTS treasury_entries (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('actual','simulated')),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reference TEXT,
  period TEXT,
  memo TEXT NOT NULL DEFAULT '',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (environment, seq)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_entries_ref ON treasury_entries (environment, reference)`,
`CREATE TABLE IF NOT EXISTS treasury_lines (
  entry_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_code TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '*',
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, line_no),
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
)`,
`CREATE INDEX IF NOT EXISTS idx_treasury_lines_account ON treasury_lines (account_code, department_id)`,
`CREATE TABLE IF NOT EXISTS treasury_policies (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('actual','simulated')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','superseded','rejected')),
  min_trading_capital_cents INTEGER NOT NULL CHECK (min_trading_capital_cents >= 0),
  loss_recovery_bps INTEGER NOT NULL CHECK (loss_recovery_bps BETWEEN 0 AND 10000),
  reserve_target_cents INTEGER NOT NULL CHECK (reserve_target_cents >= 0),
  reserve_bps INTEGER NOT NULL CHECK (reserve_bps BETWEEN 0 AND 10000),
  liquidity_min_cents INTEGER NOT NULL CHECK (liquidity_min_cents >= 0),
  operating_bps INTEGER NOT NULL CHECK (operating_bps BETWEEN 0 AND 10000),
  long_term_bps INTEGER NOT NULL CHECK (long_term_bps BETWEEN 0 AND 10000),
  reinvest_bps INTEGER NOT NULL CHECK (reinvest_bps BETWEEN 0 AND 10000),
  proposed_by TEXT NOT NULL,
  proposed_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (environment, version),
  CHECK (operating_bps + long_term_bps + reinvest_bps = 10000)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_policy_active ON treasury_policies (environment) WHERE status = 'active'`,
`CREATE TABLE IF NOT EXISTS treasury_profit_batches (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('actual','simulated')),
  period TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  gross_cents INTEGER NOT NULL,
  fees_cents INTEGER NOT NULL CHECK (fees_cents >= 0),
  net_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','settled','reconciled','rejected')),
  recorded_by TEXT NOT NULL,
  settled_by TEXT,
  settled_at INTEGER,
  settlement_reference TEXT,
  reconciled_by TEXT,
  reconciled_at INTEGER,
  reconciliation_reference TEXT,
  entry_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_treasury_batches_status ON treasury_profit_batches (environment, status)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_batch_settlement ON treasury_profit_batches (environment, settlement_reference) WHERE settlement_reference IS NOT NULL`,
];

export const TRIGGERS: string[] = [
  `CREATE TRIGGER IF NOT EXISTS treasury_entries_no_update BEFORE UPDATE ON treasury_entries BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS treasury_entries_no_delete BEFORE DELETE ON treasury_entries BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS treasury_lines_no_update BEFORE UPDATE ON treasury_lines BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS treasury_lines_no_delete BEFORE DELETE ON treasury_lines BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END`,
];
