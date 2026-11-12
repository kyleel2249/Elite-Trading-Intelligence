// ATR(14) is needed by almost every detector. It is computed once per candle array and memoised by array identity.
import type { Kline } from "../market.ts";
import { atrSeries } from "../algo/indicators.ts";
const cache = new WeakMap<Kline[], number[]>();
export function atr14(rows: Kline[]): number[] {
  let v = cache.get(rows);
  if (!v) { v = atrSeries(rows, 14); cache.set(rows, v); }
  return v;
}
export const lastAtr = (rows: Kline[]): number => { const a = atr14(rows); for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i]; return 0; };
