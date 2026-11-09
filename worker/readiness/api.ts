// Read-only HTTP surface for the ETI Market Readiness Engine.
//   GET /api/readiness            ?market=crypto|forex|equities &symbol=BTCUSDT &strategy=intraday
//                                  &scope=now|hour|session|day  &day=today|tomorrow|YYYY-MM-DD  &hour=0-23 (UTC)  &session=london  &at=ISO  &format=json|text
//   GET /api/readiness/sessions   ?market=crypto &symbols=BTCUSDT,ETHUSDT   which assets suit each session (measured; FX is structural only)
//   GET /api/readiness/status     engine configuration: which inputs are connected
// It never places orders and never grants itself permission to trade. A failed data source lowers the verdict; it never raises it.
import { getMarketData, providerOrder, type Depth, type Kline, type MarketEnv, type Ticker } from "../market.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, type Strategy, type Timeframe } from "../algo/timeframes.ts";
import { DAY, FX_CURRENCIES, HOUR, SESSION_IDS, sessionActiveFor, sessionLabel, sessionWindow, structuralSessionFit, type MarketKind, type SessionId } from "./calendar.ts";
import { evaluationWindow, type Scope } from "./engine.ts";
import { loadEvents, type EventsEnv, type EventsState } from "./events.ts";
import { parseEvidence, type EvidenceFile } from "./evidence.ts";
import { buildReport, rateAssetSession, type AssetSessionRow } from "./report.ts";
import { buildSnapshot, historyStats, type MarketSnapshot } from "./snapshot.ts";
import { assess } from "./engine.ts";
import { sourceFor, type PriceSource, type SourceEnv } from "./sources.ts";
import { exchangeStatus, fxOpen } from "./calendar.ts";

export interface ReadinessEnv extends MarketEnv, EventsEnv, SourceEnv { ETI_EXECUTION_LOG?: KVNamespace }
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];
const MARKETS: MarketKind[] = ["crypto", "forex", "equities"];
const CRYPTO_RE = /^[A-Z0-9]{5,20}$/, STABLE_RE = /(USDT|USDC|BUSD|FDUSD)$/;
export const DEFAULT_BASKET = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"], DEFAULT_FX = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];

// Short-lived per-isolate cache so dashboard polling cannot hammer a third-party calendar feed.
let eventCache: { key: string; at: number; state: EventsState } | null = null;
export async function eventsFor(env: EventsEnv, now: number): Promise<EventsState> {
  const key = `${env.ETI_EVENT_FEED_URL ?? ""}|${env.ETI_EVENTS_JSON ?? ""}`;
  if (eventCache && eventCache.key === key && now - eventCache.at < 60_000 && eventCache.state.status === "loaded") return eventCache.state;
  const state = await loadEvents(env, now); eventCache = { key, at: now, state }; return state;
}

const fail = (message: string, extra: Record<string, unknown> = {}) => reply({ error: "invalid_request", message, ...extra }, 400);
export function inferMarket(symbol: string): MarketKind | null {
  if (STABLE_RE.test(symbol) && CRYPTO_RE.test(symbol)) return "crypto";
  if (/^[A-Z]{6}$/.test(symbol) && FX_CURRENCIES.includes(symbol.slice(0, 3)) && FX_CURRENCIES.includes(symbol.slice(3))) return "forex";
  return null;
}
const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Fetched { snapshot: MarketSnapshot | null; provider: string; failures: Record<string, string>; timeframesLoaded: string[] }
async function fetchSnapshot(env: MarketEnv, symbol: string, strategy: Strategy, now: number, live: boolean, provider: string | null): Promise<Fetched> {
  const order = providerOrder(env, provider), failures: Record<string, string> = {}, candles: Partial<Record<Timeframe, Kline[]>> = {}; let used = "unknown", hourly: Kline[] | null = null;
  const note = (k: string, e: unknown) => { failures[k] = e instanceof Error ? e.message : "unknown"; };
  const need = live ? TIMEFRAMES.filter(t => t !== "1h" && (DEFAULT_WEIGHTS[strategy][t] > 0 || t === EXECUTION_TF[strategy] || t === "4h" || t === "1d")) : [];
  const ref = symbol === "BTCUSDT" ? "ETHUSDT" : "BTCUSDT";
  const [h1, , depth, ticker, refK] = await Promise.all([
    getMarketData("klines", { symbol, interval: "1h", limit: 1000 }, order).then(r => { used = r.provider; return r.data as Kline[]; }).catch(e => { note("1h", e); return null; }),
    Promise.all(need.map(tf => getMarketData("klines", { symbol, interval: tf, limit: 300 }, order).then(r => { candles[tf] = r.data as Kline[]; }).catch(e => note(tf, e)))),
    live ? getMarketData("depth", { symbol, interval: "1m", limit: 100 }, order).then(r => r.data as Depth).catch(e => { note("depth", e); return null; }) : Promise.resolve(null),
    live ? getMarketData("ticker", { symbol, interval: "1m", limit: 1 }, order).then(r => r.data as Ticker).catch(e => { note("ticker", e); return null; }) : Promise.resolve(null),
    live ? getMarketData("klines", { symbol: ref, interval: "1h", limit: 300 }, order).then(r => r.data as Kline[]).catch(e => { note("reference", e); return null; }) : Promise.resolve(null),
  ]);
  hourly = h1; if (h1) candles["1h"] = h1.slice(-300);
  const snapshot = hourly ? buildSnapshot({ symbol, now, strategy, provider: used, candles, hourly, depth: depth ? { bids: depth.bids, asks: depth.asks, timestamp: now } : null, ticker, reference: refK ? { symbol: ref, hourly: refK } : null, failures, live }) : null;
  return { snapshot, provider: used, failures, timeframesLoaded: Object.keys(candles) };
}
/** Candles + top-of-book quote from a configured non-crypto source (Alpaca for US stocks, an operator FX adapter for forex). */
async function fetchViaSource(src: PriceSource, market: "forex" | "equities", symbol: string, strategy: Strategy, now: number, live: boolean): Promise<Fetched> {
  const failures: Record<string, string> = {}, candles: Partial<Record<Timeframe, Kline[]>> = {}, note = (k: string, e: unknown) => { failures[k] = e instanceof Error ? e.message : "unknown"; };
  const need = live ? TIMEFRAMES.filter(t => t !== "1h" && (DEFAULT_WEIGHTS[strategy][t] > 0 || t === EXECUTION_TF[strategy] || t === "4h" || t === "1d")) : [];
  const ref = market === "equities" ? (symbol === "SPY" ? "QQQ" : "SPY") : null;
  const [h1, , quote, refK] = await Promise.all([
    src.candles(symbol, "1h", 1000).catch(e => { note("1h", e); return null; }),
    Promise.all(need.map(tf => src.candles(symbol, tf, 300).then(r => { candles[tf] = r; }).catch(e => note(tf, e)))),
    live ? src.quote(symbol).catch(e => { note("quote", e); return null; }) : Promise.resolve(null),
    live && ref ? src.candles(ref, "1h", 300).catch(e => { note("reference", e); return null; }) : Promise.resolve(null),
  ]);
  if (h1) candles["1h"] = h1.slice(-300);
  const snapshot = h1 ? buildSnapshot({ symbol, now, strategy, provider: src.name, candles, hourly: h1, depth: null, quote, maxSpreadBps: market === "forex" ? 6 : 15, minBarsPerDay: market === "forex" ? 20 : 6, reference: refK && ref ? { symbol: ref, hourly: refK } : null, failures, live }) : null;
  return { snapshot, provider: src.name, failures, timeframesLoaded: Object.keys(candles) };
}
const marketOpenNow = (market: MarketKind, now: number) => market === "forex" ? fxOpen(now).open : market === "equities" ? exchangeStatus("NYSE", now).open : true;
async function loadEvidence(env: ReadinessEnv, symbol: string, strategy: string): Promise<EvidenceFile | null> {
  if (!env.ETI_EXECUTION_LOG) return null;
  try { const raw = await env.ETI_EXECUTION_LOG.get(`readiness:evidence:${symbol}:${strategy}`); return raw ? parseEvidence(JSON.parse(raw)) : null; } catch { return null; }
}

export async function handleReadiness(req: Request, env: ReadinessEnv): Promise<Response> {
  const url = new URL(req.url), q = url.searchParams, now = Date.now();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "access-control-allow-methods": "GET,OPTIONS" } });
  if (req.method !== "GET") return reply({ error: "method_not_allowed", note: "The readiness engine is analytical and read-only." }, 405);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/readiness/status") {
    const ev = await eventsFor(env, now);
    return reply({ engine: "ETI Market Readiness Engine", markets: { crypto: { priceData: "connected (Binance/Bybit/OKX public APIs)", factors: "all 12 evaluable" }, forex: { priceData: sourceFor("forex", env) ? "connected (operator FX adapter, top-of-book quote optional)" : "not connected: set ETI_FX_CANDLES_URL", factors: sourceFor("forex", env) ? "all factors except order-book depth; spread needs ETI_FX_QUOTE_URL" : "schedule, sessions, closures, holidays and calendar events only; verdict capped at UNCERTAIN when open" }, equities: { priceData: sourceFor("equities", env) ? "connected (Alpaca Market Data, IEX feed, US stocks/ETFs only)" : "not connected: set ALPACA_API_KEY and ALPACA_SECRET_KEY", factors: sourceFor("equities", env) ? "all factors except order-book depth; pass a US ticker as symbol" : "NYSE schedule, closures and calendar events only" } },
      economicCalendar: { status: ev.status, sources: ev.sources, events: ev.events.length, rejected: ev.invalid, error: ev.error ?? null, configure: "ETI_EVENT_FEED_URL (https JSON) and/or ETI_EVENTS_JSON; see docs/READINESS.md" }, strategyEvidence: { binding: "ETI_EXECUTION_LOG", keyFormat: "readiness:evidence:<SYMBOL>:<strategy>", bound: !!env.ETI_EXECUTION_LOG }, submitsOrders: false });
  }

  // ---- common parameters
  const rawSymbol = (q.get("symbol") || "").toUpperCase();
  const market = (q.get("market") || (rawSymbol ? inferMarket(rawSymbol) : "crypto") || "") as MarketKind;
  if (!MARKETS.includes(market)) return fail("Could not determine the market. Pass market=crypto|forex|equities.", { markets: MARKETS });
  const strategy = (q.get("strategy") || "intraday") as Strategy;
  if (!STRATEGIES.includes(strategy)) return fail("Unknown strategy.", { strategies: STRATEGIES });

  if (path === "/api/readiness/sessions") return handleSessions(env, q, market, now);
  if (path !== "/api/readiness" && path !== "/api/readiness/report") return reply({ error: "not_found" }, 404);

  const symbol = rawSymbol || (market === "crypto" ? "BTCUSDT" : "");
  if (market === "crypto" && !CRYPTO_RE.test(symbol)) return fail("Invalid crypto symbol.");
  if (market === "forex" && symbol && inferMarket(symbol) !== "forex") return fail("Forex symbols are six letters of two supported currencies, e.g. EURUSD.", { currencies: FX_CURRENCIES });
  if (market === "equities" && symbol && !/^[A-Z.\-]{1,10}$/.test(symbol)) return fail("Invalid equity symbol.");
  const scope = (q.get("scope") || (q.get("session") ? "session" : q.get("hour") ? "hour" : q.get("day") ? "day" : "now")) as Scope;
  if (!["now", "hour", "session", "day"].includes(scope)) return fail("scope must be now, hour, session or day.");
  const today = dayKeyOf(now), dayParam = q.get("day") || (scope === "day" || q.get("hour") ? "today" : "");
  const dayKey = dayParam === "today" ? today : dayParam === "tomorrow" ? dayKeyOf(now + DAY) : dayParam;
  let at = now, session: SessionId | undefined;
  if (dayKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !Number.isFinite(Date.parse(dayKey + "T00:00:00Z"))) return fail("day must be today, tomorrow or YYYY-MM-DD.");
    const t = Date.parse(dayKey + "T00:00:00Z"); if (t < Date.parse(today + "T00:00:00Z") || t > now + 14 * DAY) return fail("day must be between today and 14 days ahead.");
    at = Math.max(now, t);
  }
  if (scope === "hour") {
    const hp = q.get("hour"), atp = q.get("at");
    if (hp !== null) { if (!/^\d{1,2}$/.test(hp) || Number(hp) > 23) return fail("hour must be 0-23 (UTC)."); at = Date.parse((dayKey || today) + "T00:00:00Z") + Number(hp) * HOUR; }
    else if (atp) { at = Date.parse(atp); if (!Number.isFinite(at)) return fail("at must be an ISO 8601 timestamp."); }
    if (at + HOUR <= now) return fail("That hour has already ended.");
    if (at > now + 14 * DAY) return fail("Hour is more than 14 days ahead.");
  }
  if (scope === "session") { session = (q.get("session") || "") as SessionId; if (!SESSION_IDS.includes(session)) return fail("session must be one of the listed sessions.", { sessions: SESSION_IDS }); }
  const window = evaluationWindow({ scope, at, now, market, session, dayKey: dayKey || undefined });
  const src = market === "crypto" ? null : sourceFor(market, env);
  const needLive = (market === "crypto" || (!!src && !!symbol)) && window.start <= now + 2 * HOUR && window.end > now && marketOpenNow(market, now);
  const [events, evidence, data] = await Promise.all([
    eventsFor(env, now), symbol ? loadEvidence(env, symbol, strategy) : Promise.resolve(null),
    market === "crypto" ? fetchSnapshot(env, symbol, strategy, now, needLive, q.get("provider")) : src && symbol ? fetchViaSource(src, market, symbol, strategy, now, needLive) : Promise.resolve<Fetched>({ snapshot: null, provider: src?.name ?? "none", failures: {}, timeframesLoaded: [] }),
  ]);
  const report = buildReport({ now, at, scope, market, symbol, strategy, session, dayKey: dayKey || undefined, snapshot: data.snapshot, events, evidence });
  if (q.get("format") === "text") return new Response(report.text, { status: 200, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
  return reply({ ...report, request: { market, symbol: symbol || null, strategy, scope, window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() }, liveDataRequested: needLive },
    dataQuality: { provider: data.provider, timeframesLoaded: data.timeframesLoaded, failures: data.failures, priceData: market === "crypto" ? (data.snapshot ? "ok" : "unavailable") : !src ? "not_connected_for_this_market" : !symbol ? "no_symbol_given" : data.snapshot ? "ok" : "unavailable", economicCalendar: { status: events.status, sources: events.sources, events: events.events.length, rejected: events.invalid, error: events.error ?? null },
      strategyEvidence: evidence ? { source: evidence.source, trades: evidence.trades.length, generatedAt: evidence.generatedAt } : null, history: data.snapshot?.history ? { bars: data.snapshot.history.bars, days: data.snapshot.history.days } : null },
    submitsOrder: false, liveExecutionAllowed: false });
}

async function handleSessions(env: ReadinessEnv, q: URLSearchParams, market: MarketKind, now: number): Promise<Response> {
  const events = await eventsFor(env, now), strategy = (q.get("strategy") || "intraday") as Strategy;
  const symbols = (q.get("symbols") || (market === "forex" ? DEFAULT_FX.join(",") : DEFAULT_BASKET.join(","))).toUpperCase().split(",").map(s => s.trim()).filter(Boolean).slice(0, 8);
  if (!symbols.length || (market === "crypto" && symbols.some(s => !CRYPTO_RE.test(s))) || (market === "forex" && symbols.some(s => inferMarket(s) !== "forex"))) return fail("Invalid symbols for this market.");
  if (market === "equities") return fail("Per-asset session ratings use FX/crypto session windows and do not apply to equities. Use /api/readiness with a US ticker as symbol for measured conditions.");
  const fx = market === "forex" ? sourceFor("forex", env) : null, measured = market === "crypto" || !!fx;
  const history: Record<string, ReturnType<typeof historyStats>> = {}, failures: Record<string, string> = {};
  if (fx) await Promise.all(symbols.map(s => fx.candles(s, "1h", 1000).then(r => { const known = r.some(k => k[5] > 0); history[s] = historyStats(known ? r : r.map(k => [k[0], k[1], k[2], k[3], k[4], 1] as Kline), now, { minBarsPerDay: 20, volumeKnown: known }); }).catch(e => { failures[s] = e instanceof Error ? e.message : "unknown"; history[s] = null; })));
  if (market === "crypto") await Promise.all(symbols.map(s => getMarketData("klines", { symbol: s, interval: "1h", limit: 1000 }, providerOrder(env, q.get("provider"))).then(r => { history[s] = historyStats(r.data as Kline[], now); }).catch(e => { failures[s] = e instanceof Error ? e.message : "unknown"; history[s] = null; })));
  const out = SESSION_IDS.map(id => {
    const w = sessionWindow(market, id, now), a = assess({ now, at: now, scope: "session", market, symbol: "", strategy, session: id, snapshot: null, events, evidence: null });
    const assets = symbols.map((s): AssetSessionRow | { symbol: string; structuralFit: string; basis: string } => measured ? rateAssetSession(history[s], id, s) : { symbol: s, structuralFit: structuralSessionFit(s, id), basis: "structural_schedule_not_measured" });
    const favourable = measured ? (assets as AssetSessionRow[]).filter(r => r.condition === "favourable").map(r => r.symbol) : (assets as { symbol: string; structuralFit: string }[]).filter(r => r.structuralFit === "primary").map(r => r.symbol);
    return { session: id, label: sessionLabel(id), activeNow: sessionActiveFor(market, id, now), window: w ? { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() } : null,
      scheduleAndEventStatus: { status: a.status, statusLabel: a.statusLabel, reasons: a.reasons.slice(0, 4), note: "Schedule and calendar view only; asset conditions are listed separately." }, assets, favourableAssets: favourable,
      note: measured ? "Conditions are measured relative to each asset's own weekday baseline from the available hourly history. They describe activity, not profitability." : "FX fit is structural (where each currency's home market trades), not measured: no FX price history is connected. Liquidity and spreads are unverified." };
  });
  return reply({ title: "ETI SESSION ANALYSIS", generatedAt: new Date(now).toISOString(), market, symbols, sessions: out, failures, economicCalendar: { status: events.status }, disclaimer: "No session is assumed to be profitable. Confirm a valid setup before any entry.", submitsOrder: false });
}
