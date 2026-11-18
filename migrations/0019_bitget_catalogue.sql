-- Durable Bitget instrument catalogue (additive; no existing table is altered).
-- One row per Bitget category holds the last confirmed pair list; the every-minute cron rewrites rows_json only when the
-- content hash changes and otherwise just advances fetched_at, so a minute of "nothing changed" costs one tiny UPDATE.
-- A category that fails to refresh keeps its previous row (its fetched_at then shows how stale it is) instead of vanishing.
CREATE TABLE IF NOT EXISTS eti_bitget_catalogue (
  category     TEXT PRIMARY KEY CHECK(category IN ('SPOT','USDT-FUTURES','USDC-FUTURES','COIN-FUTURES','MARGIN')),
  rows_json    TEXT NOT NULL,
  pair_count   INTEGER NOT NULL CHECK(pair_count >= 0),
  content_hash TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  changed_at   INTEGER NOT NULL
);

-- Listings and delistings observed between two successful refreshes of the same category (market observations, prunable).
-- The very first load of a category is the baseline and produces no events.
CREATE TABLE IF NOT EXISTS eti_bitget_catalogue_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('SPOT','USDT-FUTURES','USDC-FUTURES','COIN-FUTURES','MARGIN')),
  change   TEXT NOT NULL CHECK(change IN ('listed','delisted')),
  symbol   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eti_bitget_catalogue_events_at ON eti_bitget_catalogue_events(at);

-- Small key/value row for the outcome of the latest sync run (k = 'last_run').
CREATE TABLE IF NOT EXISTS eti_bitget_catalogue_meta (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
