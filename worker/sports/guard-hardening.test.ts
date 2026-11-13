import { test } from "node:test";
import assert from "node:assert/strict";
import { withSportsGuard, resetSportsGuardCache, sanitizeHealth } from "./guard.ts";
import { settleFromStoredResults, fullTimeResultWon } from "./settlement.ts";

const env = { ETI_SPORTS_PAPER_TOKEN: "secret-token" } as any;
const auth = { "x-eti-sports-token": "secret-token" };
const healthBody = { ok: true, providers: { oddspapi: { configured: true, reachable: true, request_limit: 500, request_count: 12, sports: [10], bookmaker_count: 3 }, the_odds_api: { configured: true, reachable: true, requests_remaining: "77" } }, database: { configured: true, ready: false, error: "SQLITE_ERROR: no such table" } };
const healthRes = () => new Response(JSON.stringify(healthBody), { status: 200, headers: { "content-type": "application/json" } });

test("anonymous health is sanitised and cached; authorised health is full and uncached", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const app = withSportsGuard({ fetch: () => { calls++; return healthRes(); } } as any);
  const url = "https://eti.test/api/sports/health";
  const a = await (await app.fetch(new Request(url), env)).json() as any;
  await app.fetch(new Request(url), env);
  assert.equal(calls, 1);
  assert.equal(a.providers.oddspapi.request_limit, undefined);
  assert.equal(a.providers.oddspapi.request_count, undefined);
  assert.equal(a.providers.oddspapi.sports, undefined);
  assert.equal(a.providers.the_odds_api.requests_remaining, undefined);
  assert.equal(a.database.error, "database_query_failed");
  assert.equal(a.providers.oddspapi.bookmaker_count, 3);
  const full = await (await app.fetch(new Request(url, { headers: auth }), env)).json() as any;
  assert.equal(calls, 2);
  assert.equal(full.providers.oddspapi.request_limit, 500);
  assert.equal(sanitizeHealth("not json"), "not json");
});

test("the paid live-odds proxy requires the paper token", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const app = withSportsGuard({ fetch: () => { calls++; return new Response("{}", { status: 200 }); } } as any);
  const url = "https://eti.test/api/sports/events?sport=soccer_epl";
  assert.equal((await app.fetch(new Request(url), env)).status, 401);
  assert.equal((await app.fetch(new Request(url, { headers: { "x-eti-sports-token": "wrong" } }), env)).status, 401);
  assert.equal(calls, 0);
  assert.equal((await app.fetch(new Request(url, { headers: auth }), env)).status, 200);
  assert.equal(calls, 1);
});

function fakeDb(openBets: any[]) {
  const log: string[] = [];
  const batches: any[][] = [];
  const stmt = (sql: string) => ({ sql, args: [] as any[], bind(...a: any[]) { this.args = a; return this; }, async run() { log.push(sql); return { meta: { changes: 2 } }; }, async all() { log.push(sql); return { results: sql.startsWith("SELECT b.id") ? openBets : [] }; } });
  return { log, batches, prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => { batches.push(s); return s.map(() => ({ meta: { changes: 1 } })); } } as any;
}

test("stored results settle stranded OPEN full-time-result bets exactly once and credit the bankroll", async () => {
  const db = fakeDb([
    { id: "b1", market: "Full Time Result", selection: "Home", odds: 2.5, stake_cents: 100, home_goals: 2, away_goals: 1 },
    { id: "b2", market: "Full Time Result", selection: "Away", odds: 3, stake_cents: 50, home_goals: 2, away_goals: 1 },
    { id: "b3", market: "Over/Under Full Time", selection: "Over 2.5", odds: 2, stake_cents: 50, home_goals: 2, away_goals: 1 },
  ]);
  const r = await settleFromStoredResults(db, 1000);
  assert.equal(r.betsSettled, 2);
  assert.equal(r.predictionsSettled, 2);
  assert.equal(db.batches.length, 2);
  assert.deepEqual(db.batches[0][0].args, ["WON", 150, 1000, "b1"]);
  assert.deepEqual(db.batches[0][1].args, [250, 1000]);
  assert.deepEqual(db.batches[1][0].args, ["LOST", -50, 1000, "b2"]);
  assert.deepEqual(db.batches[1][1].args, [0, 1000]);
  assert.equal(fullTimeResultWon("Both Teams To Score", "Yes", "H"), null);
});

test("an authorised history sync triggers backlog settlement and reports it", async () => {
  resetSportsGuardCache();
  const db = fakeDb([{ id: "b1", market: "Full Time Result", selection: "Draw", odds: 3, stake_cents: 100, home_goals: 1, away_goals: 1 }]);
  const app = withSportsGuard({ fetch: () => new Response(JSON.stringify({ ok: false }), { status: 502 }) } as any);
  const res = await app.fetch(new Request("https://eti.test/api/sports/football/sync-history", { method: "POST", headers: auth, body: "{}" }), { ...env, ETI_PORTFOLIO_DB: db });
  assert.equal(res.status, 502);
  assert.match(res.headers.get("x-eti-backlog-settled") || "", /^1 bets/);
  // schema self-healing also uses batches now; count only the settlement batches
  assert.equal(db.batches.filter((b: any[]) => b.some((st: any) => /UPDATE sports_bets/.test(st.sql))).length, 1);
});
