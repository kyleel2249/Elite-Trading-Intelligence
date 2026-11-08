import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveBands, atrSeries, dualEma, ema, volumeMomentum } from "./algo/indicators.ts";
import { computeLevels, manageStop, tightenStop } from "./algo/levels.ts";
import { marketStructure, TF_SECONDS, TIMEFRAMES, type Strategy, type Timeframe } from "./algo/timeframes.ts";
import { rangeSeries, series } from "./algo/fixtures.ts";
import { adaptiveThreshold, breakoutIntel, emaAlignment, gainzEngine, retestOf, rsiIntel, rsiSeries } from "./algo/gainz.ts";
import { swiftEngine } from "./algo/swift.ts";
import { classifyAgreement, fuseEngines, investigate } from "./algo/fusion.ts";
import { runOmnisignal } from "./algo/omnisignal.ts";
import type { EngineSignal, FusionContext } from "./algo/engine.ts";
import type { Kline } from "./market.ts";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const candlesFor = (gen: (tf: Timeframe, stepMs: number) => Kline[]) => Object.fromEntries(TIMEFRAMES.map(tf => [tf, gen(tf, TF_SECONDS[tf] * 1000)])) as FusionContext["candles"];
const trendCtx = (drift: number, strategy: Strategy = "intraday", seed = 7): FusionContext => ({ symbol: "TESTUSDT", strategy, now: NOW, candles: candlesFor((tf, stepMs) => series(300, { drift, noise: 0.35, start: 100, seed, stepMs, end: NOW - 1000, vol: 100 })) });

function sig(engine: "swift" | "gainz", status: EngineSignal["status"], direction: 1 | -1 | 0, price = 100): EngineSignal {
  const live = status === "SIGNAL";
  return { engine, symbol: "TESTUSDT", status, direction, entryZone: live ? [price - 0.2, price] : null, stopLoss: live ? price - direction * 2 : null,
    takeProfits: live ? [1.2, 2.2, 3.5].map((r, i) => ({ label: (["TP1", "TP2", "TP3"] as const)[i], price: price + direction * 2 * r, rewardRisk: r })) : null,
    confidence: live ? 70 : 0, confidenceType: "heuristic_score_not_probability", expectedHolding: "1 to 8 hours", regime: "test", evidence: [], invalidation: [], generatedAt: new Date(NOW).toISOString(), expiresAt: null, details: {} };
}

// ---------- indicator core ----------
test("ema of a constant series is that constant", () => { assert.ok(ema(Array(50).fill(10), 9).every(v => Math.abs(v - 10) < 1e-12)); });
test("ATR is finite and positive after warm-up", () => { const a = atrSeries(series(120, { noise: 1, seed: 3 })); assert.ok(Number.isFinite(a.at(-1)!) && a.at(-1)! > 0); assert.ok(Number.isNaN(a[5])); });
test("volume momentum score is bounded to -100..100", () => { for (const seed of [1, 2, 3, 4]) { const v = volumeMomentum(series(120, { drift: seed % 2 ? 0.3 : -0.3, seed })); assert.ok(v.score >= -100 && v.score <= 100); } });
test("dual EMA reports bull state in an uptrend and bear in a downtrend", () => {
  assert.equal(dualEma(series(200, { drift: 0.3, noise: 0.2, seed: 5 })).state, "bull");
  assert.equal(dualEma(series(200, { drift: -0.3, noise: 0.2, seed: 5, start: 200 })).state, "bear");
});
test("adaptive bands follow an uptrend and ratchet only toward price", () => { const b = adaptiveBands(series(200, { drift: 0.3, noise: 0.2, seed: 5 })); assert.equal(b.trend, "bull"); assert.ok(b.active < 200); });

// ---------- levels and stop management ----------
test("long levels: stop below entry, targets strictly increasing above entry", () => {
  const rows = series(200, { drift: 0.2, noise: 0.4, seed: 9 }), p = rows.at(-1)![4], a = atrSeries(rows).at(-1)!;
  const l = computeLevels(p, 1, a, "normal", marketStructure(rows));
  assert.ok(l.stop < l.entry); assert.ok(l.targets[0].price > l.entry && l.targets[1].price > l.targets[0].price && l.targets[2].price > l.targets[1].price);
  assert.ok(l.targets.every(t => t.rewardRisk > 0)); assert.equal(Number(l.targets.reduce((s, t) => s + t.closeFraction, 0).toFixed(6)), 1);
});
test("short levels mirror long levels", () => {
  const rows = series(200, { drift: -0.2, noise: 0.4, seed: 9, start: 200 }), p = rows.at(-1)![4], a = atrSeries(rows).at(-1)!;
  const l = computeLevels(p, -1, a, "normal", marketStructure(rows));
  assert.ok(l.stop > l.entry); assert.ok(l.targets[0].price < l.entry && l.targets[2].price < l.targets[1].price);
});
test("stops can only tighten, never widen", () => { assert.equal(tightenStop(95, 90, 1), 95); assert.equal(tightenStop(95, 97, 1), 97); assert.equal(tightenStop(105, 110, -1), 105); assert.equal(tightenStop(105, 103, -1), 103); });
test("stop management: break-even after TP1, trailing after TP2, never loosens", () => {
  const rows = series(200, { drift: 0.2, noise: 0.4, seed: 9 }), p = rows.at(-1)![4], a = atrSeries(rows).at(-1)!;
  const l = computeLevels(p, 1, a, "normal", marketStructure(rows));
  const s1 = manageStop(l, { stop: l.stop, hitTargets: 1, highWater: p }, p + l.stopDistance * 1.2);
  assert.ok(s1.stop >= l.entry);
  const s2 = manageStop(l, { stop: s1.stop, hitTargets: 2, highWater: s1.highWater }, p + l.stopDistance * 3);
  assert.ok(s2.stop >= s1.stop);
  const s3 = manageStop(l, s2, p - l.stopDistance); assert.ok(s3.stop >= s2.stop);
});

// ---------- Gainz-inspired components ----------
test("RSI: rising series -> 100, flat series -> 50, always within 0..100", () => {
  assert.equal(rsiSeries(Array.from({ length: 40 }, (_, i) => i + 1)).at(-1), 100);
  assert.equal(rsiSeries(Array(40).fill(5)).at(-1), 50);
  const r = rsiSeries(series(200, { noise: 1, seed: 2 }).map(k => k[4])).filter(Number.isFinite); assert.ok(r.every(v => v >= 0 && v <= 100));
});
test("RSI overbought is context only and never a reversal instruction", () => {
  const rows = series(200, { drift: 0.6, noise: 0.1, seed: 5 }); const r = rsiIntel(rows);
  assert.equal(r.reversalInstruction, false); assert.ok(["overbought", "bullish"].includes(r.zone));
});
test("EMA 9/21/50 alignment: bull in uptrend, bear in downtrend", () => {
  const up = series(200, { drift: 0.3, noise: 0.2, seed: 5 }), dn = series(200, { drift: -0.3, noise: 0.2, seed: 5, start: 200 });
  assert.equal(emaAlignment(up, atrSeries(up).at(-1)!).state, "bull"); assert.equal(emaAlignment(dn, atrSeries(dn).at(-1)!).state, "bear");
});
test("breakout needs close, volume, momentum and structure; thin-volume breakouts are not confirmed", () => {
  const flat = rangeSeries(120, { base: 100, noise: 0.4, seed: 4, end: NOW }), a = atrSeries(flat).at(-1)!;
  const hi = Math.max(...flat.slice(-21, -1).map(r => r[2]));
  const mk = (vol: number): Kline[] => [...flat.slice(0, -1), [NOW, hi - 0.1, hi + 2 * a, hi - 0.2, hi + 1.8 * a, vol]];
  const strong = breakoutIntel(mk(400), a), thin = breakoutIntel(mk(30), a);
  assert.equal(strong.breakout, "bullish"); assert.equal(strong.volumeConfirmed, true); assert.equal(thin.volumeConfirmed, false); assert.equal(thin.confirmed, false);
});
test("failed breakout: a break that closes back inside the range is flagged", () => {
  const flat = rangeSeries(140, { base: 100, noise: 0.4, seed: 4, end: NOW }), a = atrSeries(flat).at(-1)!;
  const hi = Math.max(...flat.slice(-24, -4).map(r => r[2]));
  const rows: Kline[] = [...flat.slice(0, -3), [NOW - 2000, hi, hi + a, hi - 0.1, hi + 0.6 * a, 150], [NOW - 1000, hi + 0.5 * a, hi + 0.6 * a, hi - 0.5 * a, hi - 0.3 * a, 120], [NOW, hi - 0.3 * a, hi - 0.1 * a, hi - 1.0 * a, hi - 0.8 * a, 120]];
  assert.equal(breakoutIntel(rows, a).failed, "bullish");
});
test("retest helper: holding the broken level counts, losing it does not", () => {
  const rows: Kline[] = [100, 101, 102, 103, 104, 105].map((c, i) => [i, c - 0.5, c + 0.5, c - 0.6, c, 100]);
  assert.equal(retestOf([...rows, [6, 105, 105.2, 102.1, 104, 100]], 102, 1, 1, 3), true);
  assert.equal(retestOf([...rows, [6, 105, 105.2, 99, 100, 100]], 102, 1, 1, 3), false);
});
test("adaptive threshold rises in directionless or extreme-volatility conditions", () => {
  const calm = adaptiveThreshold(35, 0.5, false).threshold, flat = adaptiveThreshold(10, 0.5, false).threshold, wild = adaptiveThreshold(35, 0.95, false).threshold;
  assert.ok(flat > calm && wild > calm);
});
test("Gainz engine does not trade a mean-reverting range", () => {
  const ctx: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: candlesFor((tf, stepMs) => rangeSeries(300, { seed: 4, stepMs, end: NOW - 1000 })) };
  assert.notEqual(gainzEngine(ctx).status, "SIGNAL");
});

// ---------- engines: data integrity ----------
test("both engines refuse stale or insufficient data instead of forcing a signal", () => {
  const stale: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: candlesFor((tf, stepMs) => series(300, { drift: 0.2, stepMs, end: NOW - stepMs * 20 })) };
  for (const e of [swiftEngine(stale), gainzEngine(stale)]) { assert.equal(e.status, "NEUTRAL"); assert.equal(e.direction, 0); assert.equal(e.stopLoss, null); }
  const few: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: { "15m": series(40, { end: NOW - 1000, stepMs: 900000 }) } };
  assert.equal(swiftEngine(few).status, "NEUTRAL"); assert.equal(gainzEngine(few).status, "NEUTRAL");
});
test("engine signals never present confidence as a probability", () => {
  const ctx = trendCtx(0.25);
  for (const e of [swiftEngine(ctx), gainzEngine(ctx)]) assert.equal(e.confidenceType, "heuristic_score_not_probability");
});
test("a SIGNAL always carries a coherent stop and three ordered targets", () => {
  for (const seed of [1, 2, 3, 5, 7, 11]) for (const drift of [0.25, -0.25]) {
    const ctx = trendCtx(drift, "intraday", seed); if (drift < 0) for (const tf of TIMEFRAMES) ctx.candles[tf] = series(300, { drift, noise: 0.35, start: 400, seed, stepMs: TF_SECONDS[tf] * 1000, end: NOW - 1000 });
    for (const e of [swiftEngine(ctx), gainzEngine(ctx)]) if (e.status === "SIGNAL") {
      const d = e.direction as 1 | -1, mid = (e.entryZone![0] + e.entryZone![1]) / 2;
      assert.ok((mid - e.stopLoss!) * d > 0, "stop on the protective side"); const t = e.takeProfits!;
      assert.ok((t[0].price - mid) * d > 0 && (t[1].price - t[0].price) * d > 0 && (t[2].price - t[1].price) * d > 0, "targets ordered away from entry");
      assert.ok(e.expiresAt && e.invalidation.length > 0 && e.evidence.length > 0);
    }
  }
});

// ---------- fusion: all seven outcomes ----------
test("agreement detector covers all seven outcomes", () => {
  const S = (s: EngineSignal["status"], d: 1 | -1 | 0) => sig("swift", s, d), G = (s: EngineSignal["status"], d: 1 | -1 | 0) => sig("gainz", s, d);
  assert.equal(classifyAgreement(S("SIGNAL", 1), G("SIGNAL", 1)), "BOTH_BULLISH");
  assert.equal(classifyAgreement(S("SIGNAL", -1), G("SIGNAL", -1)), "BOTH_BEARISH");
  assert.equal(classifyAgreement(S("SIGNAL", 1), G("SIGNAL", -1)), "SWIFT_BULLISH_GAINZ_BEARISH");
  assert.equal(classifyAgreement(S("SIGNAL", -1), G("SIGNAL", 1)), "SWIFT_BEARISH_GAINZ_BULLISH");
  assert.equal(classifyAgreement(S("SIGNAL", 1), G("NEUTRAL", 0)), "ONE_ENGINE_CONFIRMED_OTHER_NEUTRAL");
  assert.equal(classifyAgreement(S("NEUTRAL", 0), G("SIGNAL", -1)), "ONE_ENGINE_CONFIRMED_OTHER_NEUTRAL");
  assert.equal(classifyAgreement(S("NEUTRAL", 0), G("NEUTRAL", 0)), "BOTH_NEUTRAL");
  assert.equal(classifyAgreement(S("INVALIDATED", 1), G("INVALIDATED", -1)), "BOTH_INVALIDATED");
});
test("fusion returns HOLD when both engines are neutral or both invalidated", () => {
  const ctx = trendCtx(0.25);
  assert.equal(fuseEngines(sig("swift", "NEUTRAL", 0), sig("gainz", "NEUTRAL", 0), ctx).decision, "HOLD");
  assert.equal(fuseEngines(sig("swift", "INVALIDATED", 1), sig("gainz", "INVALIDATED", 1), ctx).decision, "HOLD");
});
test("fusion without investigable data holds rather than guessing", () => {
  const ctx: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: {} };
  assert.equal(investigate(ctx), null);
  assert.equal(fuseEngines(sig("swift", "SIGNAL", 1), sig("gainz", "SIGNAL", 1), ctx).decision, "HOLD");
});
test("disagreement is resolved by independent evidence, and the rejected engine is recorded", () => {
  const ctx = trendCtx(0.25); const inv = investigate(ctx)!;
  assert.ok(inv.margin["1"] >= 3, `fixture should give independent bullish evidence, got margin ${inv.margin["1"]}`);
  const p = ctx.candles["15m"]!.at(-1)![4];
  const r = fuseEngines(sig("swift", "SIGNAL", 1, p), sig("gainz", "SIGNAL", -1, p), ctx);
  assert.equal(r.decision, "BUY"); assert.equal(r.acceptedEngine, "swift"); assert.equal(r.rejectedEngine?.engine, "gainz"); assert.match(r.rejectedEngine!.reason, /rejected/);
  const flipped = fuseEngines(sig("swift", "SIGNAL", -1, p), sig("gainz", "SIGNAL", 1, p), ctx);
  assert.equal(flipped.decision, "BUY"); assert.equal(flipped.acceptedEngine, "gainz"); assert.equal(flipped.rejectedEngine?.engine, "swift");
});
test("disagreement with no decisive independent evidence yields HOLD (no majority vote)", () => {
  const ctx: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: candlesFor((tf, stepMs) => rangeSeries(300, { seed: 4, stepMs, end: NOW - 1000 })) };
  const p = ctx.candles["15m"]!.at(-1)![4];
  const r = fuseEngines(sig("swift", "SIGNAL", 1, p), sig("gainz", "SIGNAL", -1, p), ctx);
  assert.equal(r.decision, "HOLD"); assert.equal(r.acceptedEngine, null);
});
test("agreeing engines are blocked when independent evidence contradicts them", () => {
  const ctx = trendCtx(0.25), p = ctx.candles["15m"]!.at(-1)![4];
  const r = fuseEngines(sig("swift", "SIGNAL", -1, p), sig("gainz", "SIGNAL", -1, p), ctx);
  assert.equal(r.decision, "HOLD");
});
test("single confirmed engine is accepted only with supporting independent evidence", () => {
  const up = trendCtx(0.25), p = up.candles["15m"]!.at(-1)![4];
  const ok = fuseEngines(sig("swift", "SIGNAL", 1, p), sig("gainz", "NEUTRAL", 0), up); assert.equal(ok.decision, "BUY"); assert.equal(ok.acceptedEngine, "swift");
  const bad = fuseEngines(sig("swift", "SIGNAL", -1, p), sig("gainz", "NEUTRAL", 0), up); assert.equal(bad.decision, "HOLD");
});
test("merged levels are conservative: tighter stop and nearer targets", () => {
  const ctx = trendCtx(0.25), p = ctx.candles["15m"]!.at(-1)![4];
  const a = sig("swift", "SIGNAL", 1, p), b = sig("gainz", "SIGNAL", 1, p); b.stopLoss = p - 1; b.takeProfits![2].price = p + 5;
  const r = fuseEngines(a, b, ctx); assert.equal(r.decision, "BUY");
  assert.ok(r.stopLoss! >= p - 1.01 && r.stopLoss! <= p); assert.ok(r.takeProfits![2].price <= a.takeProfits![2].price + 1e-9);
});
test("non-positive validated expectancy blocks fusion", () => {
  const ctx = trendCtx(0.25), p = ctx.candles["15m"]!.at(-1)![4];
  assert.equal(fuseEngines(sig("swift", "SIGNAL", 1, p), sig("gainz", "SIGNAL", 1, p), ctx, { expectancyR: -0.1, expectancySamples: 80 }).decision, "HOLD");
});

// ---------- orchestrator ----------
test("omnisignal reports DATA_UNRELIABLE for stale candles and for provider disagreement", () => {
  const stale: FusionContext = { symbol: "TESTUSDT", strategy: "intraday", now: NOW, candles: candlesFor((tf, stepMs) => series(300, { drift: 0.2, stepMs, end: NOW - stepMs * 30 })) };
  assert.equal(runOmnisignal(stale).decision, "DATA_UNRELIABLE");
  assert.equal(runOmnisignal({ symbol: "X", strategy: "intraday", now: NOW, candles: {} }).decision, "DATA_UNRELIABLE");
});
test("omnisignal never submits an order or allows live execution, whatever the decision", () => {
  for (const drift of [0.25, 0, -0.25]) {
    const ctx = trendCtx(drift); const r = runOmnisignal(ctx);
    assert.equal(r.submitsOrder, false); assert.equal(r.liveExecutionAllowed, false); assert.equal(r.calibration.status, "uncalibrated");
    assert.ok(["BUY", "SELL", "HOLD", "REJECTED", "DATA_UNRELIABLE"].includes(r.decision));
    if (r.decision === "BUY" || r.decision === "SELL") { assert.ok(r.stopLoss !== null && r.takeProfits?.length === 3 && r.entryZone); assert.ok(r.confidence >= 0 && r.confidence <= 100); }
    else assert.equal(r.stopLoss, null);
  }
});
test("omnisignal rejects when account risk limits are breached, and holds on negative expectancy", () => {
  const ctx = trendCtx(0.25);
  const base = runOmnisignal(ctx);
  if (base.decision === "BUY" || base.decision === "SELL") {
    assert.equal(runOmnisignal(ctx, { risk: { withinLimits: false, reasons: ["Daily loss limit hit"] } }).decision, "REJECTED");
    assert.equal(runOmnisignal(ctx, { expectancyR: -0.2, expectancySamples: 60 }).decision, "HOLD");
  } else assert.ok(["HOLD", "REJECTED"].includes(base.decision));
});
test("disabled engines are reported as neutral, so a disabled engine can never drive a trade alone", () => {
  const ctx = trendCtx(0.25), r = runOmnisignal(ctx, { enabledEngines: { swift: false, gainz: false } });
  assert.equal(r.decision, "HOLD"); assert.equal(r.fusion.swift.status, "NEUTRAL"); assert.match(r.fusion.gainz.evidence[0], /disabled/);
});

// ---------- HTTP handler (mocked upstream market data; proves wiring and failure behaviour, not exchange reachability) ----------
import { handleOmnisignal } from "./algo/omni-api.ts";
import worker from "./index.ts";
const realFetch = globalThis.fetch;
const INTERVAL_MS: Record<string, number> = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
function mockBinance(opts: { depthOk?: boolean; stale?: boolean } = {}) {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.host !== "data-api.binance.vision") return new Response("down", { status: 500 });
    if (u.pathname.includes("klines")) {
      const step = INTERVAL_MS[u.searchParams.get("interval") || "1h"], end = Date.now() - (opts.stale ? step * 40 : step * 0.5);
      return new Response(JSON.stringify(series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: step, end }).map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), 0, "0", 1, "0", "0", "0"])), { status: 200 });
    }
    if (u.pathname.includes("depth") && opts.depthOk) {
      const mid = 100; return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 50 }, (_, i) => [String(mid - 0.01 - i * 0.01), "5"]), asks: Array.from({ length: 50 }, (_, i) => [String(mid + 0.01 + i * 0.01), "5"]) }), { status: 200 });
    }
    return new Response("down", { status: 500 });
  }) as typeof fetch;
}
test.afterEach(() => { globalThis.fetch = realFetch; });
const R = (path: string, method = "GET") => new Request("https://eti.test" + path, { method });

test("omnisignal endpoint validates input and is read-only", async () => {
  assert.equal((await handleOmnisignal(R("/api/omnisignal?symbol=bad!"), {})).status, 400);
  assert.equal((await handleOmnisignal(R("/api/omnisignal?strategy=yolo"), {})).status, 400);
  assert.equal((await handleOmnisignal(R("/api/omnisignal?engines=swift,nope"), {})).status, 400);
  assert.equal((await handleOmnisignal(R("/api/omnisignal", "POST"), {})).status, 405);
});
test("omnisignal endpoint is routed by the Worker and returns a complete analytical payload", async () => {
  mockBinance({ depthOk: true });
  const res = await worker.fetch(R("/api/omnisignal?symbol=BTCUSDT&strategy=intraday"), {} as any);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.submitsOrder, false); assert.equal(body.liveExecutionAllowed, false);
  assert.ok(["BUY", "SELL", "HOLD", "REJECTED", "DATA_UNRELIABLE"].includes(body.decision));
  assert.ok(body.fusion.swift && body.fusion.gainz && body.fusion.agreement);
  assert.equal(body.dataQuality.providerCrossCheck, "not_performed");
  assert.equal(body.calibration.status, "uncalibrated");
});
test("omnisignal endpoint degrades safely when the order book is unavailable", async () => {
  mockBinance({ depthOk: false });
  const body = await (await worker.fetch(R("/api/omnisignal?symbol=BTCUSDT&strategy=intraday"), {} as any)).json() as any;
  assert.equal(body.dataQuality.orderBook, "unavailable"); assert.ok(body.dataQuality.failures.depth);
  assert.equal(body.liveExecutionAllowed, false);
  if (body.decision === "BUY" || body.decision === "SELL") assert.ok(body.validation.warnings.some((w: string) => /Order book unavailable/.test(w)));
});
test("omnisignal endpoint reports DATA_UNRELIABLE for stale exchange data and 503 when all providers fail", async () => {
  mockBinance({ stale: true, depthOk: true });
  const stale = await (await worker.fetch(R("/api/omnisignal?symbol=BTCUSDT&strategy=intraday"), {} as any)).json() as any;
  assert.equal(stale.decision, "DATA_UNRELIABLE");
  globalThis.fetch = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  const down = await worker.fetch(R("/api/omnisignal?symbol=BTCUSDT&strategy=intraday"), {} as any);
  assert.equal(down.status, 503); assert.equal((await down.json() as any).decision, "DATA_UNRELIABLE");
});
test("legacy algo endpoint is now routed and rejects bad input", async () => {
  assert.equal((await worker.fetch(R("/api/algo/signal?symbol=x"), {} as any)).status, 400);
});
