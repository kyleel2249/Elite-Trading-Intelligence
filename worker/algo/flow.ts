// Volume-footprint analysis from OHLCV candles: abnormal activity, absorption (effort without result) and buy/sell pressure.
// Honest limits: candles do not identify who traded. "Pressure" uses where each bar closed inside its range, weighted by volume
// (a close-location proxy, not true aggressor/taker flow), and nothing here identifies an institution or any investor. Evidence only.
import type { Kline } from "../market.ts";

export interface FlowFlag { kind: "volume_spike" | "range_expansion" | "absorption_bullish" | "absorption_bearish" | "thin_move" | "climax"; barsAgo: number; detail: string }
export interface FlowAnalysis {
  available: boolean; reason?: string; volumeZ: number | null; rangeZ: number | null; relativeVolume: number | null;
  pressure: number | null; pressureBasis: "taker_buy_volume" | "close_location_proxy"; stanceBias: "buying" | "selling" | "balanced" | null;
  abnormal: boolean; flags: FlowFlag[]; supports: "supports" | "opposes" | "neutral" | "unavailable"; caveat: string;
}
export const FLOW_CAVEAT = "Derived from candle volume and close location only. It cannot tell who traded and does not identify institutions; treat as supporting evidence, not proof of large-participant activity.";
export const FLOW_CAVEAT_TAKER = "Uses the exchange-reported aggressive-buy (taker) volume per candle. It shows which side crossed the spread, not who traded, and does not identify institutions; treat as supporting evidence, not proof of large-participant activity.";
const LOOKBACK = 50, RECENT = 3, PRESSURE_BARS = 20;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sd = (a: number[], m = mean(a)) => Math.sqrt(mean(a.map(x => (x - m) ** 2)));
// The deviation floor (10% of the mean) stops a near-constant baseline from turning ordinary noise into huge z-scores.
const z = (x: number, base: number[]) => { const m = mean(base), s = Math.max(sd(base, m), Math.abs(m) * 0.1); return s > 0 ? (x - m) / s : 0; };

export function analyzeFlow(rows: Kline[] | undefined, dir: 1 | -1 | 0): FlowAnalysis {
  const none = (reason: string): FlowAnalysis => ({ available: false, reason, volumeZ: null, rangeZ: null, relativeVolume: null, pressure: null, pressureBasis: "close_location_proxy", stanceBias: null, abnormal: false, flags: [], supports: "unavailable", caveat: FLOW_CAVEAT });
  if (!rows || rows.length < LOOKBACK + RECENT + 1) return none(`At least ${LOOKBACK + RECENT + 1} candles are required`);
  const bars = rows.slice(-(LOOKBACK + RECENT)), base = bars.slice(0, LOOKBACK), recent = bars.slice(-RECENT);
  const vols = base.map(b => b[5]), ranges = base.map(b => b[2] - b[3]);
  if (!(mean(vols) > 0)) return none("No traded volume in the lookback window");
  const flags: FlowFlag[] = [];
  recent.forEach((b, i) => {
    const ago = RECENT - 1 - i, range = b[2] - b[3], vz = z(b[5], vols), rz = z(range, ranges), clv = range > 0 ? (2 * (b[4] - b[3]) / range) - 1 : 0, idx = bars.length - RECENT + i, before = bars[idx - 10] ? bars[idx - 1][4] - bars[idx - 10][4] : 0;
    const small = range <= mean(ranges) * 0.7, wide = range >= mean(ranges) * 1.5;
    if (vz >= 3) flags.push({ kind: "volume_spike", barsAgo: ago, detail: `volume ${vz.toFixed(1)} standard deviations above the ${LOOKBACK}-bar mean` });
    if (rz >= 3) flags.push({ kind: "range_expansion", barsAgo: ago, detail: `range ${rz.toFixed(1)} standard deviations above normal` });
    if (vz >= 2 && small) {
      if (clv > 0.2 && before < 0) flags.push({ kind: "absorption_bullish", barsAgo: ago, detail: "heavy volume with a narrow range closing in the upper part of the bar: selling met buying without lower prices" });
      else if (clv < -0.2 && before > 0) flags.push({ kind: "absorption_bearish", barsAgo: ago, detail: "heavy volume with a narrow range closing in the lower part of the bar: buying met selling without higher prices" });
    }
    if (rz >= 2 && vz <= -0.5) flags.push({ kind: "thin_move", barsAgo: ago, detail: "wide range on below-average volume: weak participation behind the move" });
    if (vz >= 3 && wide) flags.push({ kind: "climax", barsAgo: ago, detail: "extreme volume with an extreme range: possible exhaustion or capitulation" });
  });
  const win = bars.slice(-PRESSURE_BARS), tv = win.reduce((s, b) => s + b[5], 0), withTaker = win.filter(b => typeof b[6] === "number").length, taker = withTaker >= win.length * 0.9 && tv > 0;
  // True aggressor imbalance when the exchange reported taker-buy volume on nearly every bar; otherwise the close-location proxy.
  const pressure = taker ? win.reduce((s, b) => s + (typeof b[6] === "number" ? 2 * b[6] - b[5] : 0), 0) / tv : tv > 0 ? win.reduce((s, b) => { const r = b[2] - b[3]; return s + b[5] * (r > 0 ? (2 * (b[4] - b[3]) / r) - 1 : 0); }, 0) / tv : 0;
  const stanceBias = pressure > 0.15 ? "buying" : pressure < -0.15 ? "selling" : "balanced";
  const last = recent[RECENT - 1], vz = z(last[5], vols), rz = z(last[2] - last[3], ranges);
  const bull = flags.filter(f => f.kind === "absorption_bullish").length, bear = flags.filter(f => f.kind === "absorption_bearish").length;
  const score = (stanceBias === "buying" ? 1 : stanceBias === "selling" ? -1 : 0) + (bull ? 1 : 0) - (bear ? 1 : 0);
  const supports = dir === 0 ? "neutral" : score * dir >= 1 ? "supports" : score * dir <= -1 ? "opposes" : "neutral";
  return { available: true, volumeZ: vz, rangeZ: rz, relativeVolume: last[5] / mean(vols), pressure, pressureBasis: taker ? "taker_buy_volume" : "close_location_proxy", stanceBias, abnormal: flags.some(f => f.kind === "volume_spike" || f.kind === "range_expansion" || f.kind === "climax"), flags, supports, caveat: taker ? FLOW_CAVEAT_TAKER : FLOW_CAVEAT };
}
