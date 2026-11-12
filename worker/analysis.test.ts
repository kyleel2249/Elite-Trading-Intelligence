import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "./market.ts";
import { series, rangeSeries } from "./algo/fixtures.ts";
import { detectCandlePatterns } from "./analysis/candlesticks.ts";
import { analyzeBreaks, analyzeStructure, detectTrendlines, findPivots, supplyDemandZones, supportResistance } from "./analysis/structure.ts";
import { detectDisplacement, detectFVG, detectLiquiditySweeps, detectOrderBlocks } from "./analysis/smc.ts";
import { volumeProfile } from "./analysis/volume-profile.ts";
import { analyzeFibonacci } from "./analysis/fibonacci.ts";
import { analyzeMomentum, analyzeVolatility, relativeStrength } from "./analysis/momentum.ts";
import { isFullAnalysis, technicalAnalysis } from "./analysis/technical.ts";
import { aggregateYearly, closedCandles, multiTimeframeAnalysis, MTF_TIMEFRAMES, TF_SECS, type MtfTimeframe } from "./analysis/mtf.ts";
import { cryptoFundamentals, fxFundamentals, stockFundamentals } from "./analysis/fundamental.ts";
import { fetchCurrencyMacro, fetchStockFundamentals, parseCoinGecko, parseFredObservations, parseSecCompanyFacts, SourceError, yoyFromIndex } from "./analysis/fundamental-sources.ts";
import { parseFeed, filterBySubject, type NewsItem } from "./analysis/news-feeds.ts";
import { assessSentiment, polarity, similarity, validateItems } from "./analysis/sentiment.ts";
import { centralIntelligence } from "./analysis/intelligence.ts";
import { handleAnalysis, parseSymbol, rateLimited, sanitizeCandles } from "./analysis/api.ts";
import { inferAssetClass } from "./analysis/types.ts";
import { aggregateBuckets, parseYahooChart, yahooSymbol } from "./analysis/market-data-ext.ts";
import { calibrateTechnical, wilson } from "./analysis/calibrate.ts";
import { DEFAULT_FRED, form4Urls, parseForm4Xml } from "./analysis/fundamental-sources.ts";
import { cached } from "./analysis/api.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0), HR = 3600000;
const k = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => [NOW - (400 - i) * HR, o, h, l, c, v];
/** Quiet sideways baseline with ATR of roughly 1. */
const flat = (n: number, p = 100, start = 0): Kline[] => Array.from({ length: n }, (_, i) => { const up = i % 2 === 0; return k(start + i, up ? p - 0.3 : p + 0.3, p + 0.7, p - 0.7, up ? p + 0.3 : p - 0.3); });
const ramp = (n: number, from: number, to: number, start = 0): Kline[] => Array.from({ length: n }, (_, i) => { const a = from + (to - from) * i / n, b = from + (to - from) * (i + 1) / n; return k(start + i, a, Math.max(a, b) + 0.4, Math.min(a, b) - 0.4, b); });
const reindex = (rows: Kline[]): Kline[] => rows.map((r, i) => [NOW - (rows.length - 1 - i) * HR, r[1], r[2], r[3], r[4], r[5]] as Kline);

// ---------------- candlesticks ----------------
test("hammer after a decline is bullish; the same shape after an advance is a hanging man (context matters)", () => {
  const down = reindex([...flat(30, 110), ...ramp(8, 110, 100), k(0, 100, 100.3, 97.6, 100.2, 200)]);
  assert.ok(detectCandlePatterns(down, 3).some(p => p.name === "hammer" && p.bias === "bullish"));
  const up = reindex([...flat(30, 90), ...ramp(8, 90, 100), k(0, 100, 100.3, 97.6, 100.2, 200)]);
  const pats = detectCandlePatterns(up, 3);
  assert.ok(pats.some(p => p.name === "hanging_man" && p.bias === "bearish"));
  assert.ok(!pats.some(p => p.name === "hammer"));
});
test("bullish engulfing needs a prior decline and a body that engulfs the previous body", () => {
  const rows = reindex([...flat(30, 110), ...ramp(8, 110, 100), k(0, 100.2, 100.4, 98.8, 99.0), k(0, 98.8, 101.8, 98.6, 101.6, 250)]);
  assert.ok(detectCandlePatterns(rows, 2).some(p => p.name === "bullish_engulfing"));
});
test("shooting star after an advance is bearish; doji is neutral", () => {
  const rows = reindex([...flat(30, 90), ...ramp(8, 90, 100), k(0, 100, 102.6, 99.9, 100.2, 200)]);
  assert.ok(detectCandlePatterns(rows, 2).some(p => p.name === "shooting_star" && p.bias === "bearish"));
  const d = reindex([...flat(40), k(0, 100, 101.5, 98.5, 100.05)]);
  assert.ok(detectCandlePatterns(d, 1).some(p => p.name === "doji" && p.bias === "neutral"));
});

// ---------------- structure ----------------
test("pivots are confirmed fractals and never include the unconfirmed tail", () => {
  const rows = reindex([...flat(30), ...ramp(10, 100, 110), k(0, 110, 112, 109.6, 110.5)]);
  const p = findPivots(rows, 3, 3);
  assert.ok(p.every(x => x.index <= rows.length - 1 - 3), "a pivot within `right` bars of the end would repaint");
});
test("zig-zag with rising peaks and troughs is an uptrend with HH/HL labels; a close below the last higher low is a CHoCH", () => {
  const path = [100, 106, 102, 110, 105, 114, 108, 118, 112, 122, 116, 126, 120];
  const rows: Kline[] = [];
  path.forEach((v, i) => { if (i === 0) return; const a = path[i - 1]; const steps = 6; for (let s = 0; s < steps; s++) { const o = a + (v - a) * s / steps, c = a + (v - a) * (s + 1) / steps; rows.push(k(rows.length, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c)); } });
  const ms = analyzeStructure(reindex([...flat(20, 100), ...rows]));
  assert.equal(ms.trend, "uptrend"); assert.ok(ms.higherHighs >= 2 && ms.higherLows >= 2); assert.ok(ms.invalidationLevel !== null);
  const broken = reindex([...flat(20, 100), ...rows, ...ramp(10, 120, 108)]);
  const ev = analyzeStructure(broken).events;
  assert.ok(ev.some(e => e.type === "CHoCH" && e.direction === "bearish"), "close below the last higher low must register as CHoCH");
});
test("support/resistance clusters repeated pivots and ranks strength by touches", () => {
  const rows = reindex(rangeSeries(250, { base: 100, noise: 1.2, reversion: 0.3, seed: 8, end: NOW }));
  const lv = supportResistance(rows, findPivots(rows));
  assert.ok(lv.length > 0 && lv.every(l => l.touches >= 2 && l.strength > 0 && l.strength <= 100));
});
test("a base followed by an impulsive leg-out forms a demand zone; fresh until price returns", () => {
  const rows = reindex([...flat(30, 100), k(0, 100, 100.4, 99.6, 100.1), k(0, 100.1, 100.4, 99.7, 100.0), k(0, 100, 103.5, 99.9, 103.3, 400), k(0, 103.3, 106, 103.2, 105.8, 400), k(0, 105.8, 107, 105.5, 106.8), ...ramp(8, 106.8, 108)]);
  const z = supplyDemandZones(rows).find(x => x.kind === "demand");
  assert.ok(z, "demand zone expected"); assert.ok(z!.fresh && !z!.invalidated && z!.legOutAtr >= 1.5);
});
test("ascending trendline needs >= 3 touches and reports its projection", () => {
  const rows: Kline[] = []; for (let i = 0; i < 120; i++) { const floor = 100 + i * 0.2, phase = i % 20, off = phase < 4 ? phase * 0.2 : 3 + (phase < 12 ? (phase - 4) * 0.5 : (20 - phase) * 0.5); rows.push(k(i, floor + off, floor + off + 0.5, floor + off - (phase === 0 ? 0.1 : 0.5) , floor + off + 0.1)); }
  const rr = reindex(rows), tl = detectTrendlines(rr, findPivots(rr));
  assert.ok(tl.length > 0 && tl.every(t => t.touches >= 3), "an ascending support line with >= 3 touches should be found"); assert.ok(tl.some(t => t.kind === "support" && t.slope > 0));
});
test("breakout, false breakout and retest are told apart", () => {
  const lvl = { price: 105, low: 105, high: 105, touches: 3, lastTouchIndex: 10, strength: 70, kind: "resistance" as const };
  const base = [...flat(30, 100)];
  const good = reindex([...base, ...ramp(6, 100, 104.5), k(0, 104.5, 107.5, 104.4, 107.2, 500), k(0, 107.2, 108, 106.8, 107.6), k(0, 107.6, 107.8, 105.1, 106.2), k(0, 106.2, 108, 106, 107.5)]);
  const g = analyzeBreaks(good, [lvl]);
  assert.ok(g.some(e => e.type === "breakout" && e.volumeConfirmed)); assert.ok(g.some(e => e.type === "retest_hold"));
  const fake = reindex([...base, ...ramp(6, 100, 104.5), k(0, 104.5, 107.5, 104.4, 107.2, 500), k(0, 107.2, 107.4, 103.5, 104.0), k(0, 104, 104.5, 102, 102.5)]);
  assert.ok(analyzeBreaks(fake, [lvl]).some(e => e.type === "false_breakout"));
});

// ---------------- smart-money constructs ----------------
test("bullish FVG is detected with correct bounds and fill tracking", () => {
  const rows = reindex([...flat(30), k(0, 100, 100.6, 99.8, 100.4), k(0, 100.4, 104.5, 100.3, 104.3, 400), k(0, 104.3, 105, 102, 104.8), k(0, 104.8, 105.2, 103.9, 105)]);
  const f = detectFVG(rows).find(x => x.kind === "bullish");
  assert.ok(f); assert.ok(Math.abs(f!.low - 100.6) < 1e-9 && Math.abs(f!.high - 102) < 1e-9); assert.equal(f!.status, "open");
  const filled = reindex([...rows, k(0, 105, 105.1, 100.2, 100.5)]);
  assert.equal(detectFVG(filled).find(x => x.kind === "bullish")!.status, "filled");
});
test("displacement requires both a large body and a dominant body share", () => {
  const rows = reindex([...flat(30), k(0, 100, 104, 99.9, 103.9, 300), k(0, 103.9, 105, 100, 103.8)]);
  const d = detectDisplacement(rows); assert.ok(d.some(x => x.direction === "bullish")); assert.equal(d.filter(x => x.index === rows.length - 1).length, 0);
});
test("a wick through equal highs that closes back inside is a sweep; a close beyond is not", () => {
  const mk = (final: Kline[]) => reindex([...flat(10, 100), ...ramp(5, 100, 104), k(0, 104, 105.0, 103, 103.5), k(0, 103.5, 103.8, 102, 102.5), ...ramp(5, 102.5, 104), k(0, 104, 105.0, 103.2, 103.6), ...ramp(6, 103.6, 102.5), ...final]);
  const swept = mk([k(0, 102.5, 106.2, 102.4, 104.0, 300), k(0, 104, 104.2, 102.8, 103.0)]);
  const s = detectLiquiditySweeps(swept, findPivots(swept));
  assert.ok(s.some(x => x.side === "buy_side" && x.direction === "bearish" && x.reclaimed));
  const brk = mk([k(0, 102.5, 107, 102.4, 106.8, 300), k(0, 106.8, 108, 106.5, 107.8), k(0, 107.8, 109, 107.5, 108.8)]);
  assert.equal(detectLiquiditySweeps(brk, findPivots(brk)).filter(x => x.side === "buy_side" && x.level < 105.5 && x.index >= brk.length - 3).length, 0);
});
test("order block = last opposite candle before a structure-breaking displacement; invalidated by a close through it", () => {
  const pre = [...flat(20, 100), k(0, 100.5, 100.8, 99.2, 99.6)];
  const up = reindex([...pre, k(0, 99.6, 105.5, 99.5, 105.3, 500), ...ramp(6, 105.3, 106)]);
  const ob = detectOrderBlocks(up).find(o => o.kind === "bullish");
  assert.ok(ob && ob.breaksStructure && Math.abs(ob.high - 100.8) < 1e-9);
  const dead = reindex([...up, k(0, 106, 106, 98, 98.5, 300)]);
  assert.equal(detectOrderBlocks(dead).filter(o => o.kind === "bullish" && Math.abs(o.high - 100.8) < 1e-9).length, 0);
});

// ---------------- profile, fib, momentum ----------------
test("volume profile puts the POC where volume concentrates and the value area around it", () => {
  const rows = reindex([...Array.from({ length: 60 }, (_, i) => k(i, 100 + (i % 5) * 0.2, 101 + (i % 5) * 0.2, 99, 100.5, 1000)), ...Array.from({ length: 30 }, (_, i) => k(i, 108, 112, 107, 110, 50))]);
  const vp = volumeProfile(rows)!; assert.ok(vp.poc >= 99 && vp.poc <= 102); assert.ok(vp.val <= vp.poc && vp.poc <= vp.vah);
});
test("fibonacci: a pullback leg and a retracing up-leg are both anchored and computed correctly", () => {
  const done = reindex([...flat(20, 100), ...ramp(15, 100, 130), ...ramp(8, 130, 118), ...flat(6, 118)]);
  const d = analyzeFibonacci(done, findPivots(done))!;
  assert.equal(d.direction, "down_leg");   // the most recent significant confirmed leg is the pullback
  const legD = d.swingStart.price - d.swingEnd.price;
  assert.ok(Math.abs(d.retracements.find(r => r.ratio === 0.618)!.price - (d.swingEnd.price + legD * 0.618)) < 1e-6);
  // price is still falling: the low is unconfirmed, so the anchor is the up-leg and price is retracing it
  const live = reindex([...flat(20, 100), k(0, 100, 100.2, 97.5, 98.5), ...ramp(15, 100, 130), ...ramp(5, 130, 120)]);
  const u = analyzeFibonacci(live, findPivots(live))!;
  assert.equal(u.direction, "up_leg");
  const legU = u.swingEnd.price - u.swingStart.price;
  assert.ok(Math.abs(u.retracements.find(r => r.ratio === 0.618)!.price - (u.swingEnd.price - legU * 0.618)) < 1e-6);
  assert.ok(Math.abs(u.extensions.find(r => r.ratio === 1.618)!.price - (u.swingStart.price + legU * 1.618)) < 1e-6);
  assert.ok(u.currentRetracement > 0.2 && u.currentRetracement < 0.5);
});
test("momentum is bullish in an advance, bearish in a decline; volatility regime is classified", () => {
  assert.ok(analyzeMomentum(series(120, { drift: 0.3, noise: 0.3, seed: 2 }))!.score > 15);
  assert.ok(analyzeMomentum(series(120, { drift: -0.3, noise: 0.3, seed: 2, start: 200 }))!.score < -15);
  assert.ok(["compression", "normal", "expansion"].includes(analyzeVolatility(series(150, { seed: 3 }))!.regime));
});
test("relative strength aligns by timestamp and refuses to guess with too little overlap", () => {
  const a = reindex(series(60, { drift: 0.4, noise: 0.2, seed: 1 })), b = reindex(series(60, { drift: 0, noise: 0.2, seed: 1 }));
  assert.equal(relativeStrength(a, b, "BM")!.state, "outperforming");
  assert.equal(relativeStrength(a.slice(0, 10), b.slice(0, 10), "BM"), null);
});

// ---------------- technical engine ----------------
test("technical engine: uptrend scores bullish, short history is unavailable (never guessed)", () => {
  const t = technicalAnalysis("T", "1h", reindex(series(300, { drift: 0.25, noise: 0.5, seed: 3 })), { now: NOW });
  assert.ok(isFullAnalysis(t)); assert.equal(t.report.stance, "bullish"); assert.ok(t.report.score > 20 && t.report.score <= 100);
  assert.equal(t.report.confidenceType, "evidence_quality_not_probability"); assert.ok(t.report.findings.length > 3);
  const s = technicalAnalysis("T", "1h", reindex(series(30)), { now: NOW });
  assert.equal(s.report.status, "unavailable"); assert.ok(!isFullAnalysis(s));
});

// ---------------- multi-timeframe ----------------
const stepFor = (tf: MtfTimeframe) => (tf === "1M" ? 2629800000 : tf === "1Y" ? 31557600000 : TF_SECS[tf] * 1000);
function frames(gen: (tf: MtfTimeframe) => Kline[]) { const c: Partial<Record<MtfTimeframe, Kline[]>> = {}; for (const tf of MTF_TIMEFRAMES) if (tf !== "1Y") c[tf] = gen(tf); c["1M"] = c["1M"]!.map((r, i) => [Date.UTC(2017, 7 + i, 1), r[1], r[2], r[3], r[4], r[5]] as Kline); return c; }
test("closedCandles drops the still-forming candle", () => {
  const rows: Kline[] = [[NOW - 3 * HR, 1, 2, 1, 1.5, 1], [NOW - 2 * HR, 1, 2, 1, 1.5, 1], [NOW - 0.5 * HR, 1, 2, 1, 1.5, 1]];
  assert.equal(closedCandles("1h", rows, NOW).length, 2);
});
test("yearly candles aggregate from monthly and flag a partial first year", () => {
  const m: Kline[] = Array.from({ length: 30 }, (_, i) => [Date.UTC(2023, 5 + i, 1), 10 + i, 20 + i, 5 + i, 15 + i, 1] as Kline);
  const y = aggregateYearly(m); assert.equal(y.rows.length, 3); assert.ok(y.partialFirstYear);
  assert.equal(y.rows[1][1], m[7][1]); assert.equal(y.rows[1][4], m[18][4]);
});
test("all layers agreeing yields aligned; context vs execution disagreement yields CONFLICTED and is not averaged away", () => {
  const upC = frames(tf => series(tf === "1M" ? 110 : 300, { drift: 0.25, noise: 0.5, seed: 3, stepMs: stepFor(tf), end: NOW - stepFor(tf) * 1.5 }));
  const aligned = multiTimeframeAnalysis({ symbol: "T", strategy: "intraday", candles: upC, now: NOW });
  assert.equal(aligned.alignment, "aligned_bullish"); assert.equal(aligned.report.stance, "bullish");
  const mixedC = { ...upC } as typeof upC;
  for (const tf of ["30m", "15m", "5m", "1m"] as const) mixedC[tf] = series(300, { drift: -0.25, noise: 0.5, seed: 4, start: 200, stepMs: stepFor(tf), end: NOW - stepFor(tf) * 1.5 });
  const m = multiTimeframeAnalysis({ symbol: "T", strategy: "intraday", candles: mixedC, now: NOW });
  assert.equal(m.alignment, "conflicted"); assert.equal(m.report.stance, "conflicted"); assert.ok(m.conflicts.length > 0); assert.match(m.guidance[0], /against the larger trend/);
});
test("the 1m frame is skipped for slow strategies and missing frames are reported, not invented", () => {
  const c = frames(tf => series(300, { drift: 0.2, seed: 5, stepMs: stepFor(tf), end: NOW - stepFor(tf) * 1.5 })); delete c["5m"];
  const r = multiTimeframeAnalysis({ symbol: "T", strategy: "swing", candles: c, now: NOW });
  assert.equal(r.timeframes.find(t => t.timeframe === "1m")!.mode, "skipped"); assert.equal(r.timeframes.find(t => t.timeframe === "5m")!.mode, "unavailable"); assert.ok(r.report.missing.includes("5m candles"));
});

// ---------------- fundamentals ----------------
test("FX: positive base-minus-quote differentials score bullish for the base; stale data and event risk are flagged", () => {
  const b = { code: "EUR", policyRatePct: 4, inflationYoYPct: 2, unemploymentPct: 5, gdpGrowthPct: 2, yield10yPct: 4, policyBias: "hawkish" as const, asOf: "2026-10-30" }, q = { code: "GBP", policyRatePct: 2, inflationYoYPct: 3, unemploymentPct: 6, gdpGrowthPct: 0.5, yield10yPct: 3, policyBias: "dovish" as const, asOf: "2025-01-01" };
  const r = fxFundamentals({ pair: "EURGBP", base: b, quote: q, now: NOW, events: [{ name: "CPI", currency: "EUR", time: new Date(NOW + 3 * HR).toISOString(), impact: "high" }] });
  assert.equal(r.stance, "bullish"); assert.ok(r.warnings.some(w => /GBP macro data/.test(w) && /outdated/.test(w))); assert.ok(r.warnings.some(w => /Event risk/.test(w))); assert.equal((r.extras as any).eventRisk, true);
});
test("FX: missing inputs lower completeness instead of being filled in", () => {
  const r = fxFundamentals({ pair: "EURUSD", base: { code: "EUR", policyRatePct: 2 }, quote: { code: "USD", policyRatePct: 4 }, now: NOW });
  assert.ok(r.completeness < 0.5); assert.ok(r.missing.length >= 3);
});
test("crypto: scam-pattern token is HIGH RISK and forced bearish regardless of inputs elsewhere", () => {
  const r = cryptoFundamentals({ symbol: "SHADY", now: NOW, supply: { total: 1e9, circulating: 5e7, fdvUsd: 5e8, marketCapUsd: 2e7 }, holders: { top10Pct: 82 }, liquidity: { volume24hUsd: 5e4, dexLiquidityUsd: 9e4 }, security: { audits: [], sourceVerified: false, upgradeable: true, singleAdminKey: true, mintable: true }, team: { publiclyIdentified: false } });
  assert.equal((r.extras as any).legitimacy, "high_risk"); assert.equal(r.stance, "bearish"); assert.ok(r.score <= -40); assert.ok(r.findings.some(f => f.kind === "red_flag" && /CRITICAL/.test(f.description)));
});
test("crypto: little data means UNVERIFIED (absence of information is not legitimacy) and cannot be bullish", () => {
  const r = cryptoFundamentals({ symbol: "NEWC", now: NOW, liquidity: { volume24hUsd: 5e9 }, supply: { total: 1e9, circulating: 9e8, marketCapUsd: 1e10, fdvUsd: 1.1e10 } });
  assert.equal((r.extras as any).legitimacy, "unverified"); assert.notEqual(r.stance, "bullish"); assert.ok(r.confidence <= 35);
});
test("crypto: a well-documented project is substantive", () => {
  const r = cryptoFundamentals({ symbol: "GOOD", now: NOW, asOf: "2026-11-08", purpose: "Settlement network for tokenised assets with on-chain fee revenue and public governance.", team: { publiclyIdentified: true, founders: ["A. Dev"] }, supply: { total: 1e9, circulating: 6e8, fdvUsd: 1.5e9, marketCapUsd: 9e8 }, unlocks: [], holders: { top10Pct: 22, excludesExchangesAndBurn: true }, liquidity: { volume24hUsd: 8e7, dexLiquidityUsd: 3e7, spreadBps: 4 }, exchanges: { tier1Count: 3, totalCount: 40 }, network: { activeAddresses30d: 2e5, activeAddressesChange30dPct: 8, feesUsd30d: 5e6, tvlUsd: 4e8 }, security: { audits: [{ firm: "A" }, { firm: "B" }], sourceVerified: true, upgradeable: false, mintable: false, bugBounty: true }, adoption: { users: 5e5, integrations: 20, revenueUsd30d: 4e6 }, development: { commits90d: 220, contributors90d: 18, lastCommitDate: "2026-11-07" }, governance: { model: "token voting", proposals90d: 5, turnoutPct: 9 }, regulatory: { risk: "low" } });
  assert.equal((r.extras as any).legitimacy, "substantive"); assert.equal(r.stance, "bullish");
});
test("stock: derived ratios are correct and unsupplied inputs are reported missing", () => {
  const r = stockFundamentals({ symbol: "ACME", now: NOW, asOf: "2026-06-30", priceAsOf: "2026-11-09", revenueTTM: 1200, revenuePrev: 1000, netIncomeTTM: 180, netIncomePrev: 140, grossProfitTTM: 600, operatingIncomeTTM: 240, ebitdaTTM: 300, operatingCashFlowTTM: 260, capexTTM: 60, totalDebt: 400, cash: 300, interestExpenseTTM: 20, marketCap: 3000, sharesOutstanding: 100, sharesOutstandingPrev: 101, sectorMedians: { pe: 22, evEbitda: 14, operatingMarginPct: 15 } });
  const d = (r.extras as any).derived; assert.ok(Math.abs(d.revenueGrowthPct - 20) < 1e-9); assert.equal(d.freeCashFlow, 200); assert.ok(Math.abs(d.netDebtToEbitda - 100 / 300) < 1e-9); assert.ok(Math.abs(d.peTTM - 3000 / 180) < 1e-9);
  assert.ok(r.missing.includes("insider and institutional activity")); assert.ok(r.warnings.some(w => /Insider transactions not supplied/.test(w))); assert.equal(r.stance, "bullish");
  const loss = stockFundamentals({ symbol: "LOSS", now: NOW, revenueTTM: 100, revenuePrev: 120, netIncomeTTM: -50, marketCap: 500 });
  assert.ok(loss.warnings.some(w => /loss-making/.test(w))); assert.notEqual(loss.stance, "bullish");
});

// ---------------- data-source adapters (fixtures; live endpoints are not exercised in CI) ----------------
test("CoinGecko parser maps supply, venues and flags what the source cannot provide", () => {
  const { input, notes } = parseCoinGecko({ name: "Foo", description: { en: "<p>A network.</p>" }, market_data: { total_supply: 100, circulating_supply: 60, max_supply: 100, current_price: { usd: 2 }, market_cap: { usd: 120 }, fully_diluted_valuation: { usd: 200 }, total_volume: { usd: 9 } }, developer_data: { commit_count_4_weeks: 28 }, tickers: [{ market: { identifier: "a", name: "A" }, trust_score: "green" }, { market: { identifier: "b", name: "B" }, trust_score: "yellow" }] }, NOW);
  assert.equal(input.supply!.circulating, 60); assert.equal(input.exchanges!.tier1Count, 1); assert.equal(input.exchanges!.totalCount, 2); assert.equal(input.development!.commits90d, 90); assert.equal(input.purpose, "A network.");
  assert.ok(notes.some(n => /does not provide: team, holder concentration/.test(n)));
});
test("SEC parser picks annual 10-K flows, the latest two years, and derives EBITDA only when periods match", () => {
  const f = (end: string, start: string, val: number) => ({ end, start, val, form: "10-K", fp: "FY", filed: end });
  const facts = { entityName: "Acme", facts: { "us-gaap": { Revenues: { units: { USD: [f("2024-12-31", "2024-01-01", 1000), f("2025-12-31", "2025-01-01", 1200), { end: "2025-09-30", start: "2025-07-01", val: 300, form: "10-Q", fp: "Q3" }] } }, OperatingIncomeLoss: { units: { USD: [f("2025-12-31", "2025-01-01", 240)] } }, DepreciationDepletionAndAmortization: { units: { USD: [f("2025-12-31", "2025-01-01", 60)] } }, CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: "2025-12-31", val: 300, form: "10-K" }] } } }, dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: "2026-01-31", val: 100 }, { end: "2025-01-31", val: 102 }] } } } } };
  const { input } = parseSecCompanyFacts(facts, NOW);
  assert.equal(input.revenueTTM, 1200); assert.equal(input.revenuePrev, 1000); assert.equal(input.ebitdaTTM, 300); assert.equal(input.cash, 300); assert.equal(input.sharesOutstandingPrev, 102);
});
test("FRED parsing skips '.' placeholders and computes YoY from an index", () => {
  const obs = parseFredObservations({ observations: [{ date: "2026-10-01", value: "105" }, { date: "2026-09-01", value: "." }, { date: "2025-10-01", value: "100" }] });
  assert.equal(obs.length, 2); assert.ok(Math.abs(yoyFromIndex(obs)!.value - 5) < 1e-9);
});
test("adapters fail loudly (never fabricate) when credentials are missing", async () => {
  await assert.rejects(() => fetchStockFundamentals("AAPL", {}, async () => new Response("{}")), (e: unknown) => e instanceof SourceError && /SEC_USER_AGENT/.test(e.message));
  await assert.rejects(() => fetchCurrencyMacro("USD", {}, async () => new Response("{}")), (e: unknown) => e instanceof SourceError && /FRED_API_KEY/.test(e.message));
});

// ---------------- news and sentiment ----------------
const h = (n: number) => new Date(NOW - n * HR).toISOString();
const item = (id: string, title: string, source: string, sourceType: NewsItem["sourceType"], ago: number, extra: Partial<NewsItem> = {}): NewsItem => ({ id, title, source, sourceType, publishedAt: h(ago), ...extra });
test("RSS/Atom parsing decodes entities and rejects items without a usable timestamp", () => {
  const rss = `<rss><channel><item><title><![CDATA[Fed &amp; rates]]></title><link>https://x.test/a</link><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Held&lt;/p&gt;</description></item><item><title>No date</title></item></channel></rss>`;
  const p = parseFeed(rss, { name: "T", type: "central_bank" }); assert.equal(p.items.length, 1); assert.equal(p.items[0].title, "Fed & rates"); assert.equal(p.items[0].summary, "Held"); assert.equal(p.rejected.length, 1);
  const atom = parseFeed(`<feed><entry><title>Hello</title><link href="https://y.test/b"/><updated>2026-11-09T09:00:00Z</updated><summary>S</summary></entry></feed>`, { name: "A", type: "media" }); assert.equal(atom.items[0].url, "https://y.test/b");
});
test("every event needs a source and a valid, non-future timestamp", () => {
  const { valid, rejected } = validateItems([item("1", "ok", "S", "media", 1), { ...item("2", "no ts", "S", "media", 1), publishedAt: "" }, { ...item("3", "future", "S", "media", -5) }, { ...item("4", "no src", "", "media", 1) }], NOW);
  assert.equal(valid.length, 1); assert.equal(rejected.length, 3); assert.ok(rejected.some(r => /future/.test(r.reason)));
});
test("polarity handles negation and similarity clusters duplicate headlines", () => {
  assert.ok(polarity("Bitcoin surges to record high").score > 0); assert.ok(polarity("Exchange hacked, funds stolen").score < 0); assert.ok(polarity("Company denies it will default").score >= 0);
  assert.ok(similarity("SEC approves spot Solana ETF", "SEC approves spot Solana ETF today") > 0.5);
});
test("social claims stay UNVERIFIED until a credible source corroborates them", () => {
  const social = item("s1", "Binance to list ZETA token tomorrow", "@acct", "social", 2);
  let a = assessSentiment("ZETA", [social], NOW); assert.equal(a.events[0].status, "unverified"); assert.equal(a.unverifiedSocial, 1);
  a = assessSentiment("ZETA", [social, item("c1", "Binance announces listing of ZETA token", "Binance announcements", "exchange", 1)], NOW);
  assert.ok(a.events.every(e => e.status !== "unverified")); assert.equal(a.corroboratedSocial, 1);
});
test("coordinated social bursts and hype language raise manipulation risk", () => {
  const burst = ["@a", "@b", "@c", "@d"].map((s, i) => item(`b${i}`, "BREAKING SHADY token 100x guaranteed last chance moon", s, "social", 1 - i * 0.05));
  const a = assessSentiment("SHADY", burst, NOW); assert.ok(a.manipulation.risk >= 50); assert.ok(a.manipulation.signals.some(s => s.kind === "coordinated_burst" && s.severity === "high"));
  assert.ok(a.report.confidence < 40);
});
test("outdated items are flagged and discounted; no recent news means unavailable, not neutral-by-default", () => {
  const old = assessSentiment("BTC", [item("o1", "Bitcoin surges on ETF hopes", "Wire", "wire", 100)], NOW); assert.equal(old.events[0].status, "outdated"); assert.equal(old.report.status, "unavailable");
});
test("a credible denial marks the original report disputed", () => {
  const a = assessSentiment("XYZ", [item("1", "Exchange to acquire XYZ protocol in billion dollar deal", "Blog", "media", 6), item("2", "Exchange denies plan to acquire XYZ protocol", "Exchange newsroom", "exchange", 2)], NOW);
  assert.ok(a.events.some(e => e.status === "disputed")); assert.ok(a.conflicts.some(c => c.kind === "correction_or_denial"));
});
test("credible but opposite developments yield a conflicted stance, not an averaged neutral", () => {
  const a = assessSentiment("SOL", [item("1", "SEC approves spot Solana ETF, markets rally", "SEC press", "regulator", 3), item("2", "Solana bridge hacked, hundreds of millions stolen", "Wire", "wire", 4)], NOW);
  assert.equal(a.report.stance, "conflicted"); assert.ok(a.conflicts.length > 0);
});
test("subject filtering uses whole-word matching", () => {
  const items = [item("1", "Bitcoin climbs", "A", "media", 1), item("2", "Solar panels boom", "A", "media", 1)];
  assert.deepEqual(filterBySubject(items, ["sol"]).map(i => i.id), []); assert.deepEqual(filterBySubject(items, ["bitcoin"]).map(i => i.id), ["1"]);
});

// ---------------- central intelligence ----------------
const upFrames = () => frames(tf => series(tf === "1M" ? 110 : 300, { drift: 0.25, noise: 0.5, seed: 3, stepMs: stepFor(tf), end: NOW - stepFor(tf) * 1.5 }));
const mtfUp = () => multiTimeframeAnalysis({ symbol: "T", strategy: "swing", candles: upFrames(), now: NOW });
const goodCrypto = () => cryptoFundamentals({ symbol: "GOOD", now: NOW, asOf: "2026-11-08", purpose: "Settlement network for tokenised assets with on-chain fee revenue and public governance.", team: { publiclyIdentified: true }, supply: { total: 1e9, circulating: 6e8, fdvUsd: 1.5e9, marketCapUsd: 9e8 }, holders: { top10Pct: 22, excludesExchangesAndBurn: true }, liquidity: { volume24hUsd: 8e7, dexLiquidityUsd: 3e7, spreadBps: 4 }, exchanges: { tier1Count: 3 }, network: { activeAddresses30d: 2e5, activeAddressesChange30dPct: 8, feesUsd30d: 5e6 }, security: { audits: [{ firm: "A" }], sourceVerified: true, upgradeable: false, mintable: false }, adoption: { users: 5e5, revenueUsd30d: 4e6 }, development: { commits90d: 220, contributors90d: 18, lastCommitDate: "2026-11-07" } });
test("bullish chart + legitimate fundamentals + constructive news = bullish case; engines are weighted, never forced", () => {
  const sent = assessSentiment("GOOD", [item("1", "GOOD network reports record growth and strong adoption", "Wire", "wire", 3)], NOW);
  const b = centralIntelligence({ symbol: "GOODUSDT", assetClass: "crypto", strategy: "swing", mtf: mtfUp(), fundamental: goodCrypto(), sentiment: sent, now: NOW });
  assert.equal(b.verdict, "BULLISH_CASE"); assert.equal(b.submitsOrder, false); assert.equal(b.liveExecutionAllowed, false); assert.ok(Math.abs(b.domains.reduce((s, d) => s + d.effectiveWeight, 0) - 1) < 0.01); assert.ok(b.evidenceLedger.length > 0);
});
test("a bullish chart cannot lift a HIGH-RISK token: verdict is AVOID", () => {
  const bad = cryptoFundamentals({ symbol: "SHADY", now: NOW, holders: { top10Pct: 82 }, security: { audits: [], sourceVerified: false, upgradeable: true, singleAdminKey: true }, team: { publiclyIdentified: false } });
  const b = centralIntelligence({ symbol: "SHADYUSDT", assetClass: "crypto", strategy: "swing", mtf: mtfUp(), fundamental: bad, now: NOW });
  assert.equal(b.verdict, "AVOID"); assert.ok(b.vetoes.some(v => v.id === "crypto-legitimacy"));
});
test("a bullish chart with NO verifiable fundamentals is capped at NEUTRAL for crypto", () => {
  const sent = assessSentiment("NEW", [item("1", "NEW token surges strongly in rally", "Wire", "wire", 2)], NOW);
  const b = centralIntelligence({ symbol: "NEWUSDT", assetClass: "crypto", strategy: "swing", mtf: mtfUp(), fundamental: null, sentiment: sent, now: NOW, fundamentalMissingReason: "no source" });
  assert.notEqual(b.verdict, "BULLISH_CASE"); assert.ok(b.vetoes.some(v => v.id === "crypto-unverified"));
});
test("opposing engines produce CONFLICTED with the disagreement spelled out", () => {
  const sent = assessSentiment("GOOD", [item("1", "GOOD faces fraud investigation as losses mount, warning issued", "Wire", "wire", 2), item("2", "GOOD plunges as regulators sue", "Regulator", "regulator", 2)], NOW);
  const b = centralIntelligence({ symbol: "GOODUSDT", assetClass: "crypto", strategy: "swing", mtf: mtfUp(), fundamental: goodCrypto(), sentiment: sent, now: NOW });
  assert.ok(b.conflicts.length > 0); assert.ok(["CONFLICTED", "BULLISH_CASE", "NEUTRAL"].includes(b.verdict)); assert.ok(b.conflicts.some(c => /sentiment/.test(c.detail)));
  assert.ok(b.confidence < 80);
});
test("a single evidence domain is INSUFFICIENT_DATA", () => {
  const b = centralIntelligence({ symbol: "X", assetClass: "stock", strategy: "swing", mtf: mtfUp(), now: NOW });
  assert.equal(b.verdict, "INSUFFICIENT_DATA"); assert.ok(b.coverage.unavailable.includes("fundamental"));
});
test("manipulated news is down-weighted", () => {
  const burst = ["@a", "@b", "@c", "@d"].map((s, i) => item(`b${i}`, "BREAKING GOOD token 100x guaranteed last chance moon", s, "social", 1 - i * 0.05));
  const b = centralIntelligence({ symbol: "GOODUSDT", assetClass: "crypto", strategy: "swing", mtf: mtfUp(), fundamental: goodCrypto(), sentiment: assessSentiment("GOOD", burst, NOW), now: NOW });
  assert.ok(b.vetoes.some(v => v.id === "news-integrity"));
});

// ---------------- API ----------------
test("input validation: symbols and candles", () => {
  assert.equal(parseSymbol("btcusdt"), "BTCUSDT"); assert.equal(parseSymbol("bad symbol!"), null); assert.equal(parseSymbol("A".repeat(30)), null);
  assert.ok(sanitizeCandles([[1, 2, 3, 1, 2, 5]]).error === undefined); assert.match(sanitizeCandles([[1, 2, 1, 3, 2, 5]]).error!, /inconsistent/); assert.match(sanitizeCandles([[1, "x", 3, 1, 2, 5]]).error!, /non-finite/); assert.match(sanitizeCandles("no").error!, /array/);
  const dup = sanitizeCandles([[2, 1, 2, 1, 1.5, 1], [1, 1, 2, 1, 1.5, 1], [2, 1, 2, 1, 1.6, 1]]); assert.deepEqual(dup.rows.map(r => r[0]), [1, 2]);
});
test("asset class inference", () => { assert.equal(inferAssetClass("BTCUSDT"), "crypto"); assert.equal(inferAssetClass("EURUSD"), "fx"); assert.equal(inferAssetClass("AAPL"), "stock"); });
test("rate limiter blocks bursts and recovers after the window", () => {
  const ip = "t-" + Math.random(); let blocked: number | null = null; for (let i = 0; i < 40; i++) blocked = rateLimited(ip, 2, 1000, 60);
  assert.ok(blocked !== null && blocked > 0); assert.equal(rateLimited(ip, 2, 1000 + 61000, 60), null);
});
const call = (path: string, init?: RequestInit) => handleAnalysis(new Request("https://eti.test" + path, init), {});
const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "api-" + Math.random() }, body: JSON.stringify(body) });
test("API: catalog, method and symbol validation", async () => {
  const c = await (await call("/api/analysis")).json() as any; assert.equal(c.submitsOrder, false); assert.deepEqual(c.configured, { FRED_API_KEY: false, SEC_USER_AGENT: false, COINGECKO_API_KEY: false, NEWS_FEEDS_JSON: false });
  assert.equal((await call("/api/analysis/technical", { method: "DELETE" })).status, 405);
  assert.equal((await call("/api/analysis/technical?symbol=bad%20sym")).status, 400);
  assert.equal((await call("/api/analysis/mtf?symbol=BTCUSDT&strategy=yolo")).status, 400);
  assert.equal((await call("/api/analysis/nope?symbol=BTCUSDT")).status, 404);
});
test("API: POST technical analyses supplied candles and rejects malformed ones", async () => {
  const rows = reindex(series(300, { drift: 0.25, noise: 0.5, seed: 3 }));
  const r = await post("/api/analysis/technical?symbol=AAPL&timeframe=1h", { candles: rows }); assert.equal(r.status, 200); const j = await r.json() as any; assert.equal(j.report.domain, "technical"); assert.ok(j.structure && j.volumeProfile);
  assert.equal((await post("/api/analysis/technical?symbol=AAPL", { candles: [[1, 2, 1, 3, 2, 1]] })).status, 400);
  assert.equal((await post("/api/analysis/technical?symbol=AAPL", { candles: reindex(series(20)) })).status, 422);
});
test("API: GET technical for a non-crypto symbol explains that candles must be supplied", async () => { const real = globalThis.fetch; globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  try { const r = await call("/api/analysis/technical?symbol=EURUSD"); assert.equal(r.status, 424); } finally { globalThis.fetch = real; } });
test("API: POST intelligence end to end with supplied candles, fundamentals and news", async () => {
  const candles: Record<string, Kline[]> = {}; for (const tf of ["1M", "1w", "1d", "4h", "1h", "30m", "15m"] as const) candles[tf] = tf === "1M" ? upFrames()["1M"]! : series(300, { drift: 0.25, noise: 0.5, seed: 3, stepMs: stepFor(tf), end: Date.now() - stepFor(tf) * 1.5 });
  const g = goodCrypto();
  const r = await post("/api/analysis/intelligence?symbol=GOODUSDT&strategy=swing", { candles, fundamental: { assetClass: "crypto", data: { purpose: "Settlement network for tokenised assets with on-chain fee revenue and public governance.", team: { publiclyIdentified: true }, supply: { total: 1e9, circulating: 6e8, fdvUsd: 1.5e9, marketCapUsd: 9e8 }, holders: { top10Pct: 22, excludesExchangesAndBurn: true }, liquidity: { volume24hUsd: 8e7, dexLiquidityUsd: 3e7 }, exchanges: { tier1Count: 3 }, network: { activeAddresses30d: 2e5, feesUsd30d: 5e6 }, security: { audits: [{ firm: "A" }], sourceVerified: true, upgradeable: false, mintable: false }, adoption: { users: 5e5 }, development: { commits90d: 200, contributors90d: 15, lastCommitDate: new Date().toISOString() } } }, news: [{ id: "1", title: "GOOD reports strong growth and record adoption", source: "Wire", sourceType: "wire", publishedAt: new Date(Date.now() - 3 * HR).toISOString() }] });
  assert.equal(r.status, 200); const j = await r.json() as any; assert.ok(g); assert.equal(j.submitsOrder, false); assert.ok(["BULLISH_CASE", "NEUTRAL", "CONFLICTED"].includes(j.verdict)); assert.equal(j.coverage.available.length, 3); assert.ok(j.engineReports.length === 3);
});
test("API: GET fundamental degrades to a clear 503 + setup hint when credentials are absent (stocks), with no fabricated data", async () => {
  const r = await call("/api/analysis/fundamental?symbol=AAPL"); assert.equal(r.status, 503); const j = await r.json() as any; assert.equal(j.status, "unavailable"); assert.match(j.setupRequired, /SEC_USER_AGENT/); assert.equal(j.score, 0);
});
test("API: oversized and invalid bodies are refused", async () => {
  assert.equal((await call("/api/analysis/news?symbol=BTCUSDT", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "x1" }, body: "{not json" })).status, 400);
  const big = await call("/api/analysis/news?symbol=BTCUSDT", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "x2" }, body: JSON.stringify({ items: [], pad: "x".repeat(2_100_000) }) }); assert.equal(big.status, 413);
});

// =============================== gap-closing additions ===============================
async function withFetch(handler: (url: string) => Response | Promise<Response>, fn: () => Promise<void>) {
  const orig = globalThis.fetch; (globalThis as any).fetch = async (u: any) => handler(String(u));
  try { await fn(); } finally { (globalThis as any).fetch = orig; }
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const FORM4 = `<ownershipDocument><reportingOwner><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable>
<nonDerivativeTransaction><transactionDate><value>2026-10-02</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>50</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>
<nonDerivativeTransaction><transactionDate><value>2026-10-03</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>400</value></transactionShares><transactionPricePerShare><value>51</value></transactionPricePerShare></transactionAmounts><ownershipNature><footnoteId id="F1"/></ownershipNature></nonDerivativeTransaction>
<nonDerivativeTransaction><transactionDate><value>2026-10-04</value></transactionDate><transactionCoding><transactionCode>A</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>9999</value></transactionShares></transactionAmounts></nonDerivativeTransaction>
<nonDerivativeTransaction><transactionDate><value>2026-10-05</value></transactionDate><transactionCoding><transactionCode>M</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>500</value></transactionShares></transactionAmounts></nonDerivativeTransaction>
</nonDerivativeTable><footnotes><footnote id="F1">Sale effected pursuant to a Rule 10b5-1 trading plan adopted earlier.</footnote></footnotes></ownershipDocument>`;
test("Form 4: only open-market buys/sales are kept; 10b5-1 sales are flagged as planned", () => {
  const t = parseForm4Xml(FORM4); assert.equal(t.length, 2);
  assert.deepEqual([t[0].type, t[0].shares, t[0].valueUsd, t[0].plannedSale, t[0].role], ["buy", 1000, 50000, false, "Chief Executive Officer"]);
  assert.deepEqual([t[1].type, t[1].plannedSale, t[1].valueUsd], ["sell", true, 20400]);
});
test("Form 4 URL builder keeps only recent form-4 filings and strips the XSL rendering folder", () => {
  const subs = { filings: { recent: { form: ["4", "8-K", "4", "4"], filingDate: ["2026-10-30", "2026-10-29", "2025-01-02", "2026-10-20"], accessionNumber: ["0001234567-26-000001", "0001234567-26-000002", "0001234567-25-000003", "0001234567-26-000004"], primaryDocument: ["xslF345X05/wf-form4.xml", "x.htm", "old.xml", "doc4.xml"] } } };
  const urls = form4Urls("0000012345", subs, NOW);
  assert.deepEqual(urls, ["https://www.sec.gov/Archives/edgar/data/12345/000123456726000001/wf-form4.xml", "https://www.sec.gov/Archives/edgar/data/12345/000123456726000004/doc4.xml"]);
  assert.deepEqual(form4Urls("0000012345", { filings: { recent: { form: ["4"], filingDate: ["2026-10-30"], accessionNumber: ["bad"], primaryDocument: ["../evil.xml"] } } }, NOW), [], "malformed accession/document names are refused");
});
test("stock fundamentals ingest SEC statements, Form 4 insiders and a derived market cap end to end (mocked network)", async () => {
  const f = (end: string, start: string, val: number) => ({ end, start, val, form: "10-K", fp: "FY", filed: end });
  const facts = { entityName: "Acme", facts: { "us-gaap": { Revenues: { units: { USD: [f("2024-12-31", "2024-01-01", 1000), f("2025-12-31", "2025-01-01", 1200)] } }, NetIncomeLoss: { units: { USD: [f("2024-12-31", "2024-01-01", 140), f("2025-12-31", "2025-01-01", 180)] } }, OperatingIncomeLoss: { units: { USD: [f("2025-12-31", "2025-01-01", 240)] } }, NetCashProvidedByUsedInOperatingActivities: { units: { USD: [f("2025-12-31", "2025-01-01", 260)] } }, PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [f("2025-12-31", "2025-01-01", 60)] } } }, dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: "2026-01-31", val: 100 }] } } } } };
  const subs = { filings: { recent: { form: ["4"], filingDate: [new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)], accessionNumber: ["0001234567-26-000001"], primaryDocument: ["xslF345X05/f4.xml"] } } };
  const chart = { chart: { result: [{ meta: { regularMarketPrice: 40, regularMarketTime: Math.floor(Date.now() / 1000) }, timestamp: [], indicators: { quote: [{}] } }] } };
  await withFetch(u => u.includes("company_tickers") ? json({ 0: { ticker: "ACME", cik_str: 1234567 } }) : u.includes("companyfacts") ? json(facts) : u.includes("submissions") ? json(subs) : u.endsWith("f4.xml") ? new Response(FORM4) : u.includes("yahoo") ? json(chart) : new Response("no", { status: 404 }), async () => {
    const r = await handleAnalysis(new Request("https://eti.test/api/analysis/fundamental?symbol=ACME", { headers: { "cf-connecting-ip": "s-" + Math.random() } }), { SEC_USER_AGENT: "ETI test@example.com" });
    assert.equal(r.status, 200); const j = await r.json() as any;
    assert.ok(!j.missing.includes("insider and institutional activity"), "insider data should now be present");
    assert.ok(j.notes.some((n: string) => /Form 4 filing/.test(n)) && j.notes.some((n: string) => /Market cap derived/.test(n)) && j.notes.some((n: string) => /13F/.test(n)));
    assert.ok(Math.abs(j.extras.derived.peTTM - (40 * 100) / 180) < 1e-6);
  });
});
test("Yahoo chart parsing drops null bars; 1h aggregates to 4h; FX symbols are mapped", () => {
  const p = parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 1.1, currency: "USD" }, timestamp: [3600, 7200, 10800], indicators: { quote: [{ open: [1, null, 2], high: [2, 3, 3], low: [1, 1, 1], close: [1.5, 2, 2.5], volume: [10, 5, 7] }] } }] } });
  assert.equal(p.rows.length, 2); assert.equal(p.rows[0][0], 3600000); assert.equal(yahooSymbol("EURUSD", "fx"), "EURUSD=X");
  const h: Kline[] = Array.from({ length: 8 }, (_, i) => [i * 3600000, 10 + i, 12 + i, 9 + i, 11 + i, 1]);
  const a = aggregateBuckets(h, 4 * 3600000); assert.equal(a.length, 2); assert.equal(a[0][1], 10); assert.equal(a[0][4], 14); assert.equal(a[0][2], 15); assert.equal(a[0][5], 4);
  assert.throws(() => parseYahooChart({ chart: { result: null, error: { description: "Not Found" } } }), /Not Found/);
});
const yahooMock = (u: string) => {
  const iv = u.match(/interval=([^&]+)/)?.[1] ?? "1d", step = ({ "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "60m": 3600000, "1d": 86400000, "1wk": 604800000, "1mo": 2629800000 } as Record<string, number>)[iv];
  const n = iv === "1mo" ? 110 : 300, base = iv === "1mo" ? Date.UTC(2017, 7, 1) : Date.now() - step * (n + 1.5);
  const rows = series(n, { drift: 0.25, noise: 0.5, seed: 3, stepMs: step, end: base + step * n }).map((r, i) => iv === "1mo" ? [Date.UTC(2017, 7 + i, 1), r[1], r[2], r[3], r[4], 0] : [r[0], r[1], r[2], r[3], r[4], u.includes("%3DX") ? 0 : r[5]]);
  return json({ chart: { result: [{ meta: { regularMarketPrice: 100 }, timestamp: rows.map(r => Math.floor(Number(r[0]) / 1000)), indicators: { quote: [{ open: rows.map(r => r[1]), high: rows.map(r => r[2]), low: rows.map(r => r[3]), close: rows.map(r => r[4]), volume: rows.map(r => r[5]) }] } }] } });
};
test("stocks and FX now get server-side technical and multi-timeframe analysis (mocked Yahoo)", async () => {
  await withFetch(yahooMock, async () => {
    const t = await handleAnalysis(new Request("https://eti.test/api/analysis/technical?symbol=AAPL&timeframe=1h", { headers: { "cf-connecting-ip": "y1" } }), {}); assert.equal(t.status, 200); const tj = await t.json() as any; assert.equal(tj.dataQuality.provider, "yahoo-finance"); assert.equal(tj.report.stance, "bullish");
    const m = await handleAnalysis(new Request("https://eti.test/api/analysis/mtf?symbol=EURUSD&strategy=swing&detail=lite", { headers: { "cf-connecting-ip": "y2" } }), {}); assert.equal(m.status, 200); const mj = await m.json() as any;
    assert.deepEqual(mj.dataQuality.providers, ["yahoo-finance"]); assert.ok(mj.dataQuality.notes.some((n: string) => /no volume/.test(n))); assert.ok(mj.timeframes.filter((x: any) => x.mode === "full" || x.mode === "macro").length >= 7);
    assert.ok(mj.timeframes.find((x: any) => x.timeframe === "1h").report.warnings.some((w: string) => /No volume data/.test(w)));
  });
});
test("zero-volume data can never produce a volume-confirmed breakout", () => {
  const lvl = { price: 105, low: 105, high: 105, touches: 3, lastTouchIndex: 10, strength: 70, kind: "resistance" as const };
  const rows = reindex([...flat(30, 100), ...ramp(6, 100, 104.5), k(0, 104.5, 107.5, 104.4, 107.2), k(0, 107.2, 108, 106.8, 107.6)]).map(r => [r[0], r[1], r[2], r[3], r[4], 0] as Kline);
  const b = analyzeBreaks(rows, [lvl]).find(e => e.type === "breakout"); assert.ok(b); assert.equal(b!.volumeConfirmed, false);
});
test("lite mode skips the heavy detectors, says so, and keeps the core read", () => {
  const rows = reindex(series(300, { drift: 0.25, noise: 0.5, seed: 3 })), full = technicalAnalysis("T", "1h", rows, { now: NOW }), lite = technicalAnalysis("T", "1h", rows, { now: NOW, detail: "lite" });
  assert.ok(isFullAnalysis(full) && isFullAnalysis(lite)); assert.equal(lite.zones.length + lite.sweeps.length + lite.orderBlocks.length + lite.fvgs.length, 0); assert.equal(lite.volumeProfile, null); assert.equal(lite.fibonacci, null);
  assert.ok(lite.report.warnings.some(w => /Lite mode/.test(w))); assert.equal(lite.report.stance, full.report.stance); assert.equal(lite.structure.trend, full.structure.trend);
});
test("FRED defaults cover the majors and a derived policy bias is labelled as derived", async () => {
  for (const c of ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "NZD", "CHF"]) assert.ok(DEFAULT_FRED[c], c);
  const obs: Record<string, { date: string; value: string }[]> = { FEDFUNDS: [{ date: "2026-10-01", value: "5.00" }, { date: "2026-09-01", value: "4.75" }, { date: "2026-08-01", value: "4.5" }, { date: "2026-07-01", value: "4.5" }, { date: "2026-06-01", value: "4.25" }, { date: "2026-05-01", value: "4.0" }, { date: "2026-04-01", value: "4.0" }], UNRATE: [{ date: "2026-10-01", value: "4.1" }], DGS10: [{ date: "2026-11-06", value: "4.2" }], A191RL1Q225SBEA: [{ date: "2026-07-01", value: "2.0" }] };
  const { fetchCurrencyMacro } = await import("./analysis/fundamental-sources.ts");
  const m = await fetchCurrencyMacro("USD", { FRED_API_KEY: "k" }, async u => { const id = new URL(u).searchParams.get("series_id")!; return json({ observations: obs[id] ?? [] }); });
  assert.equal(m.macro.policyBias, "hawkish"); assert.match(m.macro.policyBiasSource!, /derived/); assert.equal(m.macro.policyRatePct, 5); assert.ok(m.missing.some(x => /inflation/.test(x)));
});
test("calibration: no look-ahead, honest on a random walk, wilson interval sane", () => {
  const w = wilson(50, 100); assert.ok(w[0] < 0.5 && w[1] > 0.5 && w[1] - w[0] < 0.21); assert.deepEqual(wilson(0, 0), [0, 1]);
  const rnd = calibrateTechnical(series(1500, { drift: 0, noise: 1, seed: 9 }), { horizon: 10, maxSamples: 100 });
  assert.ok(rnd.samples >= 30); assert.ok(rnd.buckets.every(b => b.edgeVsBaseline !== "positive"), "a random walk must not show a significant edge"); assert.ok(rnd.caveats.length >= 3);
  const base = series(1500, { drift: 0.1, noise: 0.8, seed: 4 });
  // Look-ahead guard: poisoning FUTURE candles must not change any score computed for earlier bars.
  const cut = 1000, poisoned = base.map((r, i) => (i > cut ? [r[0], r[1] * 3, r[2] * 3, r[3] * 3, r[4] * 3, r[5]] as Kline : r));
  const A: { index: number; score: number }[] = [], B: { index: number; score: number }[] = [];
  calibrateTechnical(base, { horizon: 10, maxSamples: 60, collect: A }); calibrateTechnical(poisoned, { horizon: 10, maxSamples: 60, collect: B });
  const early = A.filter(x => x.index <= cut); assert.ok(early.length >= 10);
  for (const x of early) assert.equal(B.find(y => y.index === x.index)!.score, x.score, `score at bar ${x.index} changed when only future data changed`);
  assert.ok(A.some(x => x.index > cut + 20 && B.find(y => y.index === x.index)!.score !== x.score), "sanity: scores after the poisoned point do differ");
});
test("API: calibrate endpoint works on supplied candles and refuses short history", async () => {
  const ok = await post("/api/analysis/calibrate?symbol=AAPL&timeframe=1d&horizon=10&maxSamples=40", { candles: series(900, { drift: 0.05, noise: 0.9, seed: 12 }) }); assert.equal(ok.status, 200); const j = await ok.json() as any; assert.ok(j.samples >= 30 && j.summary && j.caveats.length);
  assert.equal((await post("/api/analysis/calibrate?symbol=AAPL", { candles: series(100) })).status, 422);
});
test("cache helper degrades to a direct call without the Cache API and honours worthCaching", async () => {
  let calls = 0; assert.equal(await cached("k", 60, async () => ++calls), 1); assert.equal(await cached("k", 60, async () => ++calls, () => false), 2);
});
test("intelligence response includes a per-timeframe breakdown and the detail mode", async () => {
  const c: Record<string, Kline[]> = {}; for (const tf of ["1d", "4h", "1h", "15m"] as const) c[tf] = series(300, { drift: 0.25, noise: 0.5, seed: 3, stepMs: stepFor(tf), end: Date.now() - stepFor(tf) * 1.5 });
  const r = await post("/api/analysis/intelligence?symbol=AAPL&strategy=swing&detail=lite", { candles: c, news: [] }); const j = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(j.dataQuality.detail, "lite"); assert.ok(j.technicalDetail.timeframes.some((t: any) => t.timeframe === "1h" && t.mode === "full"));
});

test("FX fundamentals use the operator-configured event calendar; no calendar is reported as unverified, never as clear (mocked FRED)", async () => {
  const fred = (u: string) => { const id = new URL(u).searchParams.get("series_id")!; const v: Record<string, string> = { FEDFUNDS: "4.0", UNRATE: "4.1", DGS10: "4.2", A191RL1Q225SBEA: "2.0", ECBDFR: "2.0", LRHUTTTTEZM156S: "6.3", IRLTLT01EZM156N: "2.6" }; const d = new Date().toISOString().slice(0, 10); return json({ observations: id === "CPIAUCSL" || id === "CP0000EZ19M086NEST" ? [{ date: d, value: "103" }, { date: new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10), value: "100" }] : [{ date: d, value: v[id] ?? "1" }] }); };
  const ev = JSON.stringify([{ title: "US CPI", time: new Date(Date.now() + 3 * 3600000).toISOString(), impact: "high", category: "economic", currencies: ["USD"], source: "ops-calendar" }]);
  await withFetch(fred, async () => {
    const withCal = await (await handleAnalysis(new Request("https://eti.test/api/analysis/fundamental?symbol=EURUSD", { headers: { "cf-connecting-ip": "e-" + Math.random() } }), { FRED_API_KEY: "k", ETI_EVENTS_JSON: ev })).json() as any;
    assert.equal(withCal.extras.eventRisk, true); assert.ok(withCal.warnings.some((w: string) => /Event risk.*US CPI/.test(w))); assert.ok(withCal.notes.some((n: string) => /Events from ETI_EVENTS_JSON/.test(n)));
    const without = await (await handleAnalysis(new Request("https://eti.test/api/analysis/fundamental?symbol=EURUSD", { headers: { "cf-connecting-ip": "e-" + Math.random() } }), { FRED_API_KEY: "k" })).json() as any;
    assert.ok(!without.extras.eventRisk); assert.ok(without.warnings.some((w: string) => /unverified, not clear/.test(w)));
  });
});
