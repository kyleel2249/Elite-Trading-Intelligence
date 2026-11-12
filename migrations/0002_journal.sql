-- ETI Autonomous Trade Journal: append-only, hash-chained. Rows are only ever inserted, never updated or deleted.
CREATE TABLE IF NOT EXISTS jr_entries (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  trade_id TEXT,
  symbol TEXT,
  env TEXT,
  hash TEXT NOT NULL,
  prev TEXT,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jr_entries_trade ON jr_entries (trade_id, seq);
CREATE INDEX IF NOT EXISTS jr_entries_at ON jr_entries (at);
CREATE TABLE IF NOT EXISTS jr_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
