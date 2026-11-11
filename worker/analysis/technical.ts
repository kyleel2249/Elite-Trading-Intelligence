// Technical analysis engine: runs every detector on one timeframe and publishes a single EngineReport.
// Scoring is an explicit additive rubric (see WEIGHTS) so every point of the score is traceable to a finding.
import type { Kline } from "../market.ts";
import { atr14, lastAtr } from "./atr.ts";
import { detectCandlePatterns, type CandlePattern } from "./candlesticks.ts";
import { analyzeBreaks, analyzeStructure, detectTrendlines, findPivots, supplyDemandZones, supportResistance, type BreakEvent, type Level, type MarketStructure, type Trendline, type Zone } from "./structure.ts";
import { detectDisplacement, detectFVG, detectLiquiditySweeps, detectOrderBlocks, findLiquidityPools, ORDER_BLOCK_METHOD, type Displacement, type FairValueGap, type LiquidityPool, type LiquiditySweep, type OrderBlock } from "./smc.ts";
import { volumeProfile, type VolumeProfile } from "./volume-profile.ts";
import { analyzeFibonacci, type FibAnalysis } from "./fibonacci.ts";
import { analyzeMomentum, analyzeVolatility, relativeStrength, type MomentumAnalysis, type RelativeStrength, type VolatilityAnalysis } from "./momentum.ts";
import { clamp, round, stanceOf, unavailableReport, type EngineReport, type Finding, type Stance } from "./types.ts";

export const MIN_CANDLES = 60;
/** Only the most recent candles are analysed: structure older than this rarely changes the current read, and it bounds CPU per request. */
export const MAX_ANALYSED_CANDLES = 250;
export const WEIGHTS = { structure: 35, structureEvent: 10, momentum: 20, valueArea: 8, zone: 10, level: 6, breakout: 12, sweep: 8, candle: 8, orderBlock: 6, fvg: 4, trendline: 8, relativeStrength: 6 } as const;
export const TECHNICAL_METHOD = `Additive rubric (max |score| 100): structure ${WEIGHTS.structure}, structure events ${WEIGHTS.structureEvent}, momentum ${WEIGHTS.momentum}, value-area location ${WEIGHTS.valueArea}, supply/demand ${WEIGHTS.zone}, S/R ${WEIGHTS.level}, breakouts ${WEIGHTS.breakout}, liquidity sweeps ${WEIGHTS.sweep}, candlestick ${WEIGHTS.candle}, order blocks ${WEIGHTS.orderBlock}, FVG ${WEIGHTS.fvg}, trendlines ${WEIGHTS.trendline}, relative strength ${WEIGHTS.relativeStrength}. Confidence measures data sufficiency and component agreement, not the probability of profit. ${ORDER_BLOCK_METHOD}`;

export interface TechnicalAnalysis {
  symbol: string; timeframe: string; candles: number; price: number; lastCandleTime: number;
  structure: MarketStructure; levels: Level[]; zones: Zone[]; trendlines: Trendline[]; breaks: BreakEvent[];
  patterns: CandlePattern[]; displacement: Displacement[]; fvgs: FairValueGap[]; liquidityPools: LiquidityPool[]; sweeps: LiquiditySweep[]; orderBlocks: OrderBlock[];
  volumeProfile: VolumeProfile | null; fibonacci: FibAnalysis | null; momentum: MomentumAnalysis | null; volatility: VolatilityAnalysis | null; relativeStrength: RelativeStrength | null;
  report: EngineReport;
}
export interface TechnicalOptions { /** 'lite' skips zones, sweeps, order blocks, FVG, volume profile and Fibonacci to cut CPU (Workers Free plan). */ detail?: "full" | "lite"; benchmark?: { symbol: string; candles: Kline[] }; now?: number; maxStaleBars?: number; timeframeSeconds?: number }

export function technicalAnalysis(symbol: string, timeframe: string, allRows: Kline[], o: TechnicalOptions = {}): TechnicalAnalysis | { report: EngineReport } {
  const now = o.now ?? Date.now();
  const rows = allRows.length > MAX_ANALYSED_CANDLES ? allRows.slice(-MAX_ANALYSED_CANDLES) : allRows;
  if (rows.length < MIN_CANDLES) return { report: unavailableReport(`technical:${timeframe}`, "technical", symbol, `Only ${rows.length} candles for ${timeframe}; at least ${MIN_CANDLES} are required for structure analysis`, [`${timeframe} candles (${MIN_CANDLES - rows.length} more)`], now) };
  const price = rows.at(-1)![4], a = lastAtr(rows);
  const pivots = findPivots(rows), structure = analyzeStructure(rows, pivots), levels = supportResistance(rows, pivots), zones = o.detail === "lite" ? [] : supplyDemandZones(rows), trendlines = detectTrendlines(rows, pivots);
  const lite = o.detail === "lite";
  const breaks = analyzeBreaks(rows, levels), patterns = detectCandlePatterns(rows, 8);
  const displacement = lite ? [] : detectDisplacement(rows), fvgs = lite ? [] : detectFVG(rows);
  const sweeps = lite ? [] : detectLiquiditySweeps(rows, pivots), orderBlocks = lite ? [] : detectOrderBlocks(rows), pools = lite ? [] : findLiquidityPools(rows, pivots);
  const hasVolume = rows.some(r => r[5] > 0);
  const vp = lite || !hasVolume ? null : volumeProfile(rows), momentum = analyzeMomentum(rows), volatility = analyzeVolatility(rows);
  const fib = lite ? null : analyzeFibonacci(rows, pivots, [...levels.map(l => ({ label: `${l.kind} ${round(l.price, 4)}`, price: l.price })), ...(vp ? [{ label: `POC ${vp.poc}`, price: vp.poc }] : [])]);
  const rs = o.benchmark ? relativeStrength(rows, o.benchmark.candles, o.benchmark.symbol) : null;

  const findings: Finding[] = [], warnings: string[] = [], missing: string[] = [], parts: { name: string; v: number }[] = [];
  const add = (id: string, kind: string, stance: Stance, strength: number, description: string, pts: number, time?: number, data?: Record<string, unknown>) => { findings.push({ id, kind, stance, strength: Math.round(clamp(strength, 0, 100)), description, time, data }); if (pts) parts.push({ name: kind, v: pts }); };
  const n = rows.length - 1, recent = (i: number, bars = 10) => n - i <= bars;

  if (!hasVolume) warnings.push("No volume data (typical for spot FX): volume profile and volume-confirmed breakouts are unavailable");
  if (lite) warnings.push("Lite mode: supply/demand zones, liquidity sweeps, order blocks, FVG, volume profile and Fibonacci were skipped to save CPU");
  // 1. Structure
  const sPts = structure.trend === "uptrend" ? WEIGHTS.structure : structure.trend === "downtrend" ? -WEIGHTS.structure : 0;
  add("structure", "market_structure", structure.stance, Math.abs(sPts) / WEIGHTS.structure * 70 + 20, `${structure.trend}: ${structure.higherHighs} HH / ${structure.higherLows} HL vs ${structure.lowerHighs} LH / ${structure.lowerLows} LL in the last 6 labelled swings${structure.invalidationLevel ? `; invalidated by a close through ${round(structure.invalidationLevel, 4)}` : ""}`, sPts);
  const ev = structure.events.at(-1);
  if (ev && recent(ev.index, 15)) add("structure-event", ev.type, ev.direction === "bullish" ? "bullish" : "bearish", ev.type === "CHoCH" ? 65 : 50, ev.note, (ev.direction === "bullish" ? 1 : -1) * WEIGHTS.structureEvent * (ev.type === "CHoCH" ? 1 : 0.6), ev.time, { level: ev.level });
  // 2. Momentum
  if (momentum) {
    add("momentum", "momentum", stanceOf(momentum.score, 15), Math.abs(momentum.score), `Momentum ${momentum.state.replace("_", " ")}: RSI ${momentum.rsi}, MACD histogram ${momentum.macd.histogramTrend}, ROC10 ${momentum.roc10Pct}%`, momentum.score / 100 * WEIGHTS.momentum);
    if (momentum.divergence !== "none") add("rsi-divergence", "divergence", momentum.divergence === "bullish" ? "bullish" : "bearish", 45, `${momentum.divergence} RSI divergence: price extreme is not confirmed by momentum`, (momentum.divergence === "bullish" ? 1 : -1) * 3);
    if (momentum.overbought || momentum.oversold) warnings.push(`RSI ${momentum.rsi} is ${momentum.overbought ? "overbought" : "oversold"}: in strong trends this can persist, in ranges it favours mean reversion`);
  } else missing.push("momentum (needs >= 40 candles)");
  // 3. Value area
  if (vp) add("value-area", "volume_profile", vp.location === "above_value" ? "bullish" : vp.location === "below_value" ? "bearish" : "neutral", 40, `Price is ${vp.location.replace(/_/g, " ")} (POC ${vp.poc}, VAL ${vp.val}, VAH ${vp.vah}); ${vp.hvn.length} high-volume and ${vp.lvn.length} low-volume nodes`, vp.location === "above_value" ? WEIGHTS.valueArea : vp.location === "below_value" ? -WEIGHTS.valueArea : 0, undefined, { poc: vp.poc, vah: vp.vah, val: vp.val });
  // 4. Zones
  for (const z of zones) {
    const inside = price <= Math.max(z.proximal, z.distal) + 0.3 * a && price >= Math.min(z.proximal, z.distal) - 0.3 * a;
    if (!inside) continue;
    add(`zone-${z.kind}-${z.baseEnd}`, "supply_demand", z.kind === "demand" ? "bullish" : "bearish", z.fresh ? 65 : 40, `Price is at a ${z.fresh ? "fresh" : `tested (${z.tests}x)`} ${z.kind} zone ${round(Math.min(z.proximal, z.distal), 4)}-${round(Math.max(z.proximal, z.distal), 4)} (leg-out ${z.legOutAtr} ATR)`, (z.kind === "demand" ? 1 : -1) * WEIGHTS.zone * (z.fresh ? 1 : 0.5), z.time);
  }
  // 5. S/R proximity
  const nearest = levels[0];
  if (nearest && Math.abs(nearest.price - price) <= 0.6 * a) add("level", "support_resistance", nearest.kind === "support" ? "bullish" : "bearish", nearest.strength, `Price is within 0.6 ATR of ${nearest.kind} ${round(nearest.price, 4)} (${nearest.touches} touches)`, (nearest.kind === "support" ? 1 : -1) * WEIGHTS.level * nearest.strength / 100);
  // 6. Breaks (recent)
  const lastBreak = [...breaks].reverse().find(b => recent(b.index, 12));
  if (lastBreak) {
    const up = lastBreak.direction === "up";
    if (lastBreak.type === "breakout") add("break", "breakout", up ? "bullish" : "bearish", lastBreak.volumeConfirmed ? 70 : 45, lastBreak.note, (up ? 1 : -1) * WEIGHTS.breakout * (lastBreak.volumeConfirmed ? 1 : 0.6), lastBreak.time);
    else if (lastBreak.type === "false_breakout") add("break", "false_breakout", up ? "bearish" : "bullish", 60, `${lastBreak.note}: trapped ${up ? "buyers" : "sellers"} favour the opposite side`, (up ? -1 : 1) * WEIGHTS.breakout * 0.8, lastBreak.time);
    else add("break", lastBreak.type, lastBreak.type === "retest_hold" ? (up ? "bullish" : "bearish") : (up ? "bearish" : "bullish"), 60, lastBreak.note, (lastBreak.type === "retest_hold" ? 1 : -1) * (up ? 1 : -1) * WEIGHTS.breakout * 0.7, lastBreak.time);
  }
  // 7. Sweeps
  const sw = [...sweeps].reverse().find(s => recent(s.index, 8));
  if (sw) add("sweep", "liquidity_sweep", sw.direction === "bullish" ? "bullish" : "bearish", 55, sw.note, (sw.direction === "bullish" ? 1 : -1) * WEIGHTS.sweep, sw.time, { level: sw.level });
  // 8. Candle patterns: weighted up only when they occur at a level/zone (context), otherwise heavily discounted.
  const pat = [...patterns].filter(p => p.bias !== "neutral" && recent(p.index, 3)).sort((x, y) => y.strength - x.strength)[0];
  if (pat) {
    const atLevel = levels.some(l => Math.abs(l.price - rows[pat.index][4]) <= 0.7 * a) || zones.some(z => Math.abs((z.proximal + z.distal) / 2 - rows[pat.index][4]) <= 0.7 * a);
    add("candle", pat.name, pat.bias, pat.strength * (atLevel ? 1 : 0.5), `${pat.name.replace(/_/g, " ")}${atLevel ? " at a key level" : " away from any key level (low weight)"}: ${pat.note}`, (pat.bias === "bullish" ? 1 : -1) * WEIGHTS.candle * pat.strength / 100 * (atLevel ? 1 : 0.4), pat.time);
  }
  // 9. Order blocks / FVG at price
  const ob = orderBlocks.find(o2 => price >= o2.low - 0.2 * a && price <= o2.high + 0.2 * a);
  if (ob) add("order-block", `${ob.kind}_order_block`, ob.kind, ob.hasFVG ? 60 : 40, `Price is inside a ${ob.kind} order block ${round(ob.low, 4)}-${round(ob.high, 4)} (${ob.hasFVG ? "with" : "without"} imbalance, ${ob.touches} prior touches)`, (ob.kind === "bullish" ? 1 : -1) * WEIGHTS.orderBlock * (ob.hasFVG ? 1 : 0.6), ob.time);
  const fvg = fvgs.filter(f => f.status !== "filled").find(f => price >= f.low - 0.2 * a && price <= f.high + 0.2 * a);
  if (fvg) add("fvg", `${fvg.kind}_fvg`, fvg.kind, 40, `Price is interacting with an unfilled ${fvg.kind} fair value gap ${round(fvg.low, 4)}-${round(fvg.high, 4)} (${fvg.filledPct}% filled)`, (fvg.kind === "bullish" ? 1 : -1) * WEIGHTS.fvg, fvg.time);
  // 10. Trendlines
  for (const t of trendlines) {
    if (t.brokenAtIndex !== null && recent(t.brokenAtIndex, 12)) add(`tl-${t.kind}-break`, "trendline_break", t.kind === "support" ? "bearish" : "bullish", 55, `${t.kind} trendline (${t.touches} touches) was broken by a close`, (t.kind === "support" ? -1 : 1) * WEIGHTS.trendline, rows[t.brokenAtIndex][0]);
    else if (t.brokenAtIndex === null && Math.abs(price - t.projectedNow) <= 0.6 * a) add(`tl-${t.kind}`, "trendline_test", t.kind === "support" ? "bullish" : "bearish", 45, `Price is testing a ${t.kind} trendline (${t.touches} touches) at ${round(t.projectedNow, 4)}`, (t.kind === "support" ? 1 : -1) * WEIGHTS.trendline * 0.6);
  }
  // 11. Relative strength
  if (rs) add("rs", "relative_strength", rs.state === "outperforming" ? "bullish" : rs.state === "underperforming" ? "bearish" : "neutral", Math.min(80, Math.abs(rs.excessReturnPct) * 4 + 20), `${rs.state.replace("_", " ")} ${rs.benchmark}: ${rs.assetReturnPct}% vs ${rs.benchmarkReturnPct}% over ${rs.periodBars} bars`, rs.state === "outperforming" ? WEIGHTS.relativeStrength : rs.state === "underperforming" ? -WEIGHTS.relativeStrength : 0);
  else missing.push(o.benchmark ? "relative strength (insufficient aligned benchmark candles)" : "relative strength (no benchmark supplied)");
  // Descriptive-only findings
  if (fib) add("fib", "fibonacci", "neutral", fib.inGoldenPocket ? 50 : 25, `Retracement of the latest ${fib.direction.replace("_", " ")} is ${fib.currentRetracement}${fib.nearest?.confluence.length ? `; nearest ${fib.nearest.kind} ${fib.nearest.ratio} coincides with ${fib.nearest.confluence.join(", ")}` : ""}`, 0, undefined, { golden: fib.inGoldenPocket });
  if (volatility) add("vol", "volatility", "neutral", 30, `${volatility.regime}: ATR ${volatility.atrPct}% (${volatility.atrPercentile}th percentile). ${volatility.note}`, 0);

  const score = clamp(parts.reduce((s, p) => s + p.v, 0), -100, 100), sign = Math.sign(score);
  const agree = parts.length ? parts.filter(p => Math.sign(p.v) === sign && sign !== 0).length / parts.length : 0;
  const lastAge = (now - rows.at(-1)![0]) / 1000, tfs = o.timeframeSeconds ?? 0;
  if (tfs > 0 && lastAge > tfs * (o.maxStaleBars ?? 3)) warnings.push(`Latest candle is ${Math.round(lastAge)}s old (> ${o.maxStaleBars ?? 3} bars): data may be stale`);
  if (parts.some(p => p.v > 0) && parts.some(p => p.v < 0)) {
    const pos = parts.filter(p => p.v > 0).reduce((s, p) => s + p.v, 0), neg = -parts.filter(p => p.v < 0).reduce((s, p) => s + p.v, 0);
    if (Math.min(pos, neg) >= 0.4 * Math.max(pos, neg) && Math.min(pos, neg) >= 15) warnings.push(`Evidence is mixed: ${round(pos, 0)} bullish points vs ${round(neg, 0)} bearish points`);
  }
  const conf = clamp(30 + Math.min(rows.length, 300) / 300 * 20 + agree * 35 + (volatility?.regime === "normal" ? 5 : 0) - warnings.length * 5, 0, 100);
  const stance = stanceOf(score);
  const report: EngineReport = { engine: `technical:${timeframe}`, domain: "technical", subject: symbol, stance, score: round(score), confidence: round(conf, 0), confidenceType: "evidence_quality_not_probability", status: missing.length > 1 ? "partial" : "ok",
    completeness: round(Math.max(0, 1 - missing.length / 4 - (lite ? 0.2 : 0)), 2), findings, warnings, missing, sources: [{ name: `${timeframe} OHLCV candles`, retrievedAt: new Date(now).toISOString() }], asOf: new Date(rows.at(-1)![0]).toISOString(), methodology: TECHNICAL_METHOD };
  return { symbol, timeframe, candles: rows.length, price, lastCandleTime: rows.at(-1)![0], structure, levels, zones, trendlines, breaks, patterns, displacement, fvgs, liquidityPools: pools, sweeps, orderBlocks, volumeProfile: vp, fibonacci: fib, momentum, volatility, relativeStrength: rs, report };
}
export const isFullAnalysis = (x: TechnicalAnalysis | { report: EngineReport }): x is TechnicalAnalysis => "structure" in x;
