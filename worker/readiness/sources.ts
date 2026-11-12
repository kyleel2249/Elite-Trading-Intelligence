// Price-data sources for markets the public crypto APIs do not cover. Both are optional, read-only and configured by the operator;
// when neither is configured the engine reports "no price feed" and caps the verdict. ETI never fabricates quotes or candles.
//   * US equities/ETFs: Alpaca Market Data v2 (uses the existing ALPACA_API_KEY / ALPACA_SECRET_KEY Worker secrets, IEX feed).
//   * Forex: a generic HTTPS JSON adapter pointed at a candle/quote provider the operator is licensed to use (ETI_FX_*).
import { validateKlines, type Kline } from "../market.ts";
import type { Timeframe } from "../algo/timeframes.ts";

export interface SourceEnv { ALPACA_API_KEY?: string; ALPACA_SECRET_KEY?: string; ETI_FX_CANDLES_URL?: string; ETI_FX_QUOTE_URL?: string; ETI_FX_DATA_TOKEN?: string }
export interface Quote { bid: number; ask: number; time: number | null }
export interface PriceSource { name: string; candles(symbol: string, tf: Timeframe, limit: number): Promise<Kline[]>; quote(symbol: string): Promise<Quote | null> }
type FetchLike = typeof fetch;

const num = (v: unknown): number => { const n = typeof v === "string" ? Number(v) : (v as number); if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("non-numeric value in provider payload"); return n; };
const toMs = (v: unknown): number => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") { if (/^\d+$/.test(v)) return toMs(Number(v)); const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  throw new Error("unrecognised timestamp in provider payload");
};
async function getJson(f: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await f(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text(); if (text.length > 5_000_000) throw new Error("response too large");
  return JSON.parse(text);
}

// ---------------------------------------------------------------- Alpaca (US stocks / ETFs)
const ALPACA_TF: Record<string, string> = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day", "1w": "1Week" };
export const US_SYMBOL_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;
export function alpacaSource(env: SourceEnv, f: FetchLike = fetch, now = Date.now()): PriceSource | null {
  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) return null;
  const headers = { "APCA-API-KEY-ID": env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY }, host = "https://data.alpaca.markets";
  return {
    name: "alpaca-iex",
    async candles(symbol, tf, limit) {
      if (!US_SYMBOL_RE.test(symbol) || !ALPACA_TF[tf]) throw new Error("unsupported symbol or timeframe");
      // sort=desc with a distant start returns the NEWEST `limit` bars regardless of how many are market hours.
      const q = new URLSearchParams({ timeframe: ALPACA_TF[tf], start: new Date(now - 800 * 86_400_000).toISOString(), limit: String(limit), sort: "desc", adjustment: "raw", feed: "iex" });
      const j = await getJson(f, `${host}/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`, headers) as { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null };
      if (!Array.isArray(j.bars) || !j.bars.length) throw new Error("no bars returned");
      return validateKlines(j.bars.map(b => [toMs(b.t), num(b.o), num(b.h), num(b.l), num(b.c), num(b.v)] as Kline), limit);
    },
    async quote(symbol) {
      const j = await getJson(f, `${host}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`, headers) as { quote?: { bp: number; ap: number; t: string } };
      const q = j.quote; if (!q) return null;
      const bid = num(q.bp), ask = num(q.ap); return bid > 0 && ask > 0 ? { bid, ask, time: toMs(q.t) } : null;
    },
  };
}

// ---------------------------------------------------------------- generic forex adapter
/** Accepts an array of rows, or an object holding one under candles|data|values|bars. A row is [t,o,h,l,c,(v)] or {t|time|datetime, o|open, h|high, l|low, c|close, v|volume}. Missing volume becomes 0 ("unknown"). */
export function parseCandleRows(raw: unknown): Kline[] {
  const rows = Array.isArray(raw) ? raw : (["candles", "data", "values", "bars"].map(k => (raw as Record<string, unknown>)?.[k]).find(Array.isArray) as unknown[] | undefined);
  if (!rows?.length) throw new Error("no candle rows in provider payload");
  return rows.map(r => {
    if (Array.isArray(r)) return [toMs(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), r[5] === undefined || r[5] === null ? 0 : num(r[5])] as Kline;
    const o = r as Record<string, unknown>, pick = (...k: string[]) => { const key = k.find(x => o[x] !== undefined && o[x] !== null); if (!key) throw new Error("candle row is missing a field"); return o[key]; };
    const vk = ["v", "volume", "tick_volume"].find(k => o[k] !== undefined && o[k] !== null);
    return [toMs(pick("t", "time", "datetime", "timestamp")), num(pick("o", "open")), num(pick("h", "high")), num(pick("l", "low")), num(pick("c", "close")), vk ? num(o[vk]) : 0] as Kline;
  });
}
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
export function fxSource(env: SourceEnv, f: FetchLike = fetch): PriceSource | null {
  if (!env.ETI_FX_CANDLES_URL) return null;
  for (const u of [env.ETI_FX_CANDLES_URL, env.ETI_FX_QUOTE_URL]) if (u) { try { if (new URL(u.replace(/\{\w+\}/g, "x")).protocol !== "https:") return null; } catch { return null; } }
  const headers: Record<string, string> = env.ETI_FX_DATA_TOKEN ? { authorization: `Bearer ${env.ETI_FX_DATA_TOKEN}` } : {};
  return {
    name: new URL(env.ETI_FX_CANDLES_URL.replace(/\{\w+\}/g, "x")).host,
    async candles(symbol, tf, limit) { return validateKlines(parseCandleRows(await getJson(f, fill(env.ETI_FX_CANDLES_URL!, { symbol, interval: tf, limit: String(limit) }), headers)), limit); },
    async quote(symbol) {
      if (!env.ETI_FX_QUOTE_URL) return null;
      const j = await getJson(f, fill(env.ETI_FX_QUOTE_URL, { symbol }), headers) as Record<string, unknown>;
      const bid = num(j.bid), ask = num(j.ask); return bid > 0 && ask > 0 ? { bid, ask, time: j.time ?? j.timestamp ?? j.t ? toMs(j.time ?? j.timestamp ?? j.t) : null } : null;
    },
  };
}
export function sourceFor(market: "forex" | "equities", env: SourceEnv, f: FetchLike = fetch, now = Date.now()): PriceSource | null {
  return market === "equities" ? alpacaSource(env, f, now) : fxSource(env, f);
}
