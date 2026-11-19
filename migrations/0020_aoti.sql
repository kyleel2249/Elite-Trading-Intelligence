-- ETI Autonomous On-chain Trading Intelligence. Paper positions only; no wallet signing or live DEX orders.
CREATE TABLE IF NOT EXISTS eti_aoti_candidates (
  id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, pair_address TEXT NOT NULL,
  symbol TEXT NOT NULL, score REAL NOT NULL, security_gate TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK(eligible IN (0,1)), payload_json TEXT NOT NULL, observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aoti_candidates_observed ON eti_aoti_candidates(observed_at DESC,score DESC);
CREATE TABLE IF NOT EXISTS eti_aoti_positions (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  symbol TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')),
  entry_price REAL NOT NULL, last_price REAL NOT NULL, quantity REAL NOT NULL, notional_usd REAL NOT NULL,
  remaining_pct REAL NOT NULL, realized_pnl_usd REAL NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aoti_positions_status ON eti_aoti_positions(status,opened_at DESC);
CREATE TABLE IF NOT EXISTS eti_aoti_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, candidate_id TEXT, position_id TEXT,
  reason TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aoti_events_created ON eti_aoti_events(created_at DESC);
CREATE TABLE IF NOT EXISTS eti_aoti_state(k TEXT PRIMARY KEY,v TEXT NOT NULL,updated_at INTEGER NOT NULL);
