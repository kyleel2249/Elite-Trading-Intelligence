-- Persist completed football fixtures used by the ETI prediction and calibration engine.
-- The history sync route reads and upserts these exact columns.
CREATE TABLE IF NOT EXISTS sports_match_results (
  fixture_id TEXT PRIMARY KEY NOT NULL,
  played_at INTEGER NOT NULL,
  competition TEXT,
  country TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_goals INTEGER NOT NULL CHECK (home_goals >= 0),
  away_goals INTEGER NOT NULL CHECK (away_goals >= 0),
  source TEXT NOT NULL DEFAULT 'OddsPapi',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sports_match_results_played_at_idx
ON sports_match_results(played_at DESC);

CREATE INDEX IF NOT EXISTS sports_match_results_competition_played_at_idx
ON sports_match_results(competition, played_at DESC);
