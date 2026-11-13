-- Audit trail for automatically discovered football events and their bookmaker-price snapshots.
CREATE TABLE IF NOT EXISTS sports_event_scans (
  id TEXT PRIMARY KEY,
  scanned_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  event_name TEXT NOT NULL,
  competition TEXT,
  country TEXT,
  commence_time TEXT NOT NULL,
  bookmaker_count INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sports_event_scans_fixture ON sports_event_scans(fixture_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS sports_event_scans_time ON sports_event_scans(scanned_at DESC);

-- Source provenance and explicit price/probability metrics on each paper stake (event_id, bookmaker, odds_provider,
-- implied_probability, expected_value, model_version) are defined in 0003_sports_betting.sql. They are deliberately not
-- added with ALTER TABLE here: that statement fails with "duplicate column name" on a database whose sports_bets table was
-- already created with them (for example by worker/sports/schema.ts), which aborted the deploy. schema.ts adds any missing
-- column to a database created from an older 0003.
