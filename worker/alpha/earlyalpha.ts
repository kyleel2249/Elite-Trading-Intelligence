/**
 * ETI Early Alpha Detection Engine (candle-based factors + optional external evidence).
 *
 * The score is a 0-100 ranking aid, NOT a probability and NOT a buy signal. Factors whose data is not
 * connected (fundamentals, institutional, on-chain, catalysts) are reported as unavailable and excluded
 * from the weighted mean; `evidenceCoverage` says how much of the model was actually evidenced.
 */
import type { Kline } from "../market.ts";
import { INTERVAL_SECONDS } from "../market.ts";
import type { AssetClass, ExternalInputs, Factor, Stage } from "./types.ts";
import { adLine, adxSeries, atrAt, clamp, emaSeries, mean, normSlope, percentRank, round, rsiSeries, slope, stdev, sum } from "./indicators.ts";

export const MIN_BARS = 120;

/** Asset-class specific weights. Sum to 1 within each class. */
export const WEIGHTS: Record<AssetClass, Record<string, number>> = {
  crypto: { accumulation: 0.20, volumeAnomaly: 0.14, momentum: 0.10, relativeStrength: 0.10, contraction: 0.08, liquidity: 0.10, regime: 0.06, onchain: 0.12, institutional: 0.04, catalyst: 0.04, valuation: 0.02 },
  equity: { accumulation: 0.18, volumeAnomaly: 0.10, momentum: 0.10, relativeStrength: 0.14, contraction: 0.08, liquidity: 0.08, regime: 0.06, onchain: 0.00, institutional: 0.12, catalyst: 0.08, valuation: 0.06 },
};

export interface EarlyAlphaResult {
  score: number; evidenceCoverage: number; stage: Stage; stageBias: "bullish" | "risk" | "none"; stageReasons: string[];
  factors: Factor[]; uncertainty: string; barsUsed: number;
  metrics: { price: number; atr14: number; adx14: number; volumeRatio20: number; dollarVolume24h: number; bbWidthPercentile: number; distanceTo20High: number; zeroVolumeShare: number };
}

const upDownVolume = (rows: Kline[]) => {
  let up = 0, down = 0; rows.forEach((r, i) => { if (r[4] > r[1]) up += r[5]; else if (r[4] < r[1]) down += r[5]; else if (i > 0 && r[4] >= rows[i - 1][4]) up += r[5] * 0.5; else down += r[5] * 0.5; });
  return down > 0 ? up / down : up > 0 ? 9.99 : 1;
};

export function dollarVolume24h(rows: Kline[], interval: string): number {
  const sec = INTERVAL_SECONDS[interval] ?? 3600, bars = Math.max(1, Math.min(rows.length, Math.round(86400 / sec)));
  return sum(rows.slice(-bars).map(r => r[4] * r[5]));
}

export function liquidityScore(usd24h: number, cls: AssetClass): number {
  const t = cls === "crypto" ? [250e3, 1e6, 10e6, 100e6] : [1e6, 5e6, 25e6, 250e6];
  return usd24h < t[0] ? 0 : usd24h < t[1] ? 0.3 : usd24h < t[2] ? 0.6 : usd24h < t[3] ? 0.85 : 1;
}

/** Aligns benchmark closes to candle open times and returns log-return differences over `look` bars. */
function relativeStrength(rows: Kline[], bench: Kline[] | undefined, look: number): { score: number; evidence: string } | null {
  if (!bench || bench.length < look + 2) return null;
  const bm = new Map(bench.map(b => [b[0], b[4]]));
  const aligned = rows.filter(r => bm.has(r[0])); if (aligned.length < look + 2) return null;
  const a = aligned.slice(-(look + 1)), a0 = a[0], a1 = a[a.length - 1];
  const ra = Math.log(a1[4] / a0[4]), rb = Math.log(bm.get(a1[0])! / bm.get(a0[0])!);
  const diff = ra - rb;
  // trend of the ratio over the window: is relative strength improving?
  const ratio = aligned.slice(-(look + 1)).map(r => r[4] / bm.get(r[0])!);
  const sl = normSlope(ratio);
  const s = clamp(0.5 + diff * 2.5 + sl * look * 1.5, 0, 1);
  return { score: s, evidence: "return vs benchmark over " + look + " bars: " + round(diff * 100, 1) + " pts (ratio slope " + round(sl * look * 100, 1) + "%)" };
}

export function analyseEarlyAlpha(rows: Kline[], opts: { assetClass: AssetClass; interval: string; benchmark?: Kline[]; external?: ExternalInputs }): EarlyAlphaResult | null {
  const n = rows.length; if (n < MIN_BARS) return null;
  const { assetClass: cls, interval } = opts;
  const closes = rows.map(r => r[4]), vols = rows.map(r => r[5]), price = closes[n - 1];
  const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50), e200 = emaSeries(closes, 200);
  const atr14 = atrAt(rows, 14), adxs = adxSeries(rows), adx14 = adxs.adx[n - 1];
  const hi20 = Math.max(...rows.slice(-21, -1).map(r => r[2])), lo20 = Math.min(...rows.slice(-21, -1).map(r => r[3]));
  const volBase = mean(vols.slice(-21, -1)), volumeRatio20 = volBase > 0 ? vols[n - 1] / volBase : 0;
  const zeroVolumeShare = rows.slice(-60).filter(r => r[5] === 0).length / 60;
  const usd24 = dollarVolume24h(rows, interval);
  const rsis = rsiSeries(closes);

  // ---- accumulation
  const w = rows.slice(-30), ad = adLine(rows).slice(-30), adS = slope(ad) / (mean(vols.slice(-30)) || 1);
  const priceFlat = Math.abs(normSlope(w.map(r => r[4]))) * 30 < 0.06;
  const udv = upDownVolume(w);
  const closePos = mean(w.map(r => (r[2] - r[3]) > 0 ? (r[4] - r[3]) / (r[2] - r[3]) : 0.5));
  const lows = rows.slice(-30).map(r => r[3]), halves = [Math.min(...lows.slice(0, 15)), Math.min(...lows.slice(15))];
  const higherLows = halves[1] > halves[0];
  const accSub = [clamp(0.5 + adS * 1.5), clamp((udv - 0.8) / 0.8), clamp((closePos - 0.4) / 0.3), higherLows ? 1 : 0.2];
  const accScore = clamp(mean(accSub) * (priceFlat ? 1.1 : 1));
  const accumulation: Factor = { id: "accumulation", label: "Accumulation evidence", weight: 0, score: round(accScore, 3), evidence: [
    "A/D line slope " + (adS >= 0 ? "rising" : "falling") + ", up/down volume " + round(udv, 2) + ", avg close position " + round(closePos * 100, 0) + "% of bar range",
    higherLows ? "higher lows over the last 30 bars" : "no higher-low structure", priceFlat ? "price is consolidating (flat) while this is measured" : "price is trending while this is measured"] };

  // ---- volume anomaly (quality-adjusted: volume that comes with selling is not demand)
  const lv = vols.slice(-65, -5).map(v => Math.log(v + 1)), m5 = mean(vols.slice(-5)), sd = stdev(lv);
  const z = sd > 0 ? (Math.log(m5 + 1) - mean(lv)) / (sd / Math.sqrt(5)) : 0;
  const last5 = rows.slice(-5), spike = sum(last5.map(r => r[5])) > 0 ? Math.max(...last5.map(r => r[5])) / sum(last5.map(r => r[5])) : 1;
  const upShare = (() => { const u = sum(last5.filter(r => r[4] >= r[1]).map(r => r[5])), t = sum(last5.map(r => r[5])); return t > 0 ? u / t : 0; })();
  const volScore = clamp(z / 4) * (0.4 + 0.6 * upShare) * (spike > 0.8 ? 0.5 : 1);
  const volumeAnomaly: Factor = { id: "volumeAnomaly", label: "Volume anomaly", weight: 0, score: round(volScore, 3), evidence: [
    "5-bar volume z-score " + round(z, 2) + " vs the prior 60 bars; " + round(upShare * 100, 0) + "% of it on up bars",
    spike > 0.8 ? "single-print dominated (" + round(spike * 100, 0) + "% in one bar): discounted as a possible one-off or artificial print" : "volume is spread across bars"] };

  // ---- momentum improvement
  const r = rsis[n - 1], r10 = rsis[n - 11];
  const macdLine = emaSeries(closes, 12).map((v, i) => v - emaSeries(closes, 26)[i]);
  const macdSig = emaSeries(macdLine, 9), hist = macdLine.map((v, i) => v - macdSig[i]);
  const histRising = hist[n - 1] > hist[n - 2] && hist[n - 2] > hist[n - 3];
  const roc20 = closes[n - 1] / closes[n - 21] - 1;
  const momScore = clamp(mean([clamp((r - r10 + 10) / 25), histRising ? 1 : 0.25, clamp((roc20 + 0.05) / 0.15), r > 75 ? 0.2 : 1]));
  const momentum: Factor = { id: "momentum", label: "Momentum improvement", weight: 0, score: round(momScore, 3), evidence: ["RSI " + round(r, 1) + " (10 bars ago " + round(r10, 1) + ")", "MACD histogram " + (histRising ? "rising for 3 bars" : "not rising"), "20-bar return " + round(roc20 * 100, 1) + "%"] };

  // ---- relative strength (needs a benchmark)
  const rs = relativeStrength(rows, opts.benchmark, 30);
  const relStrength: Factor = { id: "relativeStrength", label: "Relative strength", weight: 0, score: rs ? round(rs.score, 3) : null, evidence: [rs ? rs.evidence : "no aligned benchmark candles supplied; not scored"] };

  // ---- volatility contraction
  const widths: number[] = []; for (let i = 20; i <= n; i++) { const s = closes.slice(i - 20, i), m = mean(s); widths.push(m > 0 ? 4 * stdev(s) / m : 0); }
  const pr = percentRank(widths.slice(-120), widths[widths.length - 1]);
  const atrRatio = atrAt(rows, 10) / atrAt(rows, 50);
  const conScore = clamp(mean([1 - pr, clamp((1.1 - atrRatio) / 0.5)]));
  const contraction: Factor = { id: "contraction", label: "Volatility contraction", weight: 0, score: round(conScore, 3), evidence: ["Bollinger width at the " + round(pr * 100, 0) + "th percentile of the last 120 bars", "ATR10/ATR50 = " + round(atrRatio, 2)] };

  // ---- liquidity
  const liqS = liquidityScore(usd24, cls) * (zeroVolumeShare > 0.1 ? 0.5 : 1);
  const liquidity: Factor = { id: "liquidity", label: "Liquidity", weight: 0, score: round(liqS, 3), evidence: ["approx. 24h traded value " + Math.round(usd24).toLocaleString("en-US") + " (quote units)", zeroVolumeShare > 0.1 ? round(zeroVolumeShare * 100, 0) + "% of recent bars have zero volume: thin market" : "no zero-volume gaps"] };

  // ---- regime
  const aboveLong = price > e200[n - 1] && e200[n - 1] > e200[n - 21];
  const regScore = clamp((aboveLong ? 0.5 : 0.15) + (adx14 >= 25 ? 0.3 : adx14 >= 20 ? 0.2 : 0.1) + (price > e50[n - 1] ? 0.2 : 0));
  const regime: Factor = { id: "regime", label: "Market regime fit", weight: 0, score: round(regScore, 3), evidence: ["price " + (aboveLong ? "above a rising" : "not above a rising") + " 200-bar EMA", "ADX " + round(adx14, 1)] };

  const ext = (id: string, label: string, e?: { score: number; evidence: string[] }): Factor => ({ id, label, weight: 0, score: e ? round(clamp(e.score), 3) : null, evidence: e ? e.evidence : ["data source for this factor is not connected or returned nothing; not scored"] });
  const factors: Factor[] = [accumulation, volumeAnomaly, momentum, relStrength, contraction, liquidity, regime,
    ext("onchain", "On-chain intelligence", opts.external?.onchain), ext("institutional", "Institutional activity", opts.external?.institutional),
    ext("catalyst", "Fundamental catalysts", opts.external?.catalyst), ext("valuation", "Valuation", opts.external?.valuation)];
  const W = WEIGHTS[cls]; factors.forEach(f => { f.weight = W[f.id] ?? 0; });
  const used = factors.filter(f => f.weight > 0 && f.score !== null), totalW = sum(factors.map(f => f.weight)), usedW = sum(used.map(f => f.weight));
  const score = usedW > 0 ? round(100 * sum(used.map(f => f.weight * (f.score as number))) / usedW, 1) : 0;
  const coverage = totalW > 0 ? round(usedW / totalW, 2) : 0;

  // ---- stage
  const bbPct = pr, distHigh = (hi20 - price) / price, ext20 = (price - e20[n - 1]) / (atr14 || 1);
  const stage = classifyStage({ rows, closes, e20, e50, e200, atr14, adx14, hi20, lo20, volumeRatio20, rsis, bbPct, udv, adSlope: adS, distHigh, ext20, priceFlat, higherLows });
  const uncertainty = coverage < 0.5 ? "Only " + Math.round(coverage * 100) + "% of the model is evidenced (no fundamentals/on-chain/institutional inputs): treat as a technical early-warning only." : "Heuristic ranking score; not a probability of price movement.";
  return { score, evidenceCoverage: coverage, stage: stage.stage, stageBias: stage.bias, stageReasons: stage.reasons, factors, uncertainty, barsUsed: n,
    metrics: { price, atr14: round(atr14, 8), adx14: round(adx14, 1), volumeRatio20: round(volumeRatio20, 2), dollarVolume24h: Math.round(usd24), bbWidthPercentile: round(bbPct * 100, 0), distanceTo20High: round(distHigh * 100, 2), zeroVolumeShare: round(zeroVolumeShare, 3) } };
}

interface StageCtx { rows: Kline[]; closes: number[]; e20: number[]; e50: number[]; e200: number[]; atr14: number; adx14: number; hi20: number; lo20: number; volumeRatio20: number; rsis: number[]; bbPct: number; udv: number; adSlope: number; distHigh: number; ext20: number; priceFlat: boolean; higherLows: boolean }

/** Deterministic precedence: risk stages first, then confirmed trends, then early stages. */
export function classifyStage(c: StageCtx): { stage: Stage; bias: "bullish" | "risk" | "none"; reasons: string[] } {
  const n = c.rows.length, price = c.closes[n - 1], last = c.rows[n - 1];
  const hi60 = Math.max(...c.rows.slice(-60).map(r => r[2])), nearHigh60 = (hi60 - price) / hi60 <= 0.08;
  const recent = c.rows.slice(-10), crossedDown = c.e20[n - 1] < c.e50[n - 1] && c.e20.slice(-11, -1).some((v, i) => v >= c.e50[n - 11 + i]);
  const brokeLow = price < c.lo20 && c.volumeRatio20 >= 1.2;
  if (crossedDown && price < c.e50[n - 1] || brokeLow) return { stage: "REVERSAL_RISK", bias: "risk", reasons: [brokeLow ? "close below the prior 20-bar low on elevated volume" : "EMA20 crossed below EMA50 and price is below EMA50"] };
  const rsiHighNow = c.rsis[n - 1], rsiPrev = Math.max(...c.rsis.slice(-25, -5).filter(Number.isFinite));
  const priceHighNow = price >= Math.max(...c.closes.slice(-20)) * 0.995, priorHigh = Math.max(...c.closes.slice(-25, -5));
  const bearDiv = priceHighNow && price > priorHigh && rsiHighNow < rsiPrev - 3;
  if (c.ext20 > 3.5 || rsiHighNow > 78 || (bearDiv && c.adx14 >= 25)) return { stage: "MOMENTUM_EXHAUSTION", bias: "risk", reasons: [c.ext20 > 3.5 ? "price is " + round(c.ext20, 1) + " ATR above EMA20" : bearDiv ? "price made a new high while RSI did not (bearish divergence)" : "RSI " + round(rsiHighNow, 1) + " is overheated"] };
  if (nearHigh60 && c.adSlope < 0 && c.udv < 0.9 && c.closes[n - 1] <= c.e20[n - 1] * 1.03) return { stage: "DISTRIBUTION", bias: "risk", reasons: ["price within 8% of its 60-bar high while the A/D line falls and up/down volume is " + round(c.udv, 2)] };
  const aligned = price > c.e20[n - 1] && c.e20[n - 1] > c.e50[n - 1] && c.e50[n - 1] > c.e200[n - 1];
  const brokeRecently = c.rows.slice(-10).some((r, i) => r[4] > Math.max(...c.rows.slice(n - 10 + i - 20, n - 10 + i).map(x => x[2])));
  if (aligned && c.adx14 >= 25 && brokeRecently) return { stage: "TREND_EXPANSION", bias: "bullish", reasons: ["EMAs aligned up, ADX " + round(c.adx14, 1) + " >= 25 and a recent 20-bar breakout"] };
  const rng = last[2] - last[3], closeUpper = rng > 0 ? (last[4] - last[3]) / rng >= 0.7 : false;
  const brk = c.rows.slice(-3).some((r, i) => r[4] > Math.max(...c.rows.slice(n - 3 + i - 20, n - 3 + i).map(x => x[2])));
  if (brk && c.volumeRatio20 >= 1.5 && closeUpper) return { stage: "BREAKOUT_CONFIRMATION", bias: "bullish", reasons: ["close above the prior 20-bar high within 3 bars on " + round(c.volumeRatio20, 2) + "x volume, closing in the upper 30% of the bar"] };
  if (c.distHigh <= Math.max(0.03, 1.5 * c.atr14 / price) && c.distHigh >= 0 && c.bbPct <= 0.3 && c.higherLows) return { stage: "BREAKOUT_FORMATION", bias: "bullish", reasons: ["within " + round(c.distHigh * 100, 1) + "% of the 20-bar high with contracted volatility (" + round(c.bbPct * 100, 0) + "th pct) and higher lows"] };
  const w40 = c.rows.slice(-40), hiR = Math.max(...w40.map(r => r[2])), loR = Math.min(...w40.map(r => r[3])), widthPct = (hiR - loR) / loR;
  if (widthPct <= 0.2 && c.adSlope > 0 && c.udv >= 1.1 && price >= loR + (hiR - loR) / 3) return { stage: "EARLY_ACCUMULATION", bias: "bullish", reasons: ["tight 40-bar range (" + round(widthPct * 100, 1) + "%) with rising A/D line and up/down volume " + round(c.udv, 2)] };
  const lowRecent = Math.min(...c.rows.slice(-20).map(r => r[3])), lowPrior = Math.min(...c.rows.slice(-60, -20).map(r => r[3]));
  if (price < c.e200[n - 1] && lowRecent >= lowPrior && c.bbPct <= 0.5) return { stage: "PRE_ACCUMULATION", bias: "bullish", reasons: ["below the 200-bar EMA but no new 60-bar low in the last 20 bars and volatility is contracting"] };
  return { stage: "NONE", bias: "none", reasons: ["no early-stage pattern met its documented rule"] };
}
