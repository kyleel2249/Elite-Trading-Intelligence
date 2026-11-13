import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureSportsSchema } from "./schema.ts";
import { withSportsGuard, resetSportsGuardCache } from "./guard.ts";

function fakeDb(existingBetColumns: string[]) {
  const sql: string[] = [];
  const stmt = (s: string) => ({ s, bind() { return this; }, async run() { sql.push(s); return { meta: { changes: 0 } }; }, async all() { sql.push(s); return { results: s.startsWith("PRAGMA") ? existingBetColumns.map(name => ({ name })) : [] }; } });
  return { sql, prepare: (s: string) => stmt(s), batch: async (b: any[]) => { for (const x of b) sql.push(x.s); return b.map(() => ({ meta: { changes: 0 } })); } } as any;
}

test("schema creates every sports table and index on an empty database", async () => {
  const db = fakeDb([]);
  await ensureSportsSchema(db);
  for (const t of ["sports_bankroll", "sports_bets", "sports_event_scans", "sports_match_results", "sports_model_predictions", "sports_job_state"]) assert.ok(db.sql.some((s: string) => s.startsWith("CREATE TABLE IF NOT EXISTS " + t + " ")), t);
  assert.ok(db.sql.some((s: string) => s.includes("sports_model_predictions_unique_fixture_version")));
  assert.ok(db.sql.some((s: string) => s.includes("sports_bets_one_open_model_bet_per_fixture")));
});

test("schema adds only the sports_bets columns an older table is missing, and runs once per database", async () => {
  const db = fakeDb(["id", "event_id", "bookmaker"]);
  await ensureSportsSchema(db);
  await ensureSportsSchema(db);
  const alters = db.sql.filter((s: string) => s.startsWith("ALTER TABLE sports_bets ADD COLUMN"));
  assert.deepEqual(alters.sort(), ["ALTER TABLE sports_bets ADD COLUMN expected_value REAL", "ALTER TABLE sports_bets ADD COLUMN implied_probability REAL", "ALTER TABLE sports_bets ADD COLUMN model_version TEXT", "ALTER TABLE sports_bets ADD COLUMN odds_provider TEXT"]);
  assert.equal(db.sql.filter((s: string) => s.startsWith("PRAGMA")).length, 1);
});

test("the guard ensures the schema before delegating a sports request", async () => {
  resetSportsGuardCache();
  const db = fakeDb([]);
  let schemaReadyWhenRouteRan = false;
  const app = withSportsGuard({ fetch: () => { schemaReadyWhenRouteRan = db.sql.some((s: string) => s.includes("sports_model_predictions")); return new Response("{}", { status: 200 }); } } as any);
  await app.fetch(new Request("https://eti.test/api/sports/status"), { ETI_PORTFOLIO_DB: db } as any);
  assert.equal(schemaReadyWhenRouteRan, true);
});
