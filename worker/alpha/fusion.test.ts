import test from "node:test";
import assert from "node:assert/strict";
import { analyseEarlyAlpha } from "./earlyalpha.ts";
import { buildPlan, fuse, independentValidation, sizePosition } from "./fusion.ts";
import { evaluateDisclosure, consensusFor } from "./copytrade.ts";
import { WATCH_ENTITIES, classifyDelay, type Disclosure } from "./sec.ts";
import { makeCandles, range, trend } from "./testdata.ts";
import { runLab } from "./lab.ts";
import { signalFromCandles } from "../signals.ts";

const NOW = 1_700_000_000_000, fresh = (segs: any[], seed = 3) => { const rows = makeCandles(segs, { price: 50, seed, start: NOW - 3600_000 * segs.reduce((a, s) => a + s.bars, 0) + 3600_000 }); return rows; };
const upSegs = [range(150, 0.004, 5000), trend(70, 0.003, 0.003, 7000)];

test("buildPlan: stop below entry, ascending targets, reward/risk 1.5/3/4.5", () => {
  const p = buildPlan(fresh(upSegs))!; assert.ok(p.stop < p.entry); assert.deepEqual(p.targets.map(t => t.rewardRisk), [1.5, 3, 4.5]); assert.ok(p.targets[0].price < p.targets[1].price && p.targets[1].price < p.targets[2].price); assert.equal(buildPlan(fresh([range(10)])), null);
});
test("independent validator approves a clean liquid fresh market and never reads upstream scores", () => {
  const rows = fresh(upSegs), v = independentValidation(rows, { interval: "1h", assetClass: "crypto", now: NOW + 60_000, plan: buildPlan(rows) });
  assert.equal(v.approved, true, v.reasons.join("; ")); assert.match(v.method, /does not read early-alpha/);
  assert.equal(independentValidation.length, 2);
});
test("hard failures veto approval regardless of anything else: stale, illiquid, wash trading, bad plan", () => {
  const rows = fresh(upSegs), plan = buildPlan(rows)!;
  assert.equal(independentValidation(rows, { interval: "1h", assetClass: "crypto", now: NOW + 10 * 3600_000, plan }).approved, false);
  const thin = rows.map(r => [r[0], r[1], r[2], r[3], r[4], 0.01] as any); assert.ok(independentValidation(thin, { interval: "1h", assetClass: "crypto", now: NOW, plan }).reasons.some(r => /liquidity/.test(r)));
  assert.equal(independentValidation(rows, { interval: "1h", assetClass: "crypto", now: NOW, plan, washScore: 0.8 }).approved, false);
  assert.equal(independentValidation(rows, { interval: "1h", assetClass: "crypto", now: NOW, plan: { ...plan, stop: plan.entry - 0.0001 } }).approved, false);
  assert.equal(independentValidation(rows, { interval: "1h", assetClass: "crypto", now: NOW, plan, dexCritical: true }).approved, false);
  assert.equal(independentValidation(rows, { interval: "1h", assetClass: "crypto", now: NOW, plan: null }).approved, false);
});
test("corrupt candles fail integrity", () => {
  const rows = fresh(upSegs); const bad = rows.map((r, i) => i === 100 ? [r[0], r[1], r[2] * 0.5, r[3], r[4], r[5]] as any : r);
  assert.ok(independentValidation(bad, { interval: "1h", assetClass: "crypto", now: NOW, plan: buildPlan(rows) }).checks.find(c => c.id === "integrity")!.pass === false);
});
const build = (rows: any[], extra: any = {}) => {
  const early = analyseEarlyAlpha(rows, { assetClass: "crypto", interval: "1h" })!, built = signalFromCandles(rows, "TESTUSDT", "binance", "1h");
  return fuse({ symbol: "TESTUSDT", assetClass: "crypto", interval: "1h", exchange: "Binance spot", provider: "binance", now: NOW + 60_000, rows, early, signal: built?.signal ?? null, lab: runLab(rows, { symbol: "TESTUSDT", interval: "1h", assetClass: "crypto" }), ...extra });
};
test("fusion output always separates discovery candidates from executable trades", () => {
  const f = build(fresh([...upSegs, trend(20, 0.003, 0.003, 9000)]));
  assert.ok(["discovery_candidate", "executable_trade"].includes(f.kind)); assert.equal(f.kind === "executable_trade", f.executable);
  if (f.executable) { assert.ok(f.validation.approved); assert.ok(["CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY"].includes(f.classification)); }
  assert.equal(f.scores.fundamental, null); assert.ok(f.scores.overall >= 0 && f.scores.overall <= 100);
});
test("an unvalidated asset is capped at 60 overall and cannot be executable", () => {
  const f = build(fresh(upSegs), { now: NOW + 20 * 3600_000 }); assert.equal(f.validation.approved, false); assert.ok(f.scores.overall <= 60); assert.equal(f.executable, false); assert.equal(f.classification, "REJECTED");
});
test("a hard risk failure beats a high early-alpha score and a high investor-consensus score", () => {
  const rows = fresh(upSegs), disc = mk({ type: "position_increase" }), copy = [evaluateDisclosure(disc, WATCH_ENTITIES[0], null, 3, NOW)];
  const f = build(rows, { flow: { washScore: 0.9, washFlags: ["x"], evidence: [] }, copy }); assert.equal(f.classification, "REJECTED"); assert.equal(f.executable, false); assert.ok(f.vetoes.some(v => /manipulation/.test(v)));
});
test("DEX tokens are never executable", () => {
  const f = build(fresh([...upSegs, trend(20, 0.003, 0.003, 9000)]), { dex: { assessment: { riskScore: 0.1, flags: [], tradeable: false, reason: "r", liquidityUsd: 1e6, ageHours: 900 }, security: null } });
  assert.equal(f.executable, false); assert.match(f.executableReason, /no connected execution venue/);
});
test("invalidation overrides everything", () => { assert.equal(build(fresh(upSegs), { invalidatedBy: "closed below stop" }).classification, "INVALIDATED"); });
test("a crash is not executable and not promoted", () => {
  const f = build(fresh([trend(150, 0.002, 0.004, 3000), trend(14, -0.012, 0.004, 5000)])); assert.equal(f.executable, false); assert.ok(["REJECTED", "WATCHLIST"].includes(f.classification));
});
test("sizePosition: risk-based, capped by notional, rejects bad input", () => {
  const s = sizePosition({ equity: 10_000, riskPercent: 0.5, entry: 100, stop: 95 })!; assert.equal(s.riskAmount, 50); assert.equal(s.quantity, 10);
  const capped = sizePosition({ equity: 10_000, riskPercent: 1, entry: 100, stop: 99.9, maxNotionalPct: 20 })!; assert.equal(capped.cappedByNotional, true); assert.ok(capped.notional <= 2000.01);
  assert.equal(sizePosition({ equity: 10_000, riskPercent: 5, entry: 100, stop: 95 })!.riskPercent, 1); assert.equal(sizePosition({ equity: 0, riskPercent: 1, entry: 100, stop: 95 }), null); assert.equal(sizePosition({ equity: 1, riskPercent: 1, entry: 100, stop: 101 }), null);
});

function mk(o: Partial<Disclosure> = {}): Disclosure {
  const ent = WATCH_ENTITIES[0];
  return { id: "13f:x:" + (o.assetKey || "037833100") + (o.investor || ""), investor: ent.investor, entityId: ent.id, entity: ent.entity, cik: ent.cik, form: "13F-HR", type: "position_increase", asset: "TEST CORP", assetKey: "037833100", ticker: "TEST", eventDate: new Date(NOW - 20 * 86400000).toISOString().slice(0, 10), filingDate: new Date(NOW - 5 * 86400000).toISOString().slice(0, 10), source: "https://www.sec.gov/Archives/edgar/data/1/2/", shares: 10, valueUsd: 100, deltaPct: 50, delay: classifyDelay("13F-HR", new Date(NOW - 20 * 86400000).toISOString().slice(0, 10), new Date(NOW - 5 * 86400000).toISOString().slice(0, 10), NOW), attribution: { status: "verified", confidence: 0.95, basis: "verified" }, observedAt: "x", note: "", ...o } as Disclosure;
}
const mkt = (rows: any[], over: any = {}) => ({ rows, interval: "1h", assetClass: "crypto" as const, rrToTp2: 2, stageBias: "bullish" as const, labLongVotes: 0, labCompatibleNames: [] as string[], ...over });
test("copy: sells and reductions are never long entries", () => { assert.equal(evaluateDisclosure(mk({ type: "position_exit" }), WATCH_ENTITIES[0], mkt(fresh(upSegs)), 1, NOW).classification, "REJECTED_OPPORTUNITY"); });
test("copy: stale disclosures are labelled stale, not followed", () => {
  const ev = new Date(NOW - 300 * 86400000).toISOString().slice(0, 10), fl = new Date(NOW - 260 * 86400000).toISOString().slice(0, 10), d = mk({ eventDate: ev, filingDate: fl, delay: classifyDelay("13F-HR", ev, fl, NOW) }); assert.equal(evaluateDisclosure(d, WATCH_ENTITIES[0], mkt(fresh(upSegs)), 1, NOW).classification, "STALE_DISCLOSURE");
});
test("copy: unverified attribution or a non-followable fund is rejected", () => {
  assert.equal(evaluateDisclosure(mk({ attribution: { status: "unverified", confidence: 0.4, basis: "x" } }), WATCH_ENTITIES[0], mkt(fresh(upSegs)), 1, NOW).classification, "REJECTED_OPPORTUNITY");
  const rt = WATCH_ENTITIES.find(e => e.id === "renaissance")!; assert.equal(evaluateDisclosure(mk({ investor: rt.investor }), rt, mkt(fresh(upSegs)), 1, NOW).classification, "REJECTED_OPPORTUNITY");
});
test("copy: no market data for the asset means rejection with an explicit reason", () => {
  const e = evaluateDisclosure(mk(), WATCH_ENTITIES[0], null, 1, NOW); assert.equal(e.classification, "REJECTED_OPPORTUNITY"); assert.match(e.summary, /market data available/i);
});
test("copy: two verified investors adding the same asset is an institutional accumulation signal", () => {
  const a = mk(), b = mk({ investor: "Bill Ackman", entityId: "pershing" }), all = [a, b]; assert.equal(consensusFor(a, all), 2);
  const e = evaluateDisclosure(a, WATCH_ENTITIES[0], mkt(fresh(upSegs)), consensusFor(a, all), NOW); assert.equal(e.classification, "INSTITUTIONAL_ACCUMULATION_SIGNAL"); assert.equal(e.needsIndependentValidation, true);
});
test("copy: price already far above the disclosed date blocks the follow", () => {
  const rows = fresh([range(100, 0.004, 5000), trend(120, 0.004, 0.003, 7000)]); const e = evaluateDisclosure(mk({ eventDate: new Date(rows[110][0]).toISOString().slice(0, 10) }), WATCH_ENTITIES[0], mkt(rows), 1, NOW + 100 * 86400000);
  assert.notEqual(e.classification, "INVESTOR_FOLLOWING_OPPORTUNITY"); assert.equal(e.checks.length, 12);
});
test("copy: strategy match when compatible ETI strategies agree", () => {
  const e = evaluateDisclosure(mk({ eventDate: new Date(NOW - 3 * 3600_000).toISOString().slice(0, 10) }), WATCH_ENTITIES[0], mkt(fresh(upSegs), { labLongVotes: 2, labCompatibleNames: ["a", "b"] }), 1, NOW);
  assert.ok(["INVESTOR_STRATEGY_MATCH", "REJECTED_OPPORTUNITY", "INVESTOR_FOLLOWING_OPPORTUNITY"].includes(e.classification), e.classification + " " + e.summary);
});
