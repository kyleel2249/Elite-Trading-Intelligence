-- Separate ETI sports paper-betting ledger. No connection to financial trading balances.
CREATE TABLE IF NOT EXISTS sports_bankroll (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sports_bets (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  sport TEXT NOT NULL,
  event_name TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds REAL NOT NULL CHECK (odds > 1),
  model_probability REAL NOT NULL CHECK (model_probability > 0 AND model_probability < 1),
  stake_cents INTEGER NOT NULL CHECK (stake_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('OPEN','WON','LOST','VOID')),
  profit_cents INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS sports_bets_created ON sports_bets(created_at DESC);
CREATE INDEX IF NOT EXISTS sports_bets_status ON sports_bets(status,created_at DESC);
