import test from "node:test";
import assert from "node:assert/strict";
import { calibration, computeReport, maxDrawdown, reportsByEngine, wilson, windowedReports, type ClosedTrade } from "./algo/performance.ts";
import { KVPaperStore, MemoryPaperStore, PaperEngine } from "./algo/paper.ts";
import { runOmnisignal, type OmnisignalResult } from "./algo/omnisignal.ts";
import { series } from "./algo/fixtures.ts";
import { TF_SECONDS, TIMEFRAMES } from "./algo/timeframes.ts";
import type { FusionContext } from "./algo/engine.ts";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const trade = (i: number, pnl: number, o: Partial<ClosedTrade> = {}): ClosedTrade => ({ id: "t" + i, engine: "combined", symbol: "BTCUSDT", openedAt: NOW - 1000 * (100 - i), closedAt: NOW - 1000 * (99 - i), pnl, riskAmount: 50, fees: 1, slippage: 0.5, ...o });

// ---------- performance metrics ----------
test("report matches hand-computed profit factor, expectancy, win rate and R", () => {
  const trades = Array.from({ length: 40 }, (_, i) => trade(i, i % 5 < 3 ? 100 : -50)); // 24 wins +100, 16 losses -50
  const r = computeReport(trades);
  assert.equal(r.status, "ok"); assert.equal(r.trades, 40); assert.equal(r.wins, 24); assert.equal(r.losses, 16);
  assert.equal(r.winRate, 0.6); assert.equal(r.profitFactor, 3); assert.equal(r.expectancy, 40); assert.equal(r.netPnl, 1600);
  assert.ok(Math.abs(r.expectancyR! - 0.8) < 1e-12); assert.equal(r.avgRewardRisk, 2); assert.equal(r.maxConsecutiveLosses, 2);
  assert.ok(r.winRateInterval95!.low < 0.6 && r.winRateInterval95!.high > 0.6); assert.equal(r.totalFees, 40);
});
test("small samples withhold rates and ratios instead of presenting them as reliable", () => {
  const r = computeReport([trade(1, 100), trade(2, 100), trade(3, -50)]);
  assert.equal(r.status, "insufficient_sample"); assert.equal(r.winRate, null); assert.equal(r.profitFactor, null); assert.equal(r.expectancy, null); assert.equal(r.sharpe, null); assert.match(r.note, /withheld/);
  assert.ok(r.winRateInterval95 !== null, "uncertainty is still disclosed");
});
test("max drawdown is peak-to-trough on the equity curve", () => {
  const d = maxDrawdown([100, 120, 90, 130, 100]);
  assert.equal(d.maxDrawdown, 30); assert.ok(Math.abs(d.maxDrawdownPct - 0.25) < 1e-12);
  assert.deepEqual(maxDrawdown([100, 110, 120]), { maxDrawdown: 0, maxDrawdownPct: 0 });
});
test("Wilson interval is sane and widens for smaller samples", () => {
  assert.equal(wilson(0, 0), null);
  const small = wilson(6, 10)!, large = wilson(600, 1000)!;
  assert.ok(small.high - small.low > large.high - large.low); assert.ok(large.low < 0.6 && large.high > 0.6);
  const all = wilson(10, 10)!; assert.ok(all.high <= 1 && all.low > 0.5 && all.low < 1);
});
test("rolling windows and per-engine splits include only the right trades", () => {
  const DAY = 86_400_000, old = Array.from({ length: 35 }, (_, i) => trade(i, 10, { closedAt: NOW - 40 * DAY - i, engine: "swift" }));
  const fresh = Array.from({ length: 35 }, (_, i) => trade(100 + i, -10, { closedAt: NOW - 3600_000 - i, engine: "gainz" }));
  const w = windowedReports([...old, ...fresh], NOW);
  assert.equal(w["24h"].trades, 35); assert.equal(w["7d"].trades, 35); assert.equal(w["30d"].trades, 35); assert.equal(w["90d"].trades, 70); assert.equal(w.all.trades, 70);
  const by = reportsByEngine([...old, ...fresh]); assert.equal(by.swift.netPnl, 350); assert.equal(by.gainz.netPnl, -350);
});
test("calibration flags confidence that does not match realised outcomes", () => {
  const over = Array.from({ length: 24 }, (_, i) => trade(i, 100, { confidence: 75 })).concat(Array.from({ length: 12 }, (_, i) => trade(50 + i, -50, { confidence: 55 })));
  const c = calibration(over);
  assert.equal(c.calibrated, false); assert.ok(c.buckets.some(b => b.gap !== null && Math.abs(b.gap) > 0.1));
  const sparse = calibration([trade(1, 10, { confidence: 90 })]); assert.equal(sparse.calibrated, false); assert.match(sparse.note, /uncalibrated|Not enough/);
});

// ---------- paper execution ----------
function buyPlan(seed = 1): OmnisignalResult {
  const ctx: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: Object.fromEntries(TIMEFRAMES.map(tf => [tf, series(300, { drift: 0.25, noise: 0.35, seed, stepMs: TF_SECONDS[tf] * 1000, end: NOW - 1000 })])) as FusionContext["candles"] };
  const r = runOmnisignal(ctx, { roundTripCostBps: 0 }); assert.equal(r.decision, "BUY", "fixture must yield a real BUY through engines, fusion and validation"); return r;
}
const mid = (p: OmnisignalResult) => (p.entryZone![0] + p.entryZone![1]) / 2;
const mk = async (cfg = {}, store = new MemoryPaperStore()) => ({ store, eng: await PaperEngine.create(store, cfg, NOW) });
const bar = (p: { entry: number }, o: Partial<{ ts: number; high: number; low: number; close: number }> = {}) => ({ ts: NOW + 60_000, high: p.entry, low: p.entry, close: p.entry, ...o });

test("opening runs the in-process safeguards, charges fees and records an audit trail", async () => {
  const plan = buyPlan(), { eng, store } = await mk();
  const ev = await eng.open(plan, mid(plan), NOW);
  assert.equal(ev.type, "OPENED");
  const p = eng.state.positions[0]; assert.ok(p.qty > 0 && p.stop < p.entry && p.entry >= mid(plan)); assert.ok(eng.state.equity < 10_000, "entry fee deducted");
  assert.ok(p.riskAmount * 1.0001 >= eng.state.equity * 0 && Math.abs(p.riskAmount - eng.state.equity * 0.005) < eng.state.equity * 0.0051 + 1);
  const opened = store.log.find(e => e.type === "OPENED")!; assert.ok(Array.isArray((opened.detail as any).reasoning), "decision trail persisted"); assert.equal((opened.detail as any).safeguards, "in_process"); assert.equal((opened.detail as any).freeCashBefore, 10_000);
});
test("in-process safeguards refuse an order that is too large, unaffordable or malformed, and nothing is opened or reserved", async () => {
  const plan = buyPlan();
  const probe = (await mk()).eng, qty = (await (async () => { await probe.open(plan, mid(plan), NOW); return probe.state.positions[0].qty; })());
  const capped = await mk({ maxOrderQuantity: qty / 2 }), ev = await capped.eng.open(plan, mid(plan), NOW);
  assert.equal(ev.type, "REJECTED"); assert.match(ev.reasons![0], /maximum order quantity/); assert.equal(capped.eng.state.positions.length, 0); assert.equal(capped.eng.state.orderIds.length, 0);
  assert.ok(capped.store.log.some(e => e.type === "REJECTED"), "refusal is audited");
  const okCap = await mk({ maxOrderQuantity: qty * 2 }); assert.equal((await okCap.eng.open(plan, mid(plan), NOW)).type, "OPENED");
  const poor = await mk({ startingEquity: 10_000, maxNotionalFraction: 1 }); poor.eng.state.positions.push({ ...probe.state.positions[0], symbol: "HELDUSDT", clientOrderId: "held", remainingQty: 1, entry: 9_990 });
  const broke = await poor.eng.open(plan, mid(plan), NOW); assert.equal(broke.type, "REJECTED"); assert.match(broke.reasons![0], /Insufficient simulated balance/); assert.equal(poor.eng.state.positions.length, 1);
  const bad = await (await mk()).eng.open({ ...plan, stopLoss: NaN as any }, mid(plan), NOW); assert.equal(bad.type, "REJECTED");
});
test("duplicate orders are not resubmitted, including after a restart", async () => {
  const plan = buyPlan(), { eng, store } = await mk();
  assert.equal((await eng.open(plan, mid(plan), NOW)).type, "OPENED");
  assert.equal((await eng.open(plan, mid(plan), NOW + 1)).type, "DUPLICATE"); assert.equal(eng.state.positions.length, 1); assert.equal(eng.state.orderIds.length, 1);
  const restarted = await PaperEngine.create(store, {}, NOW + 5000);
  assert.equal(restarted.state.positions.length, 1, "open position recovered from the store");
  assert.equal((await restarted.open(plan, mid(plan), NOW + 6000)).type, "DUPLICATE"); assert.equal(restarted.state.orderIds.length, 1);
});
test("kill switch, non-trade decisions, expired signals and bad prices all block new orders", async () => {
  const plan = buyPlan(), { eng } = await mk();
  await eng.setKillSwitch(true); assert.equal((await eng.open(plan, mid(plan), NOW)).type, "REJECTED"); await eng.setKillSwitch(false);
  assert.equal((await eng.open({ ...plan, decision: "HOLD" }, mid(plan), NOW)).type, "REJECTED");
  assert.equal((await eng.open({ ...plan, decision: "DATA_UNRELIABLE" }, mid(plan), NOW)).type, "REJECTED");
  assert.equal((await eng.open(plan, mid(plan), Date.parse(plan.expiresAt!) + 1)).type, "REJECTED");
  assert.equal((await eng.open(plan, NaN, NOW)).type, "REJECTED");
  assert.equal((await eng.open(plan, plan.entryZone![1] * 1.02, NOW)).type, "REJECTED", "price far outside the entry zone does not fill");
  assert.equal(eng.state.positions.length, 0);
});
test("one position per symbol, a position cap, and no stacking", async () => {
  const plan = buyPlan(), other = { ...plan, symbol: "OTHERUSDT" }, { eng } = await mk({ maxOpenPositions: 1 });
  assert.equal((await eng.open(plan, mid(plan), NOW)).type, "OPENED");
  const again = await eng.open({ ...plan, generatedAt: new Date(NOW + 1).toISOString() }, mid(plan), NOW + 1); assert.equal(again.type, "REJECTED"); assert.match(again.reasons![0], /already open/);
  const capped = await eng.open(other, mid(plan), NOW + 2); assert.equal(capped.type, "REJECTED"); assert.match(capped.reasons![0], /Max open positions/);
});
test("stop-loss closes the whole position at a loss and blocks immediate re-entry", async () => {
  const plan = buyPlan(), { eng } = await mk(), before = eng.state.equity;
  await eng.open(plan, mid(plan), NOW); const p = eng.state.positions[0], stop = p.stop;
  const ev = await eng.onBar(plan.symbol, bar(p, { low: stop - 0.01, high: p.entry }));
  assert.deepEqual(ev.map(e => e.type), ["STOP", "CLOSED"]); assert.equal(eng.state.positions.length, 0); assert.ok(eng.state.closed[0].pnl < 0); assert.ok(eng.state.equity < before);
  const re = await eng.open({ ...plan, generatedAt: new Date(NOW + 120_000).toISOString(), expiresAt: new Date(NOW + 9e6).toISOString() }, mid(plan), NOW + 120_000);
  assert.equal(re.type, "REJECTED"); assert.match(re.reasons![0], /cooldown/);
});
test("stop-first rule: a bar touching both stop and TP1 is a stop-out", async () => {
  const plan = buyPlan(), { eng } = await mk(); await eng.open(plan, mid(plan), NOW); const p = eng.state.positions[0];
  const ev = await eng.onBar(plan.symbol, bar(p, { low: p.stop - 0.01, high: p.targets[0].price + 1 }));
  assert.ok(ev.some(e => e.type === "STOP")); assert.ok(!ev.some(e => e.type === "TP1"));
});
test("TP1 books a partial, moves the stop to break-even, and the stop never loosens afterwards", async () => {
  const plan = buyPlan(), { eng } = await mk(); await eng.open(plan, mid(plan), NOW); const p = eng.state.positions[0], init = p.stop, qty = p.qty;
  const ev = await eng.onBar(plan.symbol, bar(p, { high: p.targets[0].price + 0.001, low: p.entry }));
  assert.deepEqual(ev.map(e => e.type), ["TP1", "BREAKEVEN"]);
  assert.ok(Math.abs(p.remainingQty - qty * 0.6) < 1e-9); assert.ok(p.stop >= p.entry && p.stop > init);
  let last = p.stop;
  for (const high of [p.entry + 0.1, p.targets[1].price + 0.001, p.entry, p.entry - 0.05]) { await eng.onBar(plan.symbol, bar(p, { ts: NOW + 120_000, high, low: Math.max(p.entry, last + 0.001) })); if (eng.state.positions[0]) { assert.ok(eng.state.positions[0].stop >= last, "stop only tightens"); last = eng.state.positions[0].stop; } }
});
test("reaching TP3 closes the trade, books the partials in order, and feeds the performance report", async () => {
  const plan = buyPlan(), { eng } = await mk(); await eng.open(plan, mid(plan), NOW); const p = eng.state.positions[0], risk = p.riskAmount;
  const ev = await eng.onBar(plan.symbol, bar(p, { high: p.targets[2].price + 1, low: p.entry }));
  assert.deepEqual(ev.map(e => e.type), ["TP1", "TP2", "TP3", "CLOSED"]); assert.equal(eng.state.positions.length, 0);
  const t = eng.state.closed[0]; assert.ok(t.pnl > 0 && t.fees > 0 && t.slippage > 0); assert.equal(t.riskAmount, risk); assert.equal(t.engine === "combined" || t.engine === "swift" || t.engine === "gainz", true);
  const rep = computeReport(eng.state.closed); assert.equal(rep.trades, 1); assert.equal(rep.status, "insufficient_sample"); assert.equal(rep.winRate, null);
});
test("daily loss limit and consecutive-loss protection pause new entries", async () => {
  const plan = buyPlan(), b = { ...plan, symbol: "BBBUSDT" }, c = { ...plan, symbol: "CCCUSDT" };
  const { eng } = await mk({ maxDailyLossPct: 0.0001, maxOpenPositions: 5 });
  await eng.open(plan, mid(plan), NOW); await eng.onBar(plan.symbol, bar(eng.state.positions[0], { low: eng.state.positions[0].stop - 1 }));
  const r = await eng.open(b, mid(plan), NOW + 10); assert.equal(r.type, "REJECTED"); assert.match(r.reasons![0], /Daily loss limit/);
  const { eng: e2 } = await mk({ maxConsecutiveLosses: 1, maxDailyLossPct: 50, maxOpenPositions: 5 });
  await e2.open(plan, mid(plan), NOW); await e2.onBar(plan.symbol, bar(e2.state.positions[0], { low: e2.state.positions[0].stop - 1 }));
  const r2 = await e2.open(c, mid(plan), NOW + 10); assert.equal(r2.type, "REJECTED"); assert.match(r2.reasons![0], /consecutive losses/);
});
test("a store failure surfaces instead of silently losing state", async () => {
  const plan = buyPlan(), store = new MemoryPaperStore(); store.save = async () => { throw new Error("db down"); };
  const eng = await PaperEngine.create(store, {}, NOW);
  await assert.rejects(() => eng.open(plan, mid(plan), NOW), /db down/);
});
test("KV-backed store round-trips state and writes TTL'd audit entries", async () => {
  const data = new Map<string, { v: string; ttl?: number }>();
  const kv = { get: async (k: string) => data.get(k)?.v ?? null, put: async (k: string, v: string, o?: { expirationTtl?: number }) => { data.set(k, { v, ttl: o?.expirationTtl }); } };
  const plan = buyPlan(), s1 = new KVPaperStore(kv), e1 = await PaperEngine.create(s1, {}, NOW);
  await e1.open(plan, mid(plan), NOW);
  const e2 = await PaperEngine.create(new KVPaperStore(kv), {}, NOW + 1000);
  assert.equal(e2.state.positions.length, 1); assert.equal(e2.state.orderIds.length, 1);
  const audits = [...data.entries()].filter(([k]) => k.includes(":audit:")); assert.ok(audits.length >= 1 && audits.every(([, x]) => x.ttl === 90 * 86400));
});

test("the consecutive-loss pause expires, and a further loss re-triggers it", async () => {
  const plan = buyPlan(), PAUSE = 3_600_000, { eng } = await mk({ maxConsecutiveLosses: 1, maxDailyLossPct: 50, reentryCooldownMs: 0, lossPauseMs: PAUSE });
  await eng.open(plan, mid(plan), NOW); const t1 = NOW + 60_000;
  await eng.onBar(plan.symbol, { ts: t1, high: eng.state.positions[0].entry, low: eng.state.positions[0].stop - 1, close: 1 });
  const fresh = (ts: number): OmnisignalResult => ({ ...plan, generatedAt: new Date(ts).toISOString(), expiresAt: new Date(ts + 9e6).toISOString() });
  const blocked = await eng.open(fresh(t1 + 1000), mid(plan), t1 + 1000); assert.equal(blocked.type, "REJECTED"); assert.match(blocked.reasons![0], /paused until/);
  const resumed = await eng.open(fresh(t1 + PAUSE + 1000), mid(plan), t1 + PAUSE + 1000); assert.equal(resumed.type, "OPENED", "entries resume once the pause has elapsed");
  const t2 = t1 + PAUSE + 60_000; await eng.onBar(plan.symbol, { ts: t2, high: eng.state.positions[0].entry, low: eng.state.positions[0].stop - 1, close: 1 });
  const again = await eng.open(fresh(t2 + 1000), mid(plan), t2 + 1000); assert.equal(again.type, "REJECTED"); assert.match(again.reasons![0], /paused until/);
});
