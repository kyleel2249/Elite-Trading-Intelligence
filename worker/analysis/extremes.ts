/**
 * Bybit 24-hour extreme forecast.
 *
 * Uses completed UTC daily candles for the price-range distribution and completed
 * hourly candles for the recurring time-of-day pattern. Current 24h ticker values
 * are reported as observed context, never substituted for a forward forecast.
 * This is a read-only statistical estimate, not a trade signal.
 */
import { getMarketData, type Kline, type MarketEnv, type Ticker } from "../market.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface DailyExtremeSample {
  day: number;
  open: number;
  high: number;
  low: number;
  close: number;
  highAt: number;
  lowAt: number;
  upPct: number;
  downPct: number;
}

export interface ExtremeTicker {
  symbol: string;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  priceChangePercent?: number;
  volume?: number;
  quoteVolume?: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const median = (values: number[]) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const percentile = (values: number[], p: number) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = (a.length - 1) * clamp(p, 0, 1), lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
};
function validKline(k: Kline): boolean {
  return Array.isArray(k) && k.length >= 6 && finite(k[0]) && k[0] > 0 &&
    finite(k[1]) && k[1] > 0 && finite(k[2]) && finite(k[3]) && finite(k[4]) &&
    finite(k[5]) && k[5] >= 0 && k[2] >= Math.max(k[1], k[4]) &&
    k[3] <= Math.min(k[1], k[4]) && k[3] > 0;
}

/** Build complete UTC-day timing samples from hourly bars. Partial days are excluded. */
export function hourlyExtremeSamples(rows: Kline[], now = Date.now(), maxDays = 60): DailyExtremeSample[] {
  const groups = new Map<number, Kline[]>();
  for (const k of rows) {
    if (!validKline(k) || k[0] + HOUR_MS > now) continue;
    const day = Math.floor(k[0] / DAY_MS) * DAY_MS;
    const list = groups.get(day) ?? [];
    list.push(k);
    groups.set(day, list);
  }
  const out: DailyExtremeSample[] = [];
  for (const [day, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    // A crypto UTC day should have 24 hourly bars. Allow a small gap, reject sparse feeds.
    if (sorted.length < 18 || day + DAY_MS > now) continue;
    const open = sorted[0][1], close = sorted[sorted.length - 1][4];
    if (!(open > 0)) continue;
    let high = -Infinity, low = Infinity, highAt = 0, lowAt = 0;
    for (const k of sorted) {
      if (k[2] > high) { high = k[2]; highAt = k[0] + HOUR_MS / 2; }
      if (k[3] < low) { low = k[3]; lowAt = k[0] + HOUR_MS / 2; }
    }
    if (!(high >= open && low > 0 && low <= open)) continue;
    out.push({ day, open, high, low, close, highAt, lowAt, upPct: (high / open - 1) * 100, downPct: (1 - low / open) * 100 });
  }
  return out.slice(-Math.max(5, Math.floor(maxDays)));
}

/** Build longer-range range samples from completed daily Bybit candles. */
export function dailyRangeSamples(rows: Kline[], now = Date.now(), maxDays = 1000): DailyExtremeSample[] {
  const out: DailyExtremeSample[] = [];
  const sorted = rows.filter(validKline).slice().sort((a, b) => a[0] - b[0]);
  for (const k of sorted) {
    if (k[0] + DAY_MS > now) continue;
    const open = k[1], high = k[2], low = k[3], close = k[4];
    if (!(open > 0 && high >= open && low > 0 && low <= open)) continue;
    out.push({ day: k[0], open, high, low, close, highAt: k[0], lowAt: k[0], upPct: (high / open - 1) * 100, downPct: (1 - low / open) * 100 });
  }
  return out.slice(-Math.max(5, Math.floor(maxDays)));
}

function circularHour(values: number[]): { hour: number; concentration: number } {
  if (!values.length) return { hour: 0, concentration: 0 };
  let x = 0, y = 0;
  for (const h of values) {
    const a = ((h % 24) + 24) % 24 * Math.PI / 12;
    x += Math.cos(a); y += Math.sin(a);
  }
  const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  return { hour: angle * 12 / Math.PI, concentration: clamp(Math.hypot(x, y) / values.length, 0, 1) };
}
function utcHour(ts: number): number {
  const d = new Date(ts);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}
function nextUtcOccurrence(now: number, hour: number): number {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const whole = Math.floor(hour), minute = Math.round((hour - whole) * 60);
  let ts = start + whole * HOUR_MS + minute * 60_000;
  if (ts <= now) ts += DAY_MS;
  return ts;
}
function stability(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!(mean > 0)) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return clamp(1 - Math.sqrt(variance) / mean, 0, 1);
}
const round = (v: number, n = 6) => Number(v.toFixed(n));

export function forecast24hExtremes(
  hourlyRows: Kline[],
  dailyRows: Kline[],
  ticker: ExtremeTicker,
  now = Date.now(),
) {
  const validTicker = finite(ticker.lastPrice) && ticker.lastPrice > 0 &&
    finite(ticker.highPrice) && ticker.highPrice > 0 &&
    finite(ticker.lowPrice) && ticker.lowPrice > 0 &&
    ticker.highPrice >= ticker.lowPrice;
  const hourly = hourlyExtremeSamples(hourlyRows, now, 60);
  const dailyFromHigherTimeframe = dailyRangeSamples(dailyRows, now, 1000);
  const daily = dailyFromHigherTimeframe.length >= 5 ? dailyFromHigherTimeframe : hourly;
  const observed = validTicker ? {
    lastPrice: ticker.lastPrice,
    high24h: ticker.highPrice,
    low24h: ticker.lowPrice,
    change24hPct: finite(ticker.priceChangePercent) ? ticker.priceChangePercent : null,
    volume24h: finite(ticker.volume) ? ticker.volume : null,
    quoteVolume24h: finite(ticker.quoteVolume) ? ticker.quoteVolume : null,
  } : null;
  if (!validTicker) return {
    status: "unavailable" as const, symbol: ticker.symbol, generatedAt: new Date(now).toISOString(),
    reason: "Bybit did not return a valid last price and 24-hour high/low.", observed, forecast: null,
  };
  if (hourly.length < 5 || daily.length < 5) return {
    status: "insufficient_history" as const, symbol: ticker.symbol, generatedAt: new Date(now).toISOString(),
    reason: "At least five complete UTC days of hourly and daily Bybit candles are required before a forecast is published.",
    observed, forecast: null, history: { hourlyDays: hourly.length, dailyDays: daily.length },
  };

  const up = daily.map(x => x.upPct).filter(x => Number.isFinite(x) && x >= 0);
  const down = daily.map(x => x.downPct).filter(x => Number.isFinite(x) && x >= 0);
  const highHours = hourly.map(x => utcHour(x.highAt)), lowHours = hourly.map(x => utcHour(x.lowAt));
  const highTime = circularHour(highHours), lowTime = circularHour(lowHours);
  const upMedian = median(up), downMedian = median(down);
  const upP25 = percentile(up, .25), upP75 = percentile(up, .75);
  const downP25 = percentile(down, .25), downP75 = percentile(down, .75);
  const current = ticker.lastPrice;
  const highAt = nextUtcOccurrence(now, highTime.hour), lowAt = nextUtcOccurrence(now, lowTime.hour);
  const highPrice = current * (1 + upMedian / 100), lowPrice = current * (1 - downMedian / 100);
  const highRange = { low: current * (1 + upP25 / 100), high: current * (1 + upP75 / 100) };
  const lowRange = { low: current * (1 - downP75 / 100), high: current * (1 - downP25 / 100) };
  const rangeStability = (stability(up) + stability(down)) / 2;
  const timeStability = (highTime.concentration + lowTime.concentration) / 2;
  const historyDepth = (Math.min(hourly.length / 30, 1) + Math.min(daily.length / 180, 1)) / 2;
  const confidence = Math.round(100 * clamp(.4 * rangeStability + .35 * timeStability + .25 * historyDepth, 0, 1));
  const confidenceLabel = confidence >= 75 ? "HIGH PATTERN CONSISTENCY" : confidence >= 50 ? "MODERATE PATTERN CONSISTENCY" : "LOW PATTERN CONSISTENCY";
  const windowMinutes = 60;
  const makeTime = (at: number) => ({ expectedAt: new Date(at).toISOString(), windowStart: new Date(at - windowMinutes * 60_000).toISOString(), windowEnd: new Date(at + windowMinutes * 60_000).toISOString(), precisionMinutes: windowMinutes });
  return {
    status: "ready" as const, symbol: ticker.symbol, generatedAt: new Date(now).toISOString(),
    source: "Bybit V5 public market data",
    observed,
    forecast: {
      horizonHours: 24,
      high: { price: round(highPrice), range: { low: round(highRange.low), high: round(highRange.high) }, excursionPct: round(upMedian, 4), time: makeTime(highAt), typicalUtcHour: round(highTime.hour, 2), timeConsistency: round(highTime.concentration * 100, 1) },
      low: { price: round(lowPrice), range: { low: round(lowRange.low), high: round(lowRange.high) }, excursionPct: round(downMedian, 4), time: makeTime(lowAt), typicalUtcHour: round(lowTime.hour, 2), timeConsistency: round(lowTime.concentration * 100, 1) },
      confidence: { score: confidence, label: confidenceLabel, meaning: "Historical pattern consistency score, not a probability of profit or a guarantee." },
    },
    history: { hourlyDays: hourly.length, dailyDays: dailyFromHigherTimeframe.length, priceSampleDays: daily.length, priceSampleSource: dailyFromHigherTimeframe.length >= 5 ? "1d" : "1h_fallback", timeSampleDays: hourly.length, hourlyCandles: hourlyRows.length, dailyCandles: dailyRows.length },
    methodology: "Median completed-day high/low excursions estimate the next 24-hour price range. Circular time-of-day averages from completed hourly sessions estimate the expected high/low timing. Current Bybit 24-hour high/low are shown separately as observed context.",
    warnings: ["Forecasts are statistical estimates, not certain prices or times.", "Timing is based on hourly candles; each time window is approximate to ±60 minutes.", "Low pattern consistency or short history should reduce reliance on the estimate."],
  };
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

/** Read-only API route: /api/analysis/extremes?symbol=BTCUSDT[&market=futures]. */
export async function handleExtremeForecast(request: Request, _env: MarketEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
  const market = url.searchParams.get("market") || "spot";
  if (market !== "spot" && market !== "futures") return reply({ error: "invalid_market" }, 400);
  const category = url.searchParams.get("category") || (market === "futures" ? "linear" : "spot");
  if (!(["spot", "linear", "inverse"] as string[]).includes(category) || (market === "spot" && category !== "spot") || (market === "futures" && category === "spot"))
    return reply({ error: "invalid_category" }, 400);
  const params = { symbol, interval: "1h", limit: 1000, market: market as "spot" | "futures", category: category as "spot" | "linear" | "inverse" };
  const [hourly, daily, tick] = await Promise.allSettled([
    getMarketData("klines", params, ["bybit"]),
    getMarketData("klines", { ...params, interval: "1d" }, ["bybit"]),
    getMarketData("ticker", params, ["bybit"]),
  ]);
  if (hourly.status !== "fulfilled" || tick.status !== "fulfilled") {
    const failure = hourly.status === "rejected" ? hourly.reason : tick.status === "rejected" ? tick.reason : null;
    return reply({ error: "market_data_unavailable", detail: failure instanceof Error ? failure.message : "Bybit history or ticker unavailable.", provider: "bybit" }, 502);
  }
  const hourRows = Array.isArray(hourly.value.data) ? hourly.value.data as Kline[] : [];
  const dayRows = daily.status === "fulfilled" && Array.isArray(daily.value.data) ? daily.value.data as Kline[] : [];
  const ticker = tick.value.data as Ticker;
  const result = forecast24hExtremes(hourRows, dayRows, ticker, Date.now());
  if (result.status === "insufficient_history") return reply({ ...result, historyWarning: daily.status === "rejected" ? "Long-range daily candles unavailable; retry after data recovers." : null });
  const historyFallback = "history" in result && result.history?.priceSampleSource === "1h_fallback";
  return reply({ ...result, historyWarning: daily.status === "rejected" || historyFallback ? "Long-range daily candles unavailable; this estimate uses the available completed hourly sessions." : null });
}
