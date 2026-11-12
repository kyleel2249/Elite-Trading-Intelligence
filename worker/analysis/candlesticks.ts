// Candlestick formation detector. Patterns are context-qualified: a hammer is only a bullish reversal after a decline.
// Methodology (all thresholds are explicit constants below). Patterns describe price behaviour, not predictions.
import type { Kline } from "../market.ts";
import { atr14, lastAtr } from "./atr.ts";
import { clamp, round, type Stance } from "./types.ts";

export type PatternName = "doji" | "hammer" | "hanging_man" | "inverted_hammer" | "shooting_star" | "bullish_engulfing" | "bearish_engulfing"
  | "bullish_harami" | "bearish_harami" | "piercing_line" | "dark_cloud_cover" | "morning_star" | "evening_star" | "three_white_soldiers"
  | "three_black_crows" | "bullish_marubozu" | "bearish_marubozu" | "inside_bar" | "tweezer_top" | "tweezer_bottom";
export interface CandlePattern { index: number; time: number; name: PatternName; bias: Stance; strength: number; priorTrend: "up" | "down" | "flat"; note: string }

export const CANDLE_RULES = {
  dojiBody: 0.1,          // body <= 10% of range
  longWick: 2,            // reversal wick >= 2x body
  smallWick: 0.35,        // opposite wick <= 35% of the long wick
  marubozuBody: 0.9,      // body >= 90% of range
  trendLookback: 6,       // bars used to judge the preceding move
  trendAtr: 1.0,          // preceding move must exceed 1 ATR to count as a trend
  tweezerTol: 0.1,        // highs/lows within 0.1 ATR
  minRangeAtr: 0.3,       // ignore candles smaller than 0.3 ATR (noise)
} as const;

const body = (r: Kline) => Math.abs(r[4] - r[1]);
const range = (r: Kline) => r[2] - r[3];
const upW = (r: Kline) => r[2] - Math.max(r[1], r[4]);
const loW = (r: Kline) => Math.min(r[1], r[4]) - r[3];
const bull = (r: Kline) => r[4] > r[1];
const bear = (r: Kline) => r[4] < r[1];

function priorTrend(rows: Kline[], i: number, atr: number): "up" | "down" | "flat" {
  const lb = CANDLE_RULES.trendLookback;
  if (i < lb || !(atr > 0)) return "flat";
  const move = rows[i - 1][4] - rows[i - lb][4];
  return move > CANDLE_RULES.trendAtr * atr ? "up" : move < -CANDLE_RULES.trendAtr * atr ? "down" : "flat";
}

/** Detect patterns on the last `window` completed candles. Returns patterns oldest-first. */
export function detectCandlePatterns(rows: Kline[], window = 10): CandlePattern[] {
  const out: CandlePattern[] = [];
  if (rows.length < 20) return out;
  const atr = atr14(rows);
  const volMean = rows.slice(-60).reduce((s, r) => s + r[5], 0) / Math.min(60, rows.length) || 1;
  for (let i = Math.max(3, rows.length - window); i < rows.length; i++) {
    const c = rows[i], p = rows[i - 1], pp = rows[i - 2], a = Number.isFinite(atr[i]) ? atr[i] : atr.filter(Number.isFinite).at(-1) ?? 0;
    if (!(a > 0) || range(c) < CANDLE_RULES.minRangeAtr * a) continue;
    const trend = priorTrend(rows, i, a), R = range(c), B = body(c);
    // Strength = size relative to ATR + volume participation, bounded 0-100. Context-qualified patterns start higher.
    const size = clamp((R / a) * 25, 0, 40), vol = clamp((c[5] / volMean) * 20, 0, 30);
    const add = (name: PatternName, bias: Stance, base: number, note: string) =>
      out.push({ index: i, time: c[0], name, bias, strength: Math.round(clamp(base + size * 0.5 + vol * 0.5, 0, 100)), priorTrend: trend, note });

    if (B <= CANDLE_RULES.dojiBody * R) add("doji", "neutral", 25, "Indecision: open and close nearly equal");
    const longLo = loW(c) >= CANDLE_RULES.longWick * Math.max(B, R * 0.02) && upW(c) <= CANDLE_RULES.smallWick * loW(c) && B > CANDLE_RULES.dojiBody * R * 0.3;
    const longUp = upW(c) >= CANDLE_RULES.longWick * Math.max(B, R * 0.02) && loW(c) <= CANDLE_RULES.smallWick * upW(c) && B > CANDLE_RULES.dojiBody * R * 0.3;
    if (longLo && trend === "down") add("hammer", "bullish", 40, "Long lower wick after a decline: sellers rejected at lows");
    if (longLo && trend === "up") add("hanging_man", "bearish", 30, "Long lower wick after an advance: needs bearish confirmation");
    if (longUp && trend === "down") add("inverted_hammer", "bullish", 25, "Long upper wick after a decline: needs bullish confirmation");
    if (longUp && trend === "up") add("shooting_star", "bearish", 40, "Long upper wick after an advance: buyers rejected at highs");
    const pb = body(p);
    if (bull(c) && bear(p) && c[4] >= p[1] && c[1] <= p[4] && B > pb && trend === "down") add("bullish_engulfing", "bullish", 50, "Bullish body engulfs prior bearish body after a decline");
    if (bear(c) && bull(p) && c[1] >= p[4] && c[4] <= p[1] && B > pb && trend === "up") add("bearish_engulfing", "bearish", 50, "Bearish body engulfs prior bullish body after an advance");
    if (bull(c) && bear(p) && Math.max(c[1], c[4]) < Math.max(p[1], p[4]) && Math.min(c[1], c[4]) > Math.min(p[1], p[4]) && B < pb * 0.6 && trend === "down") add("bullish_harami", "bullish", 25, "Small bullish body inside prior bearish body");
    if (bear(c) && bull(p) && Math.max(c[1], c[4]) < Math.max(p[1], p[4]) && Math.min(c[1], c[4]) > Math.min(p[1], p[4]) && B < pb * 0.6 && trend === "up") add("bearish_harami", "bearish", 25, "Small bearish body inside prior bullish body");
    const pmid = (p[1] + p[4]) / 2;
    if (bull(c) && bear(p) && c[1] < p[4] && c[4] > pmid && c[4] < p[1] && trend === "down") add("piercing_line", "bullish", 40, "Opens below prior low close and closes above the prior body midpoint");
    if (bear(c) && bull(p) && c[1] > p[4] && c[4] < pmid && c[4] > p[1] && trend === "up") add("dark_cloud_cover", "bearish", 40, "Opens above prior high close and closes below the prior body midpoint");
    const ppTrend = priorTrend(rows, i - 1, a);
    if (bear(pp) && body(pp) > 0.5 * a && body(p) < 0.3 * body(pp) && bull(c) && c[4] > (pp[1] + pp[4]) / 2 && ppTrend === "down") add("morning_star", "bullish", 55, "Three-candle bottoming sequence: long bear, small body, strong bull");
    if (bull(pp) && body(pp) > 0.5 * a && body(p) < 0.3 * body(pp) && bear(c) && c[4] < (pp[1] + pp[4]) / 2 && ppTrend === "up") add("evening_star", "bearish", 55, "Three-candle topping sequence: long bull, small body, strong bear");
    if (i >= 3) {
      const [a1, a2, a3] = [rows[i - 2], rows[i - 1], c];
      if ([a1, a2, a3].every(bull) && a2[4] > a1[4] && a3[4] > a2[4] && [a1, a2, a3].every(x => body(x) >= 0.5 * range(x)) && priorTrend(rows, i - 2, a) !== "up") add("three_white_soldiers", "bullish", 55, "Three consecutive strong bullish closes, each higher");
      if ([a1, a2, a3].every(bear) && a2[4] < a1[4] && a3[4] < a2[4] && [a1, a2, a3].every(x => body(x) >= 0.5 * range(x)) && priorTrend(rows, i - 2, a) !== "down") add("three_black_crows", "bearish", 55, "Three consecutive strong bearish closes, each lower");
    }
    if (B >= CANDLE_RULES.marubozuBody * R && B > 1.2 * a * 0.6) add(bull(c) ? "bullish_marubozu" : "bearish_marubozu", bull(c) ? "bullish" : "bearish", 35, "Full-bodied candle with almost no wicks: one-sided control");
    if (c[2] < p[2] && c[3] > p[3]) add("inside_bar", "neutral", 20, "Range contained within the previous candle: compression, direction undecided");
    const tol = CANDLE_RULES.tweezerTol * a;
    if (Math.abs(c[2] - p[2]) <= tol && bull(p) && bear(c) && trend === "up") add("tweezer_top", "bearish", 30, "Matching highs with a bullish-to-bearish flip");
    if (Math.abs(c[3] - p[3]) <= tol && bear(p) && bull(c) && trend === "down") add("tweezer_bottom", "bullish", 30, "Matching lows with a bearish-to-bullish flip");
  }
  return out.map(p => ({ ...p, strength: round(p.strength, 0) }));
}
