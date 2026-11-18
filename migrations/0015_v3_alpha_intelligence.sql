-- ETIAlgo V3 Alpha immutable signal history and forward outcome tracking.
CREATE TABLE IF NOT EXISTS eti_v3_alpha_signals (
 id TEXT PRIMARY KEY,
 symbol TEXT NOT NULL,
 strategy TEXT NOT NULL CHECK(strategy IN ('scalp','intraday','swing','position')),
 venue TEXT NOT NULL,
 market TEXT NOT NULL CHECK(market IN ('spot','futures')),
 category TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 direction INTEGER NOT NULL CHECK(direction IN (-1,1)),
 signal_time INTEGER NOT NULL,
 received_at INTEGER NOT NULL,
 entry_low REAL NOT NULL,
 entry_high REAL NOT NULL,
 entry REAL NOT NULL,
 stop_loss REAL NOT NULL,
 tp1 REAL NOT NULL,
 tp2 REAL NOT NULL,
 tp3 REAL NOT NULL,
 score INTEGER NOT NULL,
 threshold INTEGER NOT NULL,
 regime TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 outcome TEXT CHECK(outcome IN ('win','loss','expired')),
 outcome_r REAL,
 resolved_at INTEGER,
 last_checked_at INTEGER,
 bars_observed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_eti_v3_alpha_symbol_time ON eti_v3_alpha_signals(symbol,signal_time DESC);
CREATE INDEX IF NOT EXISTS idx_eti_v3_alpha_open ON eti_v3_alpha_signals(outcome,signal_time ASC);
CREATE INDEX IF NOT EXISTS idx_eti_v3_alpha_strategy ON eti_v3_alpha_signals(strategy,signal_time DESC);
