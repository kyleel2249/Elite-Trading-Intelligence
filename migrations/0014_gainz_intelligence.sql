-- GainzAlgo V2 and V2 Alpha signal intelligence; append-only signal and outcome records.
CREATE TABLE IF NOT EXISTS gainz_signals (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL CHECK (engine IN ('gainz_v2','gainz_v2_alpha')),
  preset TEXT NOT NULL,
  symbol TEXT NOT NULL,
  exchange_name TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('spot','futures')),
  direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  timeframe TEXT NOT NULL,
  signal_timestamp INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  entry REAL,
  stop_loss REAL,
  tp1 REAL,
  tp2 REAL,
  tp3 REAL,
  state TEXT NOT NULL CHECK (state IN ('received','validated','rejected','expired')),
  score INTEGER NOT NULL DEFAULT 0,
  consensus TEXT NOT NULL DEFAULT 'single_engine' CHECK (consensus IN ('single_engine','agreement','conflict')),
  consensus_score INTEGER NOT NULL DEFAULT 0,
  reward_risk REAL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_gainz_signals_engine_received ON gainz_signals(engine, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_gainz_signals_symbol_timeframe ON gainz_signals(symbol, timeframe, signal_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_gainz_signals_consensus ON gainz_signals(consensus, received_at DESC);
CREATE TABLE IF NOT EXISTS gainz_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL REFERENCES gainz_signals(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gainz_events_signal ON gainz_events(signal_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gainz_outcomes (
  signal_id TEXT PRIMARY KEY REFERENCES gainz_signals(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('win','loss','breakeven','cancelled')),
  net_r REAL NOT NULL,
  pnl REAL,
  closed_at INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gainz_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
