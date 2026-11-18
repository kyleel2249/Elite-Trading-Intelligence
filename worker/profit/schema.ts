/** Profit engine tables. Mirrored in migrations/0013_profit_engine.sql (worker/profit/profit.test.ts fails if they drift apart) and also created on first use. */
export const SCHEMA: string[] = [
`CREATE TABLE IF NOT EXISTS profit_engine_trades (
  trade_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('actual','simulated')),
  batch_id TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  fees_cents INTEGER NOT NULL CHECK (fees_cents >= 0),
  net_cents INTEGER NOT NULL,
  strategy TEXT,
  symbol TEXT,
  recognised_at INTEGER NOT NULL,
  PRIMARY KEY (trade_id, environment)
)`,
`CREATE INDEX IF NOT EXISTS idx_profit_engine_trades_time ON profit_engine_trades (environment, closed_at)`,
`CREATE TABLE IF NOT EXISTS profit_engine_runs (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  batch_id TEXT,
  entry_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
)`,
`CREATE INDEX IF NOT EXISTS idx_profit_engine_runs_time ON profit_engine_runs (environment, at)`,
`CREATE TABLE IF NOT EXISTS profit_engine_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
)`,
];
