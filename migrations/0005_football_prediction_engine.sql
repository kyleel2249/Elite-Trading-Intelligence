-- Historical results, independently generated predictions and model evaluation ledger.
CREATE TABLE IF NOT EXISTS sports_match_results (
  fixture_id TEXT PRIMARY KEY,
  played_at INTEGER NOT NULL,
  competition TEXT,
  country TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_goals INTEGER NOT NULL CHECK(home_goals >= 0),
  away_goals INTEGER NOT NULL CHECK(away_goals >= 0),
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sports_match_results_date ON sports_match_results(played_at DESC);
CREATE INDEX IF NOT EXISTS sports_match_results_competition ON sports_match_results(competition, played_at DESC);
CREATE TABLE IF NOT EXISTS sports_model_predictions (
  id TEXT PRIMARY KEY,
  fixture_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kickoff_at INTEGER NOT NULL,
  competition TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  p_home REAL NOT NULL,
  p_draw REAL NOT NULL,
  p_away REAL NOT NULL,
  expected_home_goals REAL NOT NULL,
  expected_away_goals REAL NOT NULL,
  model_version TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  actual_outcome TEXT CHECK(actual_outcome IN ('H','D','A') OR actual_outcome IS NULL),
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS sports_model_predictions_fixture ON sports_model_predictions(fixture_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sports_model_predictions_evaluation ON sports_model_predictions(actual_outcome, created_at DESC);
CREATE TABLE IF NOT EXISTS sports_job_state (
  job_name TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);
