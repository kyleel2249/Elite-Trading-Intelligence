import test from "node:test";
import assert from "node:assert/strict";
import { handleKnowledge } from "./knowledge.ts";
import { runModules, regimeOf, attributionFor, statEdge, kellySizing, MODULE_META } from "./strategies.ts";

const get = async (path: string) => { const r = handleKnowledge(new Request("https://eti.test" + path))!; return { status: r.status, body: await r.json() as any }; };

const REQUIRED_NAMES = ["George Soros","Stanley Druckenmiller","Paul Tudor Jones","Bruce Kovner","Richard Dennis","William Eckhardt","Ed Seykota","Mark Minervini","Nicolas Darvas","Jesse Livermore","Richard Wyckoff","William O'Neil","Larry Williams","Linda Bradford Raschke","Kathy Lien","Ray Dalio","Jim Simons","Warren Buffett","Charlie Munger","Peter Lynch","John Paulson","Michael Burry","David Tepper","John Templeton","Ed Thorp","Michael Steinhardt","Julian Robertson","David Shaw","Marty Schwartz","Tom Basso","Howard Marks","Chris Hohn","David Einhorn","John W. Henry","Robert Mercer"];

test("knowledge directory serves the full registry with all 25 required fields per profile", async () => {
  const { body } = await get("/api/intelligence/traders");
  assert.equal(body.source, "python-registry");
  const names = new Set(body.profiles.map((p: any) => p.name));
  for (const n of REQUIRED_NAMES) assert.ok(names.has(n), n);
  assert.ok(body.count >= 35);
  for (const p of body.profiles) assert.equal(p.completeness.fieldsPresent, 25, p.name + " missing " + p.completeness.missing);
  assert.match(body.limitations, /No private algorithms/);
});

test("single profile route returns the full profile with classified performance notes", async () => {
  const { status, body } = await get("/api/intelligence/traders/george_soros");
  assert.equal(status, 200);
  assert.equal(body.profile.full_name, "George Soros");
  for (const k of ["historical_returns", "win_rates", "net_worth"]) for (const n of body.profile[k]) assert.ok(["verified", "reported", "estimate", "speculation", "not_documented"].includes(n.classification));
  assert.equal((await get("/api/intelligence/traders/nobody_here")).status, 404);
});

test("directory search and strategies endpoint", async () => {
  const a = await get("/api/intelligence/traders?q=reflexivity");
  assert.ok(a.body.profiles.some((p: any) => p.name === "George Soros"));
  const s = await get("/api/intelligence/strategies");
  assert.equal(s.body.count, MODULE_META.length);
  assert.ok(s.body.modules.find((m: any) => m.id === "soros_reflexivity").candleTestable === false);
  assert.ok(s.body.modules.find((m: any) => m.id === "turtle_trend").candleTestable === true);
  assert.ok(s.body.combinationRules.length >= 4);
});

function candles(fn: (i: number) => number, n = 300) {
  return Array.from({ length: n }, (_, i) => { const c = fn(i), o = c - 0.1; return [i * 3600000, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c, 100 + (i % 5) * 10] as [number, number, number, number, number, number]; });
}
const ind = (adx: number) => ({ ema20: 110, ema50: 105, ema200: 100, rsi14: 55, macd: 1, macdSignal: 0.5, macdHistogram: 0.5, atr14: 1, atrPercent: 1, adx14: adx, bollingerUpper: 0, bollingerMiddle: 0, bollingerLower: 0, volumeRatio: 1, breakoutHigh20: 1000, breakoutLow20: -1000 });

test("regime gating suppresses incompatible families instead of averaging them", () => {
  const rows = candles(i => 100 + i * 0.2);
  assert.equal(regimeOf(30).state, "trend"); assert.equal(regimeOf(15).state, "range"); assert.equal(regimeOf(22).state, "transition");
  const status = (adx: number, id: string) => runModules(rows, ind(adx) as any).results.find(r => r.moduleId === id)!.status;
  assert.equal(status(30, "wyckoff_supply_demand"), "suppressed");
  assert.equal(status(30, "turtle_trend"), "active");
  assert.equal(status(15, "turtle_trend"), "suppressed");
  assert.equal(status(15, "wyckoff_supply_demand"), "active");
  assert.equal(status(22, "wyckoff_supply_demand"), "active");
});

test("macro and fundamental modules are reported as not_applicable, never simulated", () => {
  const { results } = runModules(candles(i => 100 + i * 0.2), ind(30) as any);
  for (const id of ["soros_reflexivity", "druck_liquidity_macro", "oneil_canslim", "buffett_munger_value", "lynch_fundamental", "burry_contrarian"]) {
    const r = results.find(x => x.moduleId === id)!; assert.equal(r.status, "not_applicable"); assert.equal(r.vote, 0); assert.match(r.reason, /needs/);
  }
  const att = attributionFor(results, 1);
  assert.equal(att.length, MODULE_META.length);
  assert.ok(att.some(a => a.trader.includes("Dennis")) && att.every(a => a.documentedPrinciple && a.contribution));
});

test("statistical edge and Kelly sizing never invent an edge", () => {
  assert.equal(statEdge({ sampleCount: 10, wins: 9, winRate: null }).verdict, "insufficient_sample");
  const none = statEdge({ sampleCount: 49, wins: 22, winRate: 44.9 });
  assert.equal(none.verdict, "no_edge");
  assert.equal(kellySizing({ sampleCount: 49, winRate: 44.9 }, none).suggestedRiskPercent, 0);
  const pos = statEdge({ sampleCount: 100, wins: 62, winRate: 62 });
  assert.equal(pos.verdict, "positive_edge");
  const k = kellySizing({ sampleCount: 100, winRate: 62 }, pos);
  assert.ok(k.suggestedRiskPercent > 0 && k.suggestedRiskPercent <= 1);
});

test("research pass: dated net-worth figures, deceased handling, and no placeholder win-rate speculation remain", async () => {
  const list = (await get("/api/intelligence/traders")).body.profiles;
  const status = (s: string) => list.filter((p: any) => p.netWorthStatus === s).length;
  assert.ok(status("dated_estimate") >= 14, "dated estimates: " + status("dated_estimate"));
  assert.ok(status("deceased") >= 7);
  assert.equal(status("undated_estimate"), 0);
  assert.equal(status("none"), 0);
  const soros = (await get("/api/intelligence/traders/george_soros")).body;
  assert.equal(soros.netWorthStatus, "dated_estimate");
  assert.match(soros.profile.net_worth[0].claim, /8\.6B/);
  assert.match(soros.profile.net_worth[0].source, /2026/);
  assert.equal(soros.profile.win_rates[0].classification, "reported");
  for (const p of list) {
    const full = (await get("/api/intelligence/traders/" + p.id)).body.profile;
    for (const n of full.net_worth) assert.ok(!/media estimate if any/i.test(n.claim), p.id);
    for (const n of full.win_rates) assert.notEqual(n.classification, "speculation", p.id + " win rate still speculation");
    for (const n of full.net_worth) if (n.classification === "estimate") assert.match(n.source || "", /(19|20)\d\d/, p.id + " undated estimate");
  }
  const simons = (await get("/api/intelligence/traders/jim_simons")).body.profile;
  assert.match(simons.net_worth[0].claim, /family/i);
});
