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

-- Extend each paper stake with source provenance and explicit price/probability metrics.
ALTER TABLE sports_bets ADD COLUMN event_id TEXT;
ALTER TABLE sports_bets ADD COLUMN bookmaker TEXT;
ALTER TABLE sports_bets ADD COLUMN odds_provider TEXT;
ALTER TABLE sports_bets ADD COLUMN implied_probability REAL;
ALTER TABLE sports_bets ADD COLUMN expected_value REAL;
ALTER TABLE sports_bets ADD COLUMN model_version TEXT;
