/**
 * Data-provider registry. Providers are NOT interchangeable: each declares exactly which categories it can serve, how
 * (streaming, polling, delayed), what credentials that needs and what it cannot do. A category with no usable provider is
 * reported as uncovered rather than silently filled with another source's data.
 */
export const CATEGORIES = ["prices", "historical_ohlcv", "order_book", "fundamentals", "news", "economic_calendar", "onchain", "broker_execution", "exchange_execution"] as const;
export type Category = typeof CATEGORIES[number];
export type Level = "full" | "partial";
export type Delivery = "streaming" | "polling" | "delayed" | "on_demand";
export interface Capability { level: Level; delivery: Delivery; note: string }
export interface ProviderDef {
  id: string; label: string; kind: "market_data" | "exchange" | "broker" | "fundamental" | "macro" | "onchain" | "feed";
  capabilities: Partial<Record<Category, Capability>>;
  /** Worker env names that must all be present for the provider to be usable. Empty = public endpoints. */
  needs: string[];
  /** Freshness budget: a last success older than this counts as stale. */
  staleAfterSec: number;
  probe: (env: Record<string, any>) => { url: string; headers?: Record<string, string> } | null;
  limits: string;
}
const cap = (level: Level, delivery: Delivery, note: string): Capability => ({ level, delivery, note });
export const PROVIDERS: ProviderDef[] = [
  { id: "binance_spot", label: "Binance Spot (public market data)", kind: "exchange", needs: [], staleAfterSec: 600,
    capabilities: { prices: cap("full", "streaming", "WebSocket ticker plus REST"), historical_ohlcv: cap("full", "on_demand", "klines, up to 1000 bars per request"), order_book: cap("full", "streaming", "depth snapshots and diffs"), exchange_execution: cap("partial", "on_demand", "testnet orders only, and only with BINANCE_API_KEY/BINANCE_SECRET_KEY; no live path") },
    probe: () => ({ url: "https://data-api.binance.vision/api/v3/ping" }), limits: "Public weight limits per IP; shared Worker egress IPs can be throttled." },
  { id: "bybit", label: "Bybit (public market data)", kind: "exchange", needs: [], staleAfterSec: 900,
    capabilities: { prices: cap("full", "polling", "REST tickers"), historical_ohlcv: cap("full", "on_demand", "klines"), order_book: cap("partial", "on_demand", "REST snapshots only here") },
    probe: () => ({ url: "https://api.bybit.com/v5/market/time" }), limits: "Region restrictions can block some Cloudflare colos." },
  { id: "okx", label: "OKX (public market data)", kind: "exchange", needs: [], staleAfterSec: 900,
    capabilities: { prices: cap("full", "polling", "REST tickers"), historical_ohlcv: cap("partial", "on_demand", "candles") },
    probe: () => ({ url: "https://www.okx.com/api/v5/public/time" }), limits: "No order-book adapter in ETI." },
  { id: "coingecko", label: "CoinGecko (aggregated crypto prices)", kind: "market_data", needs: [], staleAfterSec: 1800,
    capabilities: { prices: cap("partial", "delayed", "aggregated, minutes of lag; not an execution price"), historical_ohlcv: cap("partial", "on_demand", "coarse granularity") },
    probe: () => ({ url: "https://api.coingecko.com/api/v3/ping" }), limits: "Strict free-tier rate limit." },
  { id: "alpaca", label: "Alpaca (US equities data and paper broker)", kind: "broker", needs: ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"], staleAfterSec: 900,
    capabilities: { prices: cap("partial", "delayed", "feed set by ALPACA_DATA_FEED; the free IEX feed is a single-venue subset, not the full consolidated tape"), historical_ohlcv: cap("full", "on_demand", "bars"), broker_execution: cap("partial", "on_demand", "paper trading account only") },
    probe: env => ({ url: "https://paper-api.alpaca.markets/v2/clock", headers: { "APCA-API-KEY-ID": String(env.ALPACA_API_KEY), "APCA-API-SECRET-KEY": String(env.ALPACA_SECRET_KEY) } }), limits: "Real-time SIP data needs a paid plan." },
  { id: "dexscreener", label: "DEX Screener (DEX pairs)", kind: "market_data", needs: [], staleAfterSec: 1800,
    capabilities: { prices: cap("partial", "polling", "DEX pair prices; thin pools can be stale or manipulated") },
    probe: () => ({ url: "https://api.dexscreener.com/token-profiles/latest/v1" }), limits: "No order book, no OHLCV adapter in ETI." },
  { id: "etherscan", label: "Etherscan (on-chain)", kind: "onchain", needs: ["ETHERSCAN_API_KEY"], staleAfterSec: 3600,
    capabilities: { onchain: cap("partial", "on_demand", "EVM address and transfer data; no Solana or Bitcoin") },
    probe: env => ({ url: "https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=" + encodeURIComponent(String(env.ETHERSCAN_API_KEY)) }), limits: "Per-key rate limit." },
  { id: "sec_edgar", label: "SEC EDGAR (filings)", kind: "fundamental", needs: ["SEC_USER_AGENT"], staleAfterSec: 86400,
    capabilities: { fundamentals: cap("partial", "delayed", "filings and insider forms for US issuers, published after the fact; not a ratios feed") },
    probe: env => ({ url: "https://data.sec.gov/submissions/CIK0000320193.json", headers: { "user-agent": String(env.SEC_USER_AGENT) } }), limits: "SEC requires a descriptive User-Agent and ~10 requests/second at most." },
  { id: "fred", label: "FRED (macro series)", kind: "macro", needs: ["FRED_API_KEY"], staleAfterSec: 86400,
    capabilities: { economic_calendar: cap("partial", "delayed", "macro time series with release dates; not an intraday event calendar") },
    probe: env => ({ url: "https://api.stlouisfed.org/fred/series?series_id=GDP&file_type=json&api_key=" + encodeURIComponent(String(env.FRED_API_KEY)) }), limits: "Series update on the publisher's schedule." },
  { id: "event_feed", label: "Operator event/news feed", kind: "feed", needs: ["ETI_EVENT_FEED_URL"], staleAfterSec: 3600,
    capabilities: { news: cap("partial", "polling", "whatever the operator's feed publishes"), economic_calendar: cap("partial", "polling", "whatever the operator's feed publishes") },
    probe: env => { try { const u = new URL(String(env.ETI_EVENT_FEED_URL)); if (u.protocol !== "https:") return null; return { url: u.toString(), headers: env.ETI_EVENT_FEED_TOKEN ? { authorization: "Bearer " + String(env.ETI_EVENT_FEED_TOKEN) } : undefined }; } catch { return null; } }, limits: "Coverage and licence depend entirely on the feed you point it at." },
];
export const configured = (p: ProviderDef, env: Record<string, any>) => p.needs.every(n => typeof env[n] === "string" && env[n].length > 0);
export const missingOf = (p: ProviderDef, env: Record<string, any>) => p.needs.filter(n => !(typeof env[n] === "string" && env[n].length > 0));

export type State = "unconfigured" | "unknown" | "ok" | "degraded" | "stale" | "down";
export interface Probe { at: number; ok: boolean; latencyMs: number | null; httpStatus: number | null; error: string | null }
export interface Health { lastCheckedAt: number | null; lastSuccessAt: number | null; latencyMs: number | null; consecutiveFailures: number; lastError: string | null; httpStatus: number | null }
export type HealthMap = Record<string, Health>;
export const emptyHealth = (): Health => ({ lastCheckedAt: null, lastSuccessAt: null, latencyMs: null, consecutiveFailures: 0, lastError: null, httpStatus: null });
export function applyProbe(h: Health | undefined, p: Probe): Health {
  const n = { ...(h ?? emptyHealth()) }; n.lastCheckedAt = p.at; n.httpStatus = p.httpStatus; n.latencyMs = p.latencyMs;
  if (p.ok) { n.lastSuccessAt = p.at; n.consecutiveFailures = 0; n.lastError = null; } else { n.consecutiveFailures += 1; n.lastError = p.error; }
  return n;
}
export function stateOf(p: ProviderDef, env: Record<string, any>, h: Health | undefined, now: number): State {
  if (!configured(p, env)) return "unconfigured";
  if (!h || h.lastCheckedAt === null) return "unknown";
  if (h.consecutiveFailures >= 2) return "down";
  if (h.lastSuccessAt === null || now - h.lastSuccessAt > p.staleAfterSec * 1000) return h.consecutiveFailures > 0 ? "down" : "stale";
  if (h.consecutiveFailures > 0 || (h.latencyMs ?? 0) > 3000) return "degraded";
  return "ok";
}
/** Probe one provider. Never throws; errors are reduced to short codes that cannot contain a credential. */
export async function probeProvider(p: ProviderDef, env: Record<string, any>, fetchImpl: typeof fetch, now: () => number, timeoutMs = 6000): Promise<Probe | null> {
  if (!configured(p, env)) return null;
  const spec = p.probe(env); if (!spec) return null;
  const t0 = now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(spec.url, { headers: spec.headers, signal: ctl.signal, redirect: "manual" }); try { await res.body?.cancel(); } catch { /* ignore */ }
    const ok = res.status >= 200 && res.status < 300;
    return { at: now(), ok, latencyMs: now() - t0, httpStatus: res.status, error: ok ? null : res.status === 401 || res.status === 403 ? "auth_rejected" : res.status === 429 ? "rate_limited" : res.status === 451 ? "region_blocked" : "http_" + res.status };
  } catch (e) { return { at: now(), ok: false, latencyMs: null, httpStatus: null, error: (e as Error)?.name === "AbortError" ? "timeout" : "network_error" }; }
  finally { clearTimeout(timer); }
}
const KEY = "providers:health";
export async function loadHealth(kv: any): Promise<HealthMap> { if (!kv) return {}; try { return JSON.parse((await kv.get(KEY)) || "{}") || {}; } catch { return {}; } }
export async function probeAll(env: Record<string, any>, kv: any, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<HealthMap> {
  const map = await loadHealth(kv), results = await Promise.all(PROVIDERS.map(async p => [p.id, await probeProvider(p, env, fetchImpl, now)] as const));
  for (const [id, pr] of results) if (pr) map[id] = applyProbe(map[id], pr);
  if (kv) await kv.put(KEY, JSON.stringify(map));
  return map;
}
export function report(env: Record<string, any>, health: HealthMap, now: number) {
  const providers = PROVIDERS.map(p => { const h = health[p.id], state = stateOf(p, env, h, now);
    return { id: p.id, label: p.label, kind: p.kind, state, configured: configured(p, env), missing: missingOf(p, env), capabilities: p.capabilities, limits: p.limits,
      freshness: { lastCheckedAt: h?.lastCheckedAt ?? null, lastSuccessAt: h?.lastSuccessAt ?? null, ageSec: h?.lastSuccessAt ? Math.round((now - h.lastSuccessAt) / 1000) : null, staleAfterSec: p.staleAfterSec, latencyMs: h?.latencyMs ?? null, consecutiveFailures: h?.consecutiveFailures ?? 0, lastError: h?.lastError ?? null } }; });
  const usable = (s: State) => s === "ok" || s === "degraded";
  const coverage = Object.fromEntries(CATEGORIES.map(c => { const rows = providers.filter(p => p.capabilities[c]); return [c, { status: rows.some(r => usable(r.state)) ? "covered" : rows.some(r => r.state === "unknown") ? "unverified" : "uncovered", providers: rows.map(r => ({ id: r.id, state: r.state, level: r.capabilities[c]!.level, delivery: r.capabilities[c]!.delivery })) }]; }));
  return { generatedAt: now, note: "Providers differ in coverage, permissions and timeliness. Nothing here is filled in from another source: an uncovered category has no data.", providers, coverage };
}
