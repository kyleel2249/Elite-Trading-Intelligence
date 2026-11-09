import type { Kline } from "../market.ts";
/** Deterministic PRNG so tests are reproducible. */
export function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function series(n: number, opts: { drift?: number; noise?: number; start?: number; vol?: number; seed?: number; stepMs?: number; end?: number } = {}): Kline[] {
  const { drift = 0, noise = 0.5, start = 100, vol = 100, seed = 1, stepMs = 3600000, end = Date.now() } = opts;
  const r = rng(seed); let p = start; const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const open = p; p = Math.max(1, p + drift + (r() - 0.5) * 2 * noise);
    const hi = Math.max(open, p) + r() * noise * 0.6, lo = Math.min(open, p) - r() * noise * 0.6;
    out.push([end - (n - 1 - i) * stepMs, open, hi, lo, p, vol * (0.8 + r() * 0.4)]);
  }
  return out;
}
/** Mean-reverting (Ornstein-Uhlenbeck) noise around a fixed base: a genuine range with no persistent direction. */
export function rangeSeries(n: number, opts: { base?: number; reversion?: number; noise?: number; seed?: number; stepMs?: number; end?: number; vol?: number } = {}): Kline[] {
  const { base = 100, reversion = 0.35, noise = 0.8, seed = 4, stepMs = 3600000, end = Date.now(), vol = 100 } = opts;
  const r = rng(seed); let p = base; const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const open = p; p = p + reversion * (base - p) + (r() - 0.5) * 2 * noise;
    out.push([end - (n - 1 - i) * stepMs, open, Math.max(open, p) + r() * 0.3, Math.min(open, p) - r() * 0.3, p, vol * (0.8 + r() * 0.4)]);
  }
  return out;
}
/** Regime-switching series (trend legs and pauses) with seeded randomness, used to exercise the backtester. */
export function regimeSeries(n: number, opts: { seed?: number; leg?: number; drift?: number; noise?: number; start?: number; stepMs?: number; end?: number } = {}): Kline[] {
  const { seed = 3, leg = 90, drift = 0.35, noise = 0.35, start = 100, stepMs = 3600000, end = Date.now() } = opts;
  const r = rng(seed); let p = start, d = drift; const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    if (i % leg === 0) { const x = r(); d = x < 0.4 ? drift : x < 0.8 ? -drift : 0; }
    const open = p; p = Math.max(1, p + d + (r() - 0.5) * 2 * noise);
    out.push([end - (n - 1 - i) * stepMs, open, Math.max(open, p) + r() * noise * 0.5, Math.min(open, p) - r() * noise * 0.5, p, 100 * (0.7 + r() * 0.6 + (Math.abs(p - open) > noise ? 0.4 : 0))]);
  }
  return out;
}
