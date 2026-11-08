// Data loading for the replay lab. Fetching is read-only public market data; parsing is strict and fails loudly
// on malformed rows rather than guessing.
import type { Kline } from "../market.ts";
import { TF_SECONDS, type Timeframe } from "./timeframes.ts";

export const BINANCE_HOST = "https://data-api.binance.vision";
type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Page through public Binance klines. Drops the still-forming candle; throws on any HTTP/shape error instead of returning partial data silently. */
export async function fetchBinanceKlines(symbol: string, tf: Timeframe, startMs: number, endMs: number, fetchImpl: FetchLike = fetch as unknown as FetchLike, now = Date.now()): Promise<Kline[]> {
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error(`Invalid symbol ${symbol}`);
  const ms = TF_SECONDS[tf] * 1000, out: Kline[] = []; let from = startMs;
  for (let guard = 0; guard < 2000 && from < endMs; guard++) {
    const res = await fetchImpl(`${BINANCE_HOST}/api/v3/klines?symbol=${symbol}&interval=${tf}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (!res.ok) throw new Error(`Binance klines ${symbol} ${tf} failed with HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`Binance klines ${symbol} ${tf}: unexpected response shape`);
    if (!rows.length) break;
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 6) throw new Error("Binance klines: malformed row");
      const k: Kline = [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])];
      if (k.some(v => !Number.isFinite(v))) throw new Error("Binance klines: non-numeric value in row");
      if (out.length && k[0] <= out.at(-1)![0]) continue; // de-duplicate overlapping pages
      out.push(k);
    }
    const last = Number(rows.at(-1)[0]); if (!(last >= from)) throw new Error("Binance klines: pagination did not advance");
    if (rows.length < 1000) break; from = last + 1;
  }
  return out.filter(k => k[0] + ms <= now);
}

const toMs = (raw: string): number => {
  const t = raw.trim();
  if (/^\d{13}$/.test(t)) return Number(t);
  if (/^\d{10}$/.test(t)) return Number(t) * 1000;
  const d = Date.parse(t); if (!Number.isFinite(d)) throw new Error(`Unrecognised timestamp "${raw}"`); return d;
};
/** CSV columns: time, open, high, low, close, volume. Header row optional. Validates OHLC sanity per line. */
export function parseCsvKlines(text: string): Kline[] {
  const out: Kline[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    const c = line.split(",");
    if (idx === 0 && !Number.isFinite(Number(c[1]))) return; // header
    if (c.length < 6) throw new Error(`CSV line ${idx + 1}: expected 6 columns (time,open,high,low,close,volume)`);
    const k: Kline = [toMs(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5])];
    if (k.some(v => !Number.isFinite(v))) throw new Error(`CSV line ${idx + 1}: non-numeric value`);
    if (k[2] < Math.max(k[1], k[4]) || k[3] > Math.min(k[1], k[4]) || k[3] <= 0 || k[5] < 0) throw new Error(`CSV line ${idx + 1}: inconsistent OHLCV values`);
    out.push(k);
  });
  return out;
}
