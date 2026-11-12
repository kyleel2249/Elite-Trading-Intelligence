/**
 * US equity data via the Alpaca market-data API (keys required; the same read-only keys the paper account uses).
 * Covers NYSE, Nasdaq and NYSE American/Arca listings only. The free feed is IEX-only: its volume is a small share of consolidated
 * volume, so volume-based factors for equities are understated unless ALPACA_DATA_FEED=sip (paid subscription).
 */
import type { Kline } from "../market.ts";
import { Budget, type FetchLike } from "./budget.ts";

export interface EquityEnv { ALPACA_API_KEY?: string; ALPACA_SECRET_KEY?: string; ALPACA_DATA_FEED?: string; ALPHA_EQUITY_WATCHLIST?: string }
export const equityConfigured = (env: EquityEnv) => !!(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY);
const headers = (env: EquityEnv) => ({ "APCA-API-KEY-ID": env.ALPACA_API_KEY || "", "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY || "", accept: "application/json" });
export const feedOf = (env: EquityEnv) => (env.ALPACA_DATA_FEED === "sip" ? "sip" : "iex");

export function parseAlpacaBars(json: any): Kline[] {
  const bars = Array.isArray(json?.bars) ? json.bars : []; const out: Kline[] = [];
  for (const b of bars) { const t = Date.parse(b?.t), o = Number(b?.o), h = Number(b?.h), l = Number(b?.l), c = Number(b?.c), v = Number(b?.v); if ([t, o, h, l, c, v].every(Number.isFinite) && o > 0 && h >= l && c > 0) out.push([t, o, h, l, c, v]); }
  return out.sort((a, b) => a[0] - b[0]);
}
export function parseScreener(json: any): string[] {
  const rows = [...(json?.most_actives ?? []), ...(json?.gainers ?? [])]; return [...new Set(rows.map((r: any) => String(r?.symbol || "").toUpperCase()).filter((s: string) => /^[A-Z]{1,5}$/.test(s)))] as string[];
}
export type EquityResult<T> = { ok: true; data: T } | { ok: false; reason: string };
export async function fetchEquityBars(symbol: string, env: EquityEnv, b: Budget, f: FetchLike = fetch, now = Date.now()): Promise<EquityResult<Kline[]>> {
  if (!equityConfigured(env)) return { ok: false, reason: "alpaca_keys_not_configured" }; if (!/^[A-Z.]{1,6}$/.test(symbol)) return { ok: false, reason: "invalid_symbol" }; if (!b.take()) return { ok: false, reason: "subrequest_budget_exhausted" };
  const start = new Date(now - 560 * 86400000).toISOString().slice(0, 10);
  try { const r = await f("https://data.alpaca.markets/v2/stocks/" + symbol + "/bars?timeframe=1Day&adjustment=split&feed=" + feedOf(env) + "&limit=1000&start=" + start, { headers: headers(env) }); if (!r.ok) return { ok: false, reason: "http_" + r.status }; const rows = parseAlpacaBars(await r.json()); return rows.length >= 120 ? { ok: true, data: rows } : { ok: false, reason: "insufficient_history_" + rows.length }; }
  catch { return { ok: false, reason: "network_error" }; }
}
export async function fetchScreener(env: EquityEnv, b: Budget, f: FetchLike = fetch): Promise<string[]> {
  if (!equityConfigured(env)) return []; const out: string[] = [];
  for (const u of ["https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=25", "https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=25"]) { if (!b.take()) break; try { const r = await f(u, { headers: headers(env) }); if (r.ok) out.push(...parseScreener(await r.json())); } catch { /* partial */ } }
  return [...new Set(out)];
}
export const watchlist = (env: EquityEnv) => (env.ALPHA_EQUITY_WATCHLIST || "").split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z.]{1,6}$/.test(s));
