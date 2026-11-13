import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { withSports } from "./route.ts";
import { sqliteD1 } from "../portfolio/testing.ts";

const TOKEN = "sports-token-0123456789";
async function world(score: [number, number] | null) {
  const db = sqliteD1(); const raw: any = db;
  for (const f of readdirSync(new URL("../../migrations/", import.meta.url)).filter(f => /^000[3-8]/.test(f)).sort()) for (const st of readFileSync(new URL("../../migrations/" + f, import.meta.url), "utf8").split(/;\s*\n/)) if (st.trim()) await db.prepare(st).run();
  await db.prepare("INSERT INTO sports_bankroll (id,balance_cents,created_at,updated_at) VALUES (1,100000,1,1)").run();
  await db.prepare("INSERT INTO sports_bets (id,created_at,sport,event_name,market,selection,odds,model_probability,stake_cents,status,profit_cents,event_id,bookmaker,odds_provider,implied_probability,expected_value,model_version) VALUES ('11111111-1111-1111-1111-111111111111',1,'Football','A vs B','Full Time Result','Home',2.0,0.6,1000,'OPEN',0,'fx1','bk','test',0.5,0.2,'m1')").run();
  if (score) await db.prepare("INSERT INTO sports_match_results (fixture_id,played_at,home_team,away_team,home_goals,away_goals,source,updated_at) VALUES ('fx1',1,'A','B',?,?,'test',1)").bind(score[0], score[1]).run();
  const app = withSports({ fetch: () => new Response("base") } as any), env: any = { ETI_PORTFOLIO_DB: db, ETI_SPORTS_PAPER_TOKEN: TOKEN };
  const settle = (result: string) => app.fetch(new Request("https://x.test/api/sports/bets/11111111-1111-1111-1111-111111111111/settle", { method: "POST", headers: { "x-eti-sports-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ result }) }), env);
  return { settle, db };
}
test("manual settlement cannot invent a result: no recorded score = refused", async () => {
  const { settle, db } = await world(null); const r = await settle("WON"); assert.equal(r.status, 409); assert.equal(((await r.json()) as any).error, "result_not_recorded");
  assert.equal((await db.prepare("SELECT status FROM sports_bets").first<any>()).status, "OPEN");
});
test("manual settlement must agree with the recorded score", async () => {
  const { settle, db } = await world([0, 2]); const r = await settle("WON"); assert.equal(r.status, 422); const j: any = await r.json(); assert.equal(j.error, "result_mismatch"); assert.equal(j.derived_result, "LOST");
  assert.equal((await db.prepare("SELECT status FROM sports_bets").first<any>()).status, "OPEN"); assert.equal((await db.prepare("SELECT balance_cents FROM sports_bankroll").first<any>()).balance_cents, 100000);
  const ok = await settle("LOST"); assert.equal(ok.status, 200); assert.equal(((await ok.json()) as any).profit_cents, -1000);
  assert.equal((await settle("LOST")).status, 409, "a settled bet cannot be settled again");
});
test("a winning bet pays out once; VOID returns the stake without a score", async () => {
  const w = await world([3, 1]); const r = await w.settle("WON"); assert.equal(r.status, 200); assert.equal(((await r.json()) as any).gross_return_cents, 2000); assert.equal((await w.db.prepare("SELECT balance_cents FROM sports_bankroll").first<any>()).balance_cents, 102000);
  const v = await world(null); assert.equal((await v.settle("VOID")).status, 200); assert.equal((await v.db.prepare("SELECT balance_cents FROM sports_bankroll").first<any>()).balance_cents, 100000 + 1000);
});
