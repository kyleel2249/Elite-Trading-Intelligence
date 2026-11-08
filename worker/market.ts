/**
 * ETI market-data layer (Cloudflare Worker, read-only, no credentials).
 *
 * - Providers: Binance spot (primary), Bybit spot, OKX spot. All three serve
 *   the same USDT spot pairs, so failover is between genuinely compatible
 *   markets (different venues -> prices can differ slightly; the serving
 *   provider is always reported in response headers).
 * - Alpaca and Liquid are intentionally NOT used here: Alpaca crypto data is
 *   quoted in USD (not USDT) and Liquid has no verified public base URL, so
 *   neither is compatible with these symbols. Execution credentials never
 *   touch this module.
 * - Nothing is fabricated: every payload is validated; invalid or empty data
 *   counts as a provider failure and triggers failover.
 */

export interface MarketEnv {
  /** Comma separated provider order, e.g. "binance,bybit,okx". */
  MARKET_PROVIDER_ORDER?: string;
}

export type ProviderId = "binance" | "bybit" | "okx";
export type Endpoint = "klines" | "depth" | "trades" | "ticker";
export type Kline = [number, number, number, number, number, number];

export interface Attempt {
  provider: ProviderId;
  host: string;
  status: number | null;
  ok: boolean;
  errorClass: string | null;
  latencyMs: number;
  detail?: string;
}

interface Params {
  symbol: string;
  interval: string;
  limit: number;
}

interface UpstreamRequest {
  path: string;
  query: Record<string, string>;
}

class Unsupported extends Error {}
class InvalidPayload extends Error {}

export const ALL_PROVIDERS: ProviderId[] = ["binance", "bybit", "okx"];
export const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"];

export const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
  "6h": 21600, "8h": 28800, "12h": 43200, "1d": 86400, "3d": 259200, "1w": 604800, "1M": 2592000,
};

const BYBIT_INTERVAL: Record<string, string> = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240",
  "6h": "360", "12h": "720", "1d": "D", "1w": "W", "1M": "M",
};
// "utc" variants align day/week/month candles with Binance's UTC boundaries.
const OKX_INTERVAL: Record<string, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H",
  "6h": "6H", "12h": "12H", "1d": "1Dutc", "3d": "3Dutc", "1w": "1Wutc", "1M": "1Mutc",
};

const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH"];
function okxSymbol(symbol: string): string {
  for (const q of QUOTES) {
    if (symbol.endsWith(q) && symbol.length - q.length >= 2) return symbol.slice(0, -q.length) + "-" + q;
  }
  throw new Unsupported("symbol_format");
}

const REQUEST_TIMEOUT_MS = 6000;
const UA = "ETI-MarketProxy/1.0 (Cloudflare Worker; read-only market data)";

// ---------------------------------------------------------------- helpers

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new InvalidPayload("non_numeric_value");
  return n;
}

export function classifyStatus(status: number): string {
  if (status === 403) return "http_403_blocked";
  if (status === 451) return "http_451_geo_restricted";
  if (status === 429 || status === 418) return "http_429_rate_limited";
  if (status === 401) return "http_401_unauthorized";
  if (status >= 500) return "http_5xx_upstream_error";
  if (status >= 400) return "http_4xx_rejected";
  return "http_unexpected";
}

// ------------------------------------------------------------- validation

export function validateKlines(rows: Kline[], limit: number): Kline[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new InvalidPayload("empty_klines");
  const byTime = new Map<number, Kline>();
  for (const r of rows) {
    const [t, o, h, l, c, v] = r;
    if (![t, o, h, l, c, v].every(Number.isFinite)) throw new InvalidPayload("non_finite_candle");
    if (t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) throw new InvalidPayload("non_positive_candle");
    if (l > h) throw new InvalidPayload("low_above_high");
    const eps = 1e-9;
    if (o < l * (1 - eps) || o > h * (1 + eps) || c < l * (1 - eps) || c > h * (1 + eps)) {
      throw new InvalidPayload("open_close_outside_range");
    }
    byTime.set(t, r);
  }
  const out = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  return out.slice(-limit);
}

export interface Depth { bids: [number, number][]; asks: [number, number][] }
export function validateDepth(d: Depth): Depth {
  const fix = (side: [number, number][]) => side.map(([p, q]) => {
    if (!(Number.isFinite(p) && p > 0 && Number.isFinite(q) && q >= 0)) throw new InvalidPayload("bad_book_level");
    return [p, q] as [number, number];
  }).filter(([, q]) => q > 0);
  const bids = fix(d.bids).sort((a, b) => b[0] - a[0]);
  const asks = fix(d.asks).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) throw new InvalidPayload("empty_order_book");
  if (bids[0][0] >= asks[0][0]) throw new InvalidPayload("crossed_order_book");
  return { bids, asks };
}

export interface Trade { time: number; price: number; qty: number; isBuyerMaker: boolean }
export function validateTrades(trades: Trade[]): Trade[] {
  if (!Array.isArray(trades) || !trades.length) throw new InvalidPayload("empty_trades");
  for (const t of trades) {
    if (!(Number.isFinite(t.time) && t.time > 0 && Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.qty) && t.qty > 0)) {
      throw new InvalidPayload("bad_trade");
    }
  }
  return [...trades].sort((a, b) => b.time - a.time);
}

export interface Ticker {
  symbol: string; lastPrice: number; priceChangePercent: number;
  highPrice: number; lowPrice: number; volume: number; quoteVolume: number;
}
function validateTicker(t: Ticker): Ticker {
  if (!(t.lastPrice > 0 && t.highPrice > 0 && t.lowPrice > 0 && t.volume >= 0)) throw new InvalidPayload("bad_ticker");
  return t;
}

// --------------------------------------------------------------- providers

interface ProviderSpec {
  hosts: string[];
  request(endpoint: Endpoint, p: Params): UpstreamRequest;
  parse(endpoint: Endpoint, json: any, p: Params): unknown;
}

const asArray = (v: unknown, what: string): any[] => {
  if (!Array.isArray(v)) throw new InvalidPayload(what);
  return v;
};

const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  binance: {
    // data-api.binance.vision is Binance's official market-data-only mirror.
    hosts: ["https://data-api.binance.vision", "https://api-gcp.binance.com", "https://api.binance.com"],
    request(endpoint, p) {
      if (endpoint === "klines") return { path: "/api/v3/klines", query: { symbol: p.symbol, interval: p.interval, limit: String(p.limit) } };
      if (endpoint === "depth") return { path: "/api/v3/depth", query: { symbol: p.symbol, limit: String(p.limit) } };
      if (endpoint === "trades") return { path: "/api/v3/trades", query: { symbol: p.symbol, limit: String(p.limit) } };
      return { path: "/api/v3/ticker/24hr", query: { symbol: p.symbol } };
    },
    parse(endpoint, j, p) {
      if (endpoint === "klines") {
        return validateKlines(asArray(j, "klines_not_array").map((r) => {
          const a = asArray(r, "kline_row");
          return [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])] as Kline;
        }), p.limit);
      }
      if (endpoint === "depth") {
        const lv = (x: unknown) => asArray(x, "book_side").map((r) => [num(r[0]), num(r[1])] as [number, number]);
        return validateDepth({ bids: lv(j.bids), asks: lv(j.asks) });
      }
      if (endpoint === "trades") {
        return validateTrades(asArray(j, "trades_not_array").map((t) => ({
          time: num(t.time), price: num(t.price), qty: num(t.qty), isBuyerMaker: Boolean(t.isBuyerMaker),
        })));
      }
      return validateTicker({
        symbol: p.symbol, lastPrice: num(j.lastPrice), priceChangePercent: num(j.priceChangePercent),
        highPrice: num(j.highPrice), lowPrice: num(j.lowPrice), volume: num(j.volume), quoteVolume: num(j.quoteVolume),
      });
    },
  },

  bybit: {
    hosts: ["https://api.bybit.com", "https://api.bytick.com"],
    request(endpoint, p) {
      if (endpoint === "klines") {
        const iv = BYBIT_INTERVAL[p.interval];
        if (!iv) throw new Unsupported("interval");
        return { path: "/v5/market/kline", query: { category: "spot", symbol: p.symbol, interval: iv, limit: String(Math.min(p.limit, 1000)) } };
      }
      if (endpoint === "depth") return { path: "/v5/market/orderbook", query: { category: "spot", symbol: p.symbol, limit: String(Math.min(p.limit, 200)) } };
      if (endpoint === "trades") return { path: "/v5/market/recent-trade", query: { category: "spot", symbol: p.symbol, limit: String(Math.min(p.limit, 60)) } };
      return { path: "/v5/market/tickers", query: { category: "spot", symbol: p.symbol } };
    },
    parse(endpoint, j, p) {
      if (!j || j.retCode !== 0 || !j.result) throw new InvalidPayload("bybit_rejected_" + (j && j.retCode));
      const r = j.result;
      if (endpoint === "klines") {
        return validateKlines(asArray(r.list, "klines_not_array").map((a) => [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])] as Kline), p.limit);
      }
      if (endpoint === "depth") {
        const lv = (x: unknown) => asArray(x, "book_side").map((a) => [num(a[0]), num(a[1])] as [number, number]);
        return validateDepth({ bids: lv(r.b), asks: lv(r.a) });
      }
      if (endpoint === "trades") {
        return validateTrades(asArray(r.list, "trades_not_array").map((t) => ({
          time: num(t.time), price: num(t.price), qty: num(t.size), isBuyerMaker: String(t.side).toLowerCase() === "sell",
        })));
      }
      const t = asArray(r.list, "ticker_list")[0];
      if (!t) throw new InvalidPayload("empty_ticker");
      return validateTicker({
        symbol: p.symbol, lastPrice: num(t.lastPrice), priceChangePercent: num(t.price24hPcnt) * 100,
        highPrice: num(t.highPrice24h), lowPrice: num(t.lowPrice24h), volume: num(t.volume24h), quoteVolume: num(t.turnover24h),
      });
    },
  },

  okx: {
    hosts: ["https://www.okx.com", "https://aws.okx.com"],
    request(endpoint, p) {
      const inst = okxSymbol(p.symbol);
      if (endpoint === "klines") {
        const bar = OKX_INTERVAL[p.interval];
        if (!bar) throw new Unsupported("interval");
        return { path: "/api/v5/market/candles", query: { instId: inst, bar, limit: String(Math.min(p.limit, 300)) } };
      }
      if (endpoint === "depth") return { path: "/api/v5/market/books", query: { instId: inst, sz: String(Math.min(p.limit, 400)) } };
      if (endpoint === "trades") return { path: "/api/v5/market/trades", query: { instId: inst, limit: String(Math.min(p.limit, 500)) } };
      return { path: "/api/v5/market/ticker", query: { instId: inst } };
    },
    parse(endpoint, j, p) {
      if (!j || j.code !== "0" || !Array.isArray(j.data)) throw new InvalidPayload("okx_rejected_" + (j && j.code));
      if (endpoint === "klines") {
        return validateKlines(j.data.map((a: any[]) => [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])] as Kline), p.limit);
      }
      if (endpoint === "depth") {
        const b = j.data[0];
        if (!b) throw new InvalidPayload("empty_order_book");
        const lv = (x: unknown) => asArray(x, "book_side").map((a) => [num(a[0]), num(a[1])] as [number, number]);
        return validateDepth({ bids: lv(b.bids), asks: lv(b.asks) });
      }
      if (endpoint === "trades") {
        return validateTrades(j.data.map((t: any) => ({
          time: num(t.ts), price: num(t.px), qty: num(t.sz), isBuyerMaker: String(t.side).toLowerCase() === "sell",
        })));
      }
      const t = j.data[0];
      if (!t) throw new InvalidPayload("empty_ticker");
      const open = num(t.open24h), last = num(t.last);
      return validateTicker({
        symbol: p.symbol, lastPrice: last, priceChangePercent: open > 0 ? ((last - open) / open) * 100 : 0,
        highPrice: num(t.high24h), lowPrice: num(t.low24h), volume: num(t.vol24h), quoteVolume: num(t.volCcy24h),
      });
    },
  },
};

// ------------------------------------------------------ runtime / telemetry

interface ProviderState { lastSuccessAt?: number; lastStatus?: number | null; lastErrorClass?: string | null; lastLatencyMs?: number; lastHost?: string }
// Per-isolate memory: resets when the isolate is recycled. Diagnostics say so.
const state: Record<ProviderId, ProviderState> = { binance: {}, bybit: {}, okx: {} };

function record(a: Attempt) {
  const s = state[a.provider];
  s.lastStatus = a.status; s.lastLatencyMs = a.latencyMs; s.lastHost = a.host; s.lastErrorClass = a.errorClass;
  if (a.ok) s.lastSuccessAt = Date.now();
}

export function providerOrder(env: MarketEnv, preferred?: string | null): ProviderId[] {
  const configured = (env.MARKET_PROVIDER_ORDER || "binance,bybit,okx")
    .split(",").map((s) => s.trim().toLowerCase()).filter((s): s is ProviderId => (ALL_PROVIDERS as string[]).includes(s));
  const base = configured.length ? configured : ALL_PROVIDERS;
  if (preferred && (ALL_PROVIDERS as string[]).includes(preferred) && base.includes(preferred as ProviderId)) {
    return [preferred as ProviderId, ...base.filter((p) => p !== preferred)];
  }
  return [...new Set(base)];
}

interface RawResult { status: number | null; text: string; latencyMs: number; errorClass: string | null; headers?: Headers }

async function fetchHost(host: string, req: UpstreamRequest): Promise<RawResult> {
  const url = host + req.path + "?" + new URLSearchParams(req.query).toString();
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Cache successes briefly; never cache upstream errors.
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 2, "400-599": 0 } },
    } as RequestInit);
    const text = await res.text();
    return { status: res.status, text, latencyMs: Date.now() - t0, errorClass: res.ok ? null : classifyStatus(res.status), headers: res.headers };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { status: null, text: "", latencyMs: Date.now() - t0, errorClass: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
  }
}

const snippet = (t: string) => t.replace(/\s+/g, " ").slice(0, 160);

export interface MarketResult { data: unknown; provider: ProviderId; attempts: Attempt[]; failover: boolean }
export class AllProvidersFailed extends Error {
  attempts: Attempt[];
  constructor(attempts: Attempt[]) { super("all_providers_failed"); this.attempts = attempts; }
}

export async function getMarketData(endpoint: Endpoint, p: Params, order: ProviderId[]): Promise<MarketResult> {
  const attempts: Attempt[] = [];
  for (const id of order) {
    const spec = PROVIDERS[id];
    let req: UpstreamRequest;
    try {
      req = spec.request(endpoint, p);
    } catch (e) {
      attempts.push({ provider: id, host: "-", status: null, ok: false, errorClass: "unsupported_by_provider", latencyMs: 0, detail: e instanceof Error ? e.message : undefined });
      continue; // not compatible -> skip, never substitute data
    }
    for (const host of spec.hosts) {
      const raw = await fetchHost(host, req);
      const base = { provider: id, host: host.replace("https://", ""), status: raw.status, latencyMs: raw.latencyMs };
      if (raw.errorClass) {
        const a: Attempt = { ...base, ok: false, errorClass: raw.errorClass, detail: snippet(raw.text) || undefined };
        attempts.push(a); record(a);
        if (raw.status === 400 || raw.status === 404) break; // same request will fail on mirrors
        continue;
      }
      try {
        const data = spec.parse(endpoint, JSON.parse(raw.text), p);
        const a: Attempt = { ...base, ok: true, errorClass: null };
        attempts.push(a); record(a);
        return { data, provider: id, attempts, failover: id !== order[0] };
      } catch (e) {
        const a: Attempt = { ...base, ok: false, errorClass: e instanceof InvalidPayload ? "invalid_payload" : "invalid_json", detail: e instanceof Error ? e.message : undefined };
        attempts.push(a); record(a);
      }
    }
  }
  throw new AllProvidersFailed(attempts);
}

// -------------------------------------------------------------- HTTP layer

const baseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "x-eti-provider,x-eti-failover,x-eti-attempts",
};
const jsonResp = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...baseHeaders, ...extra } });

const summary = (attempts: Attempt[]) => attempts.map((a) => a.provider + ":" + (a.ok ? "ok" : a.errorClass)).join(",");

let diagCache: { at: number; body: unknown } | null = null;

async function runDiagnostics(env: MarketEnv, symbol: string, interval: string): Promise<unknown> {
  if (diagCache && Date.now() - diagCache.at < 10_000) return diagCache.body;
  const params: Params = { symbol, interval, limit: 5 };
  const order = providerOrder(env);
  const intervalSec = INTERVAL_SECONDS[interval] || 60;
  const providers = await Promise.all(ALL_PROVIDERS.map(async (id) => {
    const spec = PROVIDERS[id];
    let req: UpstreamRequest;
    try { req = spec.request("klines", params); } catch (e) {
      return { provider: id, connectionStatus: "unsupported_for_request", hosts: [], detail: e instanceof Error ? e.message : "unsupported" };
    }
    const hosts = await Promise.all(spec.hosts.map(async (host) => {
      const raw = await fetchHost(host, req);
      let candles = 0, lastOpen: number | null = null, errorClass = raw.errorClass;
      if (!errorClass) {
        try {
          const rows = spec.parse("klines", JSON.parse(raw.text), params) as Kline[];
          candles = rows.length; lastOpen = rows[rows.length - 1][0];
        } catch (e) { errorClass = e instanceof InvalidPayload ? "invalid_payload" : "invalid_json"; }
      }
      const ageSeconds = lastOpen ? Math.round((Date.now() - lastOpen) / 1000) : null;
      const a: Attempt = { provider: id, host: host.replace("https://", ""), status: raw.status, ok: !errorClass, errorClass, latencyMs: raw.latencyMs };
      record(a);
      return {
        host: a.host, upstreamStatus: raw.status, ok: a.ok, errorClass, latencyMs: raw.latencyMs,
        bodySnippet: errorClass ? snippet(raw.text) || null : null,
        cfRay: raw.headers?.get("cf-ray") ?? null, server: raw.headers?.get("server") ?? null,
        candles, lastCandleOpen: lastOpen ? new Date(lastOpen).toISOString() : null, dataAgeSeconds: ageSeconds,
        freshness: ageSeconds === null ? null : ageSeconds <= intervalSec * 2 ? "fresh" : "stale",
      };
    }));
    const okHosts = hosts.filter((h) => h.ok);
    const s = state[id];
    return {
      provider: id,
      connectionStatus: okHosts.length === hosts.length ? "connected" : okHosts.length ? "degraded" : hosts.every((h) => h.upstreamStatus === 403 || h.upstreamStatus === 451) ? "blocked" : "unreachable",
      hosts,
      lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
    };
  }));
  const firstOk = order.find((id) => providers.find((p) => p.provider === id)?.connectionStatus !== "blocked" && providers.find((p) => p.provider === id)?.hosts.some((h: any) => h.ok));
  const body = {
    generatedAt: new Date().toISOString(), symbol, interval, configuredOrder: order,
    failover: { primary: order[0], selected: firstOk ?? null, active: !!firstOk && firstOk !== order[0], allProvidersDown: !firstOk },
    providers,
    notes: [
      "lastSuccessAt is kept in Worker isolate memory and may reset when the isolate is recycled.",
      "Alpaca and Liquid are not used for market data: Alpaca crypto is USD-quoted (not USDT) and Liquid has no verified base URL.",
      "No credentials are sent or reported by this endpoint.",
    ],
  };
  diagCache = { at: Date.now(), body };
  return body;
}

export async function handleMarket(request: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...baseHeaders, "access-control-allow-methods": "GET,OPTIONS" } });
  if (request.method !== "GET") return jsonResp({ error: "method_not_allowed" }, 405);
  const endpoint = url.pathname.slice("/api/market/".length);

  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const interval = url.searchParams.get("interval") || "1m";
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return jsonResp({ error: "invalid_symbol" }, 400);
  if (!INTERVALS.includes(interval)) return jsonResp({ error: "invalid_interval" }, 400);

  if (endpoint === "diag") return jsonResp(await runDiagnostics(env, symbol, interval));
  if (endpoint === "providers") {
    return jsonResp({
      order: providerOrder(env),
      providers: ALL_PROVIDERS.map((id) => ({
        id, hosts: PROVIDERS[id].hosts.map((h) => h.replace("https://", "")), market_data: true, authentication_required: false,
        lastSuccessAt: state[id].lastSuccessAt ? new Date(state[id].lastSuccessAt!).toISOString() : null,
        lastStatus: state[id].lastStatus ?? null, lastErrorClass: state[id].lastErrorClass ?? null,
      })),
    });
  }
  if (!["klines", "depth", "trades", "ticker"].includes(endpoint)) return jsonResp({ error: "not_found" }, 404);

  const defLimit = endpoint === "klines" ? "120" : endpoint === "depth" ? "20" : "50";
  const limitRaw = url.searchParams.get("limit") || defLimit;
  const max = endpoint === "depth" ? 100 : 1000;
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > max) return jsonResp({ error: "invalid_limit" }, 400);

  const order = providerOrder(env, url.searchParams.get("provider"));
  try {
    const r = await getMarketData(endpoint as Endpoint, { symbol, interval, limit: Number(limitRaw) }, order);
    return jsonResp(r.data, 200, { "x-eti-provider": r.provider, "x-eti-failover": String(r.failover), "x-eti-attempts": summary(r.attempts) });
  } catch (e) {
    if (e instanceof AllProvidersFailed) {
      const last = [...e.attempts].reverse().find((a) => a.status !== null);
      // Never disguise upstream failures as success: always a 502 with the real classification.
      return jsonResp({
        error: "market_data_unavailable",
        detail: last ? "upstream_http_" + last.status : "upstream_unreachable",
        classification: e.attempts.map((a) => a.errorClass).filter(Boolean)[0] ?? "unknown",
        attempts: e.attempts.map(({ provider, host, status, errorClass, latencyMs, detail }) => ({ provider, host, status, errorClass, latencyMs, detail })),
      }, 502, { "x-eti-attempts": summary(e.attempts) });
    }
    return jsonResp({ error: "internal_error" }, 500);
  }
}
