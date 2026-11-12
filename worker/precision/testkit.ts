// Deterministic fixtures shared by the Precision engine tests. Not a test file itself.
import { series, rng } from "../algo/fixtures.ts";
import { TIMEFRAMES, TF_SECONDS, type Timeframe } from "../algo/timeframes.ts";
import type { DepthSnapshot } from "../algo/liquidity.ts";
import type { Kline } from "../market.ts";
import type { PrecisionInput } from "./engine.ts";
import type { CalibrationSample } from "./calibration.ts";

export const NOW = 1_800_000_000_000;

export function candlesFor(drift: number, noise: number, seed: number, start = 100, end = NOW, n = 260): Partial<Record<Timeframe, Kline[]>> {
  const c: Partial<Record<Timeframe, Kline[]>> = {};
  for (const tf of TIMEFRAMES) c[tf] = series(n, { drift, noise, start, seed, stepMs: TF_SECONDS[tf] * 1000, end });
  return c;
}

/** Symmetric, deep, tight book around `px` (about 1 bp half-spread) whose levels are worth about 50k quote each. */
export function depthAround(px: number, ts = NOW, opts: { bidScale?: number; askScale?: number; halfSpreadBps?: number } = {}): DepthSnapshot {
  const { bidScale = 1, askScale = 1, halfSpreadBps = 1 } = opts;
  const h = halfSpreadBps / 1e4;
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 20; i++) {
    bids.push([px * (1 - h - i * 0.0004), (50_000 / px) * bidScale]);
    asks.push([px * (1 + h + i * 0.0004), (50_000 / px) * askScale]);
  }
  return { bids, asks, timestamp: ts };
}

export const lastClose = (c: Partial<Record<Timeframe, Kline[]>>, tf: Timeframe = "15m") => c[tf]!.at(-1)![4];

/** Known fixtures (drift, noise, seed, start) and what the engine does with them on the intraday strategy. */
export const FIXTURES = {
  buy: { drift: 1, noise: 2, seed: 1, start: 100 },
  sell: { drift: -1, noise: 2, seed: 1, start: 600 },
  /** Trending, but the net reward-to-risk after costs is too thin. */
  thinReward: { drift: 0.8, noise: 1.5, seed: 1, start: 100 },
  /** Trending, but the stop would be wider than the maximum allowed distance. */
  wideStop: { drift: 0.9, noise: 1.8, seed: 5, start: 100 },
} as const;

export function inputFor(f: keyof typeof FIXTURES, over: Partial<PrecisionInput> = {}): PrecisionInput {
  const x = FIXTURES[f];
  const candles = candlesFor(x.drift, x.noise, x.seed, x.start);
  return { symbol: "BTCUSDT", strategy: "intraday", candles, depth: depthAround(lastClose(candles)), now: NOW, provider: "fixture", ...over };
}

/** Synthetic outcomes where the win probability genuinely rises with the score. */
export function informativeSamples(n: number, seed = 7, lo = 40, hi = 100): CalibrationSample[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const score = lo + r() * (hi - lo);
    const p = 0.25 + 0.55 * ((score - lo) / (hi - lo));
    return { score, win: r() < p, time: 1_000 + i };
  });
}
/** Synthetic outcomes where the score carries no information. */
export function noiseSamples(n: number, seed = 9): CalibrationSample[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ score: 40 + r() * 60, win: r() < 0.5, time: 1_000 + i }));
}

/** Context that makes every score component available, with strongly supportive evidence for a long. */
export function fullContext(dir: 1 | -1 = 1, now = NOW) {
  const asOf = new Date(now - 3_600_000).toISOString();
  return {
    fundamentals: { asOf, source: "test-feed", factors: [{ name: "Network activity", bias: 0.8 * dir, weight: 2, note: "rising" }, { name: "Supply", bias: 0.6 * dir, weight: 1, note: "tightening" }] },
    news: { asOf, source: "test-feed", events: [] as any[] },
    expectancy: { expectancyR: 0.4, samples: 120 },
  };
}
