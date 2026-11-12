import type { Kline } from "../market.ts";
import { adxSeries, adaptiveBands, atrSeries, emaFilter, volatility, volumeMomentum } from "./indicators.ts";

export type Regime =
  | "strong_bullish_trend" | "strong_bearish_trend" | "weak_bullish_trend" | "weak_bearish_trend"
  | "ranging" | "high_volatility" | "low_volatility" | "breakout" | "potential_reversal" | "abnormal";

export interface RegimeResult {
  regime: Regime; confidence: number; adx: number; reasons: string[];
  /** Strategy parameters adapted to this regime. */
  profile: { stopMult: number; exposureScale: number; allowNewEntries: boolean; preferred: "trend" | "range_reversal" | "breakout" | "defensive" | "none"; minConfirmations: number };
}

const PROFILES: Record<Regime, RegimeResult["profile"]> = {
  strong_bullish_trend: { stopMult: 1.5, exposureScale: 1, allowNewEntries: true, preferred: "trend", minConfirmations: 3 },
  strong_bearish_trend: { stopMult: 1.5, exposureScale: 1, allowNewEntries: true, preferred: "trend", minConfirmations: 3 },
  weak_bullish_trend: { stopMult: 1.5, exposureScale: 0.7, allowNewEntries: true, preferred: "trend", minConfirmations: 4 },
  weak_bearish_trend: { stopMult: 1.5, exposureScale: 0.7, allowNewEntries: true, preferred: "trend", minConfirmations: 4 },
  ranging: { stopMult: 1.2, exposureScale: 0.6, allowNewEntries: true, preferred: "range_reversal", minConfirmations: 4 },
  high_volatility: { stopMult: 2.0, exposureScale: 0.5, allowNewEntries: true, preferred: "defensive", minConfirmations: 4 },
  low_volatility: { stopMult: 1.2, exposureScale: 0.8, allowNewEntries: true, preferred: "breakout", minConfirmations: 4 },
  breakout: { stopMult: 1.6, exposureScale: 0.8, allowNewEntries: true, preferred: "breakout", minConfirmations: 4 },
  potential_reversal: { stopMult: 1.8, exposureScale: 0.5, allowNewEntries: true, preferred: "defensive", minConfirmations: 5 },
  abnormal: { stopMult: 2.5, exposureScale: 0, allowNewEntries: false, preferred: "none", minConfirmations: 99 },
};

export const MIN_REGIME_CANDLES = 100;
export function classifyRegime(rows: Kline[]): RegimeResult {
  const reasons: string[] = [];
  const out = (regime: Regime, confidence: number, adx: number): RegimeResult => ({ regime, confidence: Math.round(confidence), adx, reasons, profile: PROFILES[regime] });
  if (rows.length < MIN_REGIME_CANDLES) { reasons.push(`Need at least ${MIN_REGIME_CANDLES} candles, received ${rows.length}`); return out("abnormal", 90, NaN); }
  const atr = atrSeries(rows), a = atr.at(-1)!, price = rows.at(-1)![4];
  const adx = adxSeries(rows).adx.at(-1)!;
  if (!Number.isFinite(a) || !Number.isFinite(adx)) { reasons.push("Insufficient history for ATR/ADX"); return out("abnormal", 90, NaN); }
  const vol = volatility(rows), ef = emaFilter(rows, [20, 50, 200], a), bands = adaptiveBands(rows), vm = volumeMomentum(rows);
  const last = rows.at(-1)!, lastRange = last[2] - last[3];
  // Abnormal: a single bar many ATRs wide, zero-volume run, or non-finite data.
  const zeroVol = rows.slice(-10).filter(r => r[5] === 0).length;
  if (lastRange > a * 6 || zeroVol >= 3 || vol.classification === "extreme" && vm.unusualVolume && vol.expansion) {
    reasons.push(lastRange > a * 6 ? "Last bar range exceeds 6x ATR" : zeroVol >= 3 ? "Multiple zero-volume bars" : "Extreme volatility with unusual volume spike");
    return out("abnormal", 85, adx);
  }
  const hh = Math.max(...rows.slice(-21, -1).map(r => r[2])), ll = Math.min(...rows.slice(-21, -1).map(r => r[3]));
  if ((price > hh || price < ll) && vm.relativeVolume >= 1.3 && vol.expansion) { reasons.push("Close beyond prior 20-bar range with volume and volatility expansion"); return out("breakout", 70 + Math.min(20, vm.relativeVolume * 5), adx); }
  if (bands.flipped && bands.reversalConfirmed) { reasons.push("Adaptive band flipped with volume/EMA-slope confirmation"); return out("potential_reversal", 65, adx); }
  if (vol.classification === "high" || vol.classification === "extreme") { reasons.push(`ATR percentile ${(vol.percentile * 100).toFixed(0)}`); return out("high_volatility", 60 + vol.percentile * 30, adx); }
  if (adx >= 25 && ef.alignment !== "mixed") {
    reasons.push(`ADX ${adx.toFixed(1)} with ${ef.alignment} EMA alignment`);
    const strong = adx >= 35 || ef.strength >= 70;
    return out(ef.alignment === "bull" ? (strong ? "strong_bullish_trend" : "weak_bullish_trend") : (strong ? "strong_bearish_trend" : "weak_bearish_trend"), Math.min(95, adx * 2), adx);
  }
  if (adx >= 20 && ef.alignment !== "mixed") { reasons.push(`Moderate ADX ${adx.toFixed(1)}`); return out(ef.alignment === "bull" ? "weak_bullish_trend" : "weak_bearish_trend", 55, adx); }
  if (adx < 20 && vol.classification === "low") { reasons.push("Low ADX and compressed ATR"); return out("low_volatility", 65, adx); }
  reasons.push(`ADX ${adx.toFixed(1)} below trend threshold${bands.choppy ? "; band flips are frequent" : ""}`);
  return out("ranging", 60 + (bands.choppy ? 15 : 0), adx);
}
