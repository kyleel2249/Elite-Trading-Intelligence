// Candle and quote source for stocks and FX (the Worker's exchange providers only cover crypto).
// Uses Yahoo Finance's public chart endpoint: unofficial and unauthenticated, so it can rate-limit or change without notice.
// Failures are reported, never papered over.
import type { Kline } from "../market.ts";
import type { MtfTimeframe } from "./mtf.ts";
import { aggregateYearly } from "./mtf.ts";
import { SourceError, type FetchFn } from "./fundamental-sources.ts";

export const YAHOO_ROOT = "https://query1.finance.yahoo.com/v8/finance/chart/";
export const yahooSymbol = (symbol: string, cls: "fx" | "stock" | "crypto" | "unknown") => (cls === "fx" ? `${symbol}=X` : symbol);
/** Yahoo interval/range per timeframe. 4h is built from 1h; 1Y from 1mo. */
export const YAHOO_PLAN: Record<Exclude<MtfTimeframe, "1Y">, { interval: string; range: string; aggregateTo?: number }> = {
  "1m": { interval: "1m", range: "5d" }, "5m": { interval: "5m", range: "1mo" }, "15m": { interval: "15m", range: "1mo" }, "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "60m", range: "6mo" }, "4h": { interval: "60m", range: "1y", aggregateTo: 4 * 3600000 }, "1d": { interval: "1d", range: "2y" }, "1w": { interval: "1wk", range: "10y" }, "1M": { interval: "1mo", range: "max" },
};
export function parseYahooChart(j: any): { rows: Kline[]; meta: { price?: number; time?: number; currency?: string } } {
  const res = j?.chart?.result?.[0];
  if (!res) throw new SourceError("Yahoo Finance", j?.chart?.error?.description ?? "no chart result");
  const ts: number[] = res.timestamp ?? [], q = res.indicators?.quote?.[0] ?? {}, rows: Kline[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
    if ([o, h, l, c].every(x => typeof x === "number" && Number.isFinite(x) && x > 0) && h >= l) rows.push([ts[i] * 1000, o, Math.max(h, o, c), Math.min(l, o, c), c, Number.isFinite(v) ? v : 0]);
  }
  return { rows, meta: { price: res.meta?.regularMarketPrice, time: res.meta?.regularMarketTime ? res.meta.regularMarketTime * 1000 : undefined, currency: res.meta?.currency } };
}
export function aggregateBuckets(rows: Kline[], bucketMs: number): Kline[] {
  const out = new Map<number, Kline>();
  for (const r of rows) { const b = Math.floor(r[0] / bucketMs) * bucketMs, cur = out.get(b); if (!cur) out.set(b, [b, r[1], r[2], r[3], r[4], r[5]]); else { cur[2] = Math.max(cur[2], r[2]); cur[3] = Math.min(cur[3], r[3]); cur[4] = r[4]; cur[5] += r[5]; } }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}
async function chart(f: FetchFn, sym: string, interval: string, range: string) {
  let r: Response;
  try { r = await f(`${YAHOO_ROOT}${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; ETI-Analysis/1.0)" }, signal: AbortSignal.timeout(9000) }); }
  catch (e) { throw new SourceError("Yahoo Finance", `request failed: ${e instanceof Error ? e.message : "network error"}`); }
  if (!r.ok) throw new SourceError("Yahoo Finance", `HTTP ${r.status}`);
  try { return parseYahooChart(await r.json()); } catch (e) { if (e instanceof SourceError) throw e; throw new SourceError("Yahoo Finance", "invalid JSON"); }
}
export async function loadYahooCandles(symbol: string, cls: "fx" | "stock", tfs: MtfTimeframe[], f: FetchFn): Promise<{ candles: Partial<Record<MtfTimeframe, Kline[]>>; failures: Record<string, string>; notes: string[] }> {
  const sym = yahooSymbol(symbol, cls), candles: Partial<Record<MtfTimeframe, Kline[]>> = {}, failures: Record<string, string> = {}, notes: string[] = [];
  const need = [...new Set(tfs.map(t => (t === "1Y" ? "1M" : t)))] as Exclude<MtfTimeframe, "1Y">[];
  await Promise.all(need.map(async tf => {
    const plan = YAHOO_PLAN[tf];
    try { const { rows } = await chart(f, sym, plan.interval, plan.range); candles[tf] = plan.aggregateTo ? aggregateBuckets(rows, plan.aggregateTo) : rows; }
    catch (e) { failures[tf] = e instanceof Error ? e.message : "failed"; }
  }));
  if (cls === "stock") notes.push("Stock candles cover regular trading hours only: overnight gaps appear as price jumps and 4h bars are built from 1h bars bucketed in UTC.");
  if (cls === "fx") notes.push("Spot FX candles carry no volume: volume-based evidence is unavailable.");
  notes.push("Candles come from Yahoo Finance's unofficial public endpoint: availability is not guaranteed.");
  return { candles, failures, notes };
}
export async function fetchYahooQuote(symbol: string, cls: "fx" | "stock", f: FetchFn): Promise<{ price: number; time: number }> {
  const { meta } = await chart(f, yahooSymbol(symbol, cls), "1d", "5d");
  if (!(typeof meta.price === "number" && meta.price > 0)) throw new SourceError("Yahoo Finance", "no price in chart metadata");
  return { price: meta.price, time: meta.time ?? Date.now() };
}
export { aggregateYearly };
