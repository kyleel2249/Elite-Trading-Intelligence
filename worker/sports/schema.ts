/**
 * Self-healing D1 schema for the sports module.
 *
 * Mirrors migrations/0003 to 0007 exactly (tables, the extra sports_bets columns, every index including the unique ones the
 * ON CONFLICT upserts and the one-open-bet-per-fixture rule depend on). Everything is idempotent (IF NOT EXISTS / column check),
 * so it is safe on a brand-new empty database, on a partially migrated one, and on a fully migrated one.
 *
 * Why it exists: a Cloudflare deploy does not apply D1 migrations, so a database that was created but never migrated fails every
 * scan with "no such table: sports_model_predictions". The guard (guard.ts) calls this once per Worker isolate before any
 * /api/sports request. `wrangler d1 migrations apply` remains the canonical path and produces the identical schema.
 */
const TABLES = [
  "CREATE TABLE IF NOT EXISTS sports_bankroll (id INTEGER PRIMARY KEY CHECK (id = 1), balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sports_bets (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, sport TEXT NOT NULL, event_name TEXT NOT NULL, market TEXT NOT NULL, selection TEXT NOT NULL, odds REAL NOT NULL CHECK (odds > 1), model_probability REAL NOT NULL CHECK (model_probability > 0 AND model_probability < 1), stake_cents INTEGER NOT NULL CHECK (stake_cents > 0), status TEXT NOT NULL CHECK (status IN ('OPEN','WON','LOST','VOID')), profit_cents INTEGER NOT NULL DEFAULT 0, settled_at INTEGER, event_id TEXT, bookmaker TEXT, odds_provider TEXT, implied_probability REAL, expected_value REAL, model_version TEXT)",
  "CREATE TABLE IF NOT EXISTS sports_event_scans (id TEXT PRIMARY KEY, scanned_at INTEGER NOT NULL, provider TEXT NOT NULL, fixture_id TEXT NOT NULL, sport TEXT NOT NULL, event_name TEXT NOT NULL, competition TEXT, country TEXT, commence_time TEXT NOT NULL, bookmaker_count INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sports_match_results (fixture_id TEXT PRIMARY KEY, played_at INTEGER NOT NULL, competition TEXT, country TEXT, home_team TEXT NOT NULL, away_team TEXT NOT NULL, home_goals INTEGER NOT NULL CHECK(home_goals >= 0), away_goals INTEGER NOT NULL CHECK(away_goals >= 0), source TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sports_model_predictions (id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL, created_at INTEGER NOT NULL, kickoff_at INTEGER NOT NULL, competition TEXT, home_team TEXT NOT NULL, away_team TEXT NOT NULL, p_home REAL NOT NULL, p_draw REAL NOT NULL, p_away REAL NOT NULL, expected_home_goals REAL NOT NULL, expected_away_goals REAL NOT NULL, model_version TEXT NOT NULL, sample_size INTEGER NOT NULL, actual_outcome TEXT CHECK(actual_outcome IN ('H','D','A') OR actual_outcome IS NULL), settled_at INTEGER, best_market TEXT, best_selection TEXT, best_odds REAL, best_probability REAL, best_bookmaker TEXT, expected_value REAL, recommended_stake_cents INTEGER NOT NULL DEFAULT 0, decision TEXT NOT NULL DEFAULT 'NO_BET')",
  "CREATE TABLE IF NOT EXISTS sports_job_state (job_name TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT)",
];

/** Columns migration 0004 added to sports_bets; added to a database whose sports_bets table predates them. */
const BET_COLUMNS: Array<[string, string]> = [
  ["event_id", "TEXT"], ["bookmaker", "TEXT"], ["odds_provider", "TEXT"], ["implied_probability", "REAL"], ["expected_value", "REAL"], ["model_version", "TEXT"],
];

const PLAIN_INDEXES = [
  "CREATE INDEX IF NOT EXISTS sports_bets_created ON sports_bets(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_bets_status ON sports_bets(status,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_event_scans_fixture ON sports_event_scans(fixture_id, scanned_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_event_scans_time ON sports_event_scans(scanned_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_match_results_date ON sports_match_results(played_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_match_results_competition ON sports_match_results(competition, played_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_model_predictions_fixture ON sports_model_predictions(fixture_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS sports_model_predictions_evaluation ON sports_model_predictions(actual_outcome, created_at DESC)",
];

/** Unique indexes: the prediction upsert needs the first; the second enforces one open model-backed stake per fixture (migration 0007). */
const UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS sports_model_predictions_unique_fixture_version ON sports_model_predictions(fixture_id, model_version)",
  "CREATE UNIQUE INDEX IF NOT EXISTS sports_bets_one_open_model_bet_per_fixture ON sports_bets(event_id) WHERE event_id IS NOT NULL AND model_version IS NOT NULL AND status='OPEN'",
];

const memo = new WeakMap<object, Promise<void>>();

async function run(d: D1Database): Promise<void> {
  await d.batch(TABLES.map(sql => d.prepare(sql)));
  const info = await d.prepare("PRAGMA table_info(sports_bets)").all<any>();
  const have = new Set((info.results || []).map((r: any) => String(r.name)));
  for (const [column, type] of BET_COLUMNS) {
    if (have.has(column)) continue;
    try { await d.prepare("ALTER TABLE sports_bets ADD COLUMN " + column + " " + type).run(); }
    catch (e) { if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e; }
  }
  await d.prepare("DROP INDEX IF EXISTS sports_bets_one_open_model_bet_per_event").run();
  await d.batch(PLAIN_INDEXES.map(sql => d.prepare(sql)));
  for (const sql of UNIQUE_INDEXES) {
    try { await d.prepare(sql).run(); }
    catch (e) { console.error("sports schema: could not create unique index (existing duplicate rows? apply migrations 0006 and 0007)", e instanceof Error ? e.message : e); }
  }
}

/** Idempotent; runs once per D1 binding per isolate. A failed attempt is not remembered, so the next request retries. */
export function ensureSportsSchema(d: D1Database): Promise<void> {
  let p = memo.get(d as any);
  if (!p) {
    p = run(d).catch(e => { memo.delete(d as any); throw e; });
    memo.set(d as any, p);
  }
  return p;
}
