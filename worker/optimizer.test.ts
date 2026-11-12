import test from "node:test";
import assert from "node:assert/strict";
import { CANDIDATES, CANDIDATE_SET, TIGHTENINGS, candidateAllowed, tightenAllowed, MemoryParamStore, ParamRegistry, autoRollbackIfDegraded, decidePromotion, makeWeights, rollbackCheck, sliceHistory, walkForward, weightsAllowed, type OptimizerResult, type Pooled } from "./algo/optimizer.ts";
import { DEFAULT_VALIDATION_WEIGHTS } from "./algo/validation.ts";
import { aggregate, type History } from "./algo/replay.ts";
import { regimeSeries } from "./algo/fixtures.ts";
import type { ClosedTrade } from "./algo/performance.ts";

const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
test("weight profiles are bounded, keep the total and pin data integrity", () => {
  for (const [n, w] of Object.entries(CANDIDATES)) { assert.equal(weightsAllowed(w), null, n); assert.ok(Math.abs(sum(w) - sum(DEFAULT_VALIDATION_WEIGHTS)) < 0.5, n); assert.equal(w.dataIntegrity, DEFAULT_VALIDATION_WEIGHTS.dataIntegrity); assert.ok(w.riskReward >= 10); }
  const extreme = makeWeights({ technical: 50, volume: 0.001, riskReward: 0.01 });
  assert.equal(weightsAllowed(extreme), null); assert.ok(extreme.riskReward >= 10 && extreme.technical <= 40);
});
test("disallowed weights are rejected", () => {
  assert.match(weightsAllowed({ ...DEFAULT_VALIDATION_WEIGHTS, dataIntegrity: 0 })!, /pinned/);
  assert.match(weightsAllowed({ ...DEFAULT_VALIDATION_WEIGHTS, technical: 90 })!, /bounds|total/);
  assert.ok(weightsAllowed({ ...DEFAULT_VALIDATION_WEIGHTS, killSwitch: 1 } as any));
  assert.ok(weightsAllowed({ ...DEFAULT_VALIDATION_WEIGHTS, riskReward: NaN }));
});

const mk = (meanR: number, trades: number, low95: number | null, dd = 0.05): Pooled => ({ trades, meanR, bootstrap: low95 === null ? null : { meanR, low95, high95: meanR + 1, samples: trades }, report: { maxDrawdownPct: dd } as any });
const gates = { minOosTrades: 30, marginR: 0.1, candidatesTried: 5 };
test("promotion gates: each failing gate blocks promotion; all passing only recommends", () => {
  const ok = decidePromotion(mk(0.4, 40, 0.1), mk(0.1, 40, 0), 0.75, gates);
  assert.equal(ok.decision, "RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL"); assert.equal(ok.autoApplied, false);
  const fails: [string, ReturnType<typeof decidePromotion>][] = [
    ["few trades", decidePromotion(mk(0.4, 10, 0.1), mk(0.1, 40, 0), 0.75, gates)],
    ["champion few trades", decidePromotion(mk(0.4, 40, 0.1), mk(0.1, 5, 0), 0.75, gates)],
    ["small margin", decidePromotion(mk(0.15, 40, 0.1), mk(0.1, 40, 0), 0.75, gates)],
    ["interval spans zero", decidePromotion(mk(0.4, 40, -0.05), mk(0.1, 40, 0), 0.75, gates)],
    ["no bootstrap", decidePromotion(mk(0.4, 40, null), mk(0.1, 40, 0), 0.75, gates)],
    ["worse drawdown", decidePromotion(mk(0.4, 40, 0.1, 0.2), mk(0.1, 40, 0, 0.05), 0.75, gates)],
    ["unstable", decidePromotion(mk(0.4, 40, 0.1), mk(0.1, 40, 0), 0.25, gates)],
  ];
  for (const [n, d] of fails) assert.equal(d.decision, "KEEP_CHAMPION", n);
});

const T0 = Date.UTC(2026, 0, 1), M15 = 900_000;
const hist = (): History => { const base = regimeSeries(1100, { seed: 5, stepMs: M15, end: T0 + 1100 * M15 }); return { "15m": base, "30m": aggregate(base, 1_800_000, M15), "1h": aggregate(base, 3_600_000, M15), "4h": aggregate(base, 14_400_000, M15) }; };
test("sliceHistory never exposes candles beyond the cut", () => {
  const h = hist(), s = sliceHistory(h, "intraday", 0, 500), cut = h["15m"]![499][0] + M15;
  assert.equal(s["15m"]!.length, 500); for (const tf of ["30m", "1h", "4h"] as const) assert.ok(s[tf]!.every(c => c[0] <= cut));
});
test("walk-forward runs, never auto-applies, and OOS trades open after the training boundary", async () => {
  const r = await walkForward(hist(), { folds: 3, minTrainTrades: 1, replay: { symbol: "TESTUSDT", strategy: "intraday", stepBars: 6 } });
  assert.equal(r.folds.length, 3); assert.equal(r.candidatesTried, 7); assert.equal(r.promotion.autoApplied, false);
  assert.ok(r.caveats.length >= 4);
  assert.equal(r.promotion.decision, "KEEP_CHAMPION"); // far too few trades on a small synthetic sample to clear the gates
});
test("walk-forward refuses bad input", async () => {
  await assert.rejects(walkForward({ "15m": hist()["15m"]!.slice(0, 200) }, { replay: { symbol: "X", strategy: "intraday" } }), /at least/);
  await assert.rejects(walkForward(hist(), { replay: { symbol: "X", strategy: "intraday" }, candidates: { default: DEFAULT_VALIDATION_WEIGHTS, bad: { ...DEFAULT_VALIDATION_WEIGHTS, dataIntegrity: 0 } } }), /rejected/);
  await assert.rejects(walkForward(hist(), { replay: { symbol: "X", strategy: "intraday" }, candidates: { other: DEFAULT_VALIDATION_WEIGHTS } }), /default/);
});

const rec = (name: string, w = CANDIDATES.trend_heavy): OptimizerResult => ({ symbol: "X", strategy: "intraday", folds: [], challenger: { name, weights: w, selectionStability: 1 }, oosChallenger: mk(0.4, 40, 0.1), oosChampion: mk(0.1, 40, 0), candidatesTried: 5, promotion: { decision: "RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL", reasons: [], autoApplied: false }, caveats: [] });
test("registry: propose needs a recommendation, promote needs a named human, rollback restores the approved config", async () => {
  const store = new MemoryParamStore(); let t = 1000; const reg = await ParamRegistry.open(store, () => t++);
  await assert.rejects(reg.propose("trend_heavy", CANDIDATES.trend_heavy, { ...rec("trend_heavy"), promotion: { decision: "KEEP_CHAMPION", reasons: [], autoApplied: false } }), /did not recommend/);
  await assert.rejects(reg.propose("trend_heavy", { ...CANDIDATES.trend_heavy, dataIntegrity: 0 }, rec("trend_heavy")), /pinned/);
  const v = await reg.propose("trend_heavy", CANDIDATES.trend_heavy, rec("trend_heavy"));
  assert.equal(reg.champion().name, "default"); // proposing changes nothing live
  for (const who of ["", "  ", "AI", "claude", "optimizer", "system-default"]) await assert.rejects(reg.promote(v.id, who), /human/);
  assert.equal(reg.champion().name, "default");
  await reg.promote(v.id, "Kyle"); assert.equal(reg.champion().name, "trend_heavy"); assert.equal(reg.champion().approvedBy, "Kyle");
  const back = await reg.rollback("test"); assert.equal(back.name, "default"); assert.equal(reg.champion().name, "default");
  assert.deepEqual(reg.st.audit.map(a => a.action), ["propose", "promote", "rollback"]);
  assert.equal((await ParamRegistry.open(store)).champion().name, "default"); // persisted
});
test("rollback with nothing to return to fails safely", async () => { const reg = await ParamRegistry.open(new MemoryParamStore()); await assert.rejects(reg.rollback("x"), /No previously approved/); });

const tr = (r: number): ClosedTrade => ({ pnl: r * 100, riskAmount: 100, closedAt: 0, openedAt: 0 } as any);
test("rollbackCheck: withheld on small samples, triggers on degradation, quiet when within tolerance", () => {
  const base = { baselineMeanR: 0.4, baselineMaxDrawdownPct: 0.05 };
  assert.equal(rollbackCheck(base, Array(10).fill(tr(-1))).rollback, false);
  assert.equal(rollbackCheck(base, Array.from({ length: 40 }, (_, i) => tr(i % 2 ? -1 : 0.9))).rollback, true);
  assert.equal(rollbackCheck(base, Array.from({ length: 40 }, (_, i) => tr(i % 3 ? 0.9 : -0.5))).rollback, false);
});
test("autoRollback only reverts to an approved version", async () => {
  const reg = await ParamRegistry.open(new MemoryParamStore()), bad = Array(40).fill(tr(-1));
  assert.equal((await autoRollbackIfDegraded(reg, bad)).applied, false); // default champion, nothing approved before it
  const v = await reg.propose("trend_heavy", CANDIDATES.trend_heavy, rec("trend_heavy")); await reg.promote(v.id, "Kyle");
  const r = await autoRollbackIfDegraded(reg, bad); assert.equal(r.applied, true); assert.equal(reg.champion().name, "default");
});

test("tightenings can only make gates stricter; every shipped candidate is allowed", () => {
  for (const [n, c] of Object.entries(CANDIDATE_SET)) assert.equal(candidateAllowed(c), null, n);
  for (const t of Object.values(TIGHTENINGS)) assert.equal(tightenAllowed(t), null);
  for (const bad of [{ minRiskReward: 1.0 }, { minRiskReward: 9 }, { confirmed: 50 }, { confirmed: 99 }, { maxCostR: 0.5 }, { maxCostR: 0 }, { maxCostR: NaN }, { killSwitch: 1 } as any, { minRiskReward: "2" } as any])
    assert.ok(tightenAllowed(bad), JSON.stringify(bad));
  assert.equal(tightenAllowed(undefined), null);
});
test("tightened candidates change the trade set while re-weighting does not (real-data finding, reproduced on the fixture)", async () => {
  const h = hist(), cfg = { symbol: "TESTUSDT", strategy: "intraday" as const, stepBars: 6, roundTripCostBps: 0 };
  const { replay } = await import("./algo/replay.ts");
  const base = await replay(h, cfg), strict = await replay(h, { ...cfg, thresholds: { minRiskReward: 4, confirmed: 90 } });
  assert.ok(strict.trades.length <= base.trades.length);
  assert.ok(strict.decisions && (strict.decisions.BUY ?? 0) + (strict.decisions.SELL ?? 0) <= (base.decisions.BUY ?? 0) + (base.decisions.SELL ?? 0));
});
test("registry stores tighten-only parameters and rejects loosening", async () => {
  const reg = await ParamRegistry.open(new MemoryParamStore()), r = rec("tight_rr2", CANDIDATES.default);
  await assert.rejects(reg.propose("tight_rr2", CANDIDATES.default, r, { minRiskReward: 1 }), /tighten-only/);
  const v = await reg.propose("tight_rr2", CANDIDATES.default, r, { minRiskReward: 2 }); assert.deepEqual(v.tighten, { minRiskReward: 2 });
});

import { championSince, degradationStep } from "./algo/optimizer.ts";
test("degradationStep: restores the last approved version on degradation, never re-triggers on the old version's trades, and respects the opt-out", async () => {
  const t = { v: 1000 }; const reg = await ParamRegistry.open(new MemoryParamStore(), () => t.v++);
  const v = await reg.propose("trend_heavy", CANDIDATES.trend_heavy, rec("trend_heavy")); await reg.promote(v.id, "Kyle");
  const since = championSince(reg); assert.ok(since > 0);
  const bad = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ ...tr(i % 2 ? -1 : -0.5), closedAt: at + i })) as ClosedTrade[];
  const before = bad(40, 1);                                                    // trades from before the promotion are not this champion's
  assert.equal((await degradationStep(reg, before, 10_000)).checked, 0);
  assert.equal(reg.champion().name, "trend_heavy");
  const mine = bad(40, since + 10);
  const off = await degradationStep(reg, mine, 10_000, false); assert.equal(off.verdict.rollback, true); assert.equal(off.applied, false); assert.equal(reg.champion().name, "trend_heavy");
  t.v = since + 5000;                                                           // the rollback happens after those trades closed
  const on = await degradationStep(reg, mine, 10_000); assert.equal(on.applied, true); assert.equal(on.to, "default"); assert.equal(reg.champion().name, "default");
  const again = await degradationStep(reg, mine, 10_000); assert.equal(again.applied, false, "the restored version is not blamed for the old version's trades"); assert.equal(again.checked, 0);
  assert.ok(reg.st.audit.some(a => a.action === "rollback"));
});
test("degradationStep: nothing happens when the champion is fine or on small samples", async () => {
  const reg = await ParamRegistry.open(new MemoryParamStore(), () => 5);
  const good = Array.from({ length: 40 }, (_, i) => ({ ...tr(0.5), closedAt: i })) as ClosedTrade[];
  assert.equal((await degradationStep(reg, good, 10_000)).applied, false);
  assert.equal((await degradationStep(reg, good.slice(0, 5).map(x => ({ ...x, pnl: -100 })), 10_000)).applied, false);
});
