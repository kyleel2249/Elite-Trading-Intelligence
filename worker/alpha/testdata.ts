/** Deterministic synthetic candles for unit tests only (never served by any route). */
import type { Kline } from "../market.ts";
import { prng } from "./indicators.ts";
export interface Seg { bars: number; drift: number; vol: number; volume: number; volDrift?: number }
/** Builds candles from segments of (per-bar drift, noise, volume). Open = previous close. */
export function makeCandles(segs: Seg[], opts: { start?: number; step?: number; price?: number; seed?: number } = {}): Kline[] {
  const rnd = prng(opts.seed ?? 7), step = opts.step ?? 3600_000; let t = opts.start ?? 1_700_000_000_000, p = opts.price ?? 100; const out: Kline[] = [];
  for (const s of segs) for (let i = 0; i < s.bars; i++) {
    const o = p, noise = (rnd() - 0.5) * 2 * s.vol, c = Math.max(0.01, o * (1 + s.drift + noise));
    const hi = Math.max(o, c) * (1 + rnd() * s.vol * 0.6), lo = Math.min(o, c) * (1 - rnd() * s.vol * 0.6);
    const vol = s.volume * (0.85 + rnd() * 0.3) * (1 + (s.volDrift ?? 0) * i);
    out.push([t, o, hi, lo, c, vol]); t += step; p = c;
  }
  return out;
}
export const range = (bars: number, vol = 0.004, volume = 1000): Seg => ({ bars, drift: 0, vol, volume });
export const trend = (bars: number, drift: number, vol = 0.004, volume = 1000): Seg => ({ bars, drift, vol, volume });
