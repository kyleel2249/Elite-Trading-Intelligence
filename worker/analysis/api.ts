// /api/analysis/* : read-only analytical endpoints. No endpoint here can place orders, and no credential is ever returned.
import { getMarketData, providerOrder, type Kline, type MarketEnv } from "../market.ts";
import { runOmnisignal } from "../algo/omnisignal.ts";
import { TIMEFRAMES as ALGO_TFS, type Timeframe as AlgoTf } from "../algo/timeframes.ts";
import { fetchCryptoFundamentals, fetchCurrencyMacro, fetchDollarTrend, fetchStockFundamentals, SourceError, type AnalysisEnv, type FetchFn } from "./fundamental-sources.ts";
import { cryptoFundamentals, fundamentalUnavailable, fxFundamentals, stockFundamentals } from "./fundamental.ts";
import { fetchNews, filterBySubject, subjectAliases, type NewsItem } from "./news-feeds.ts";
import { assessSentiment } from "./sentiment.ts";
import { closedCandles, MTF_TIMEFRAMES, multiTimeframeAnalysis, oneMinuteAppropriate, PROVIDER_INTERVAL, type MtfStrategy, type MtfTimeframe } from "./mtf.ts";
import { isFullAnalysis, technicalAnalysis } from "./technical.ts";
import { centralIntelligence } from "./intelligence.ts";
import { fetchYahooQuote, loadYahooCandles } from "./market-data-ext.ts";
import { calibrateTechnical } from "./calibrate.ts";
import { loadEvents, relevant, currenciesOf, type EventsEnv, type MarketEvent } from "../readiness/events.ts";
import { inferAssetClass, type AssetClass, type EngineReport } from "./types.ts";

export type AnalysisApiEnv = MarketEnv & AnalysisEnv & EventsEnv;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
export const STRATEGIES: MtfStrategy[] = ["scalp", "intraday", "swing", "position"];
export const MAX_BODY_CHARS = 2_000_000, MAX_CANDLES = 5000, MAX_NEWS_ITEMS = 500;

// ---- best-effort per-isolate rate limiting (Workers isolates are not shared, so this bounds bursts, not a global quota) ----
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimited(ip: string, cost: number, now = Date.now(), limit = 60): number | null {
  const b = buckets.get(ip);
  if (!b || b.reset <= now) { buckets.set(ip, { n: cost, reset: now + 60000 }); if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k); return null; }
  b.n += cost; return b.n > limit ? Math.ceil((b.reset - now) / 1000) : null;
}

// ---- input validation ----
export function parseSymbol(v: string | null | undefined): string | null { const s = (v ?? "").toUpperCase().trim(); return /^[A-Z0-9._-]{1,20}$/.test(s) ? s : null; }
export function sanitizeCandles(v: unknown, max = MAX_CANDLES): { rows: Kline[]; error?: string } {
  if (!Array.isArray(v)) return { rows: [], error: "candles must be an array of [openTimeMs, open, high, low, close, volume]" };
  if (v.length > max) return { rows: [], error: `too many candles (${v.length} > ${max})` };
  const byTime = new Map<number, Kline>();
  for (let i = 0; i < v.length; i++) {
    const r = v[i];
    if (!Array.isArray(r) || r.length < 6) return { rows: [], error: `candle ${i} must have 6 numbers` };
    const [t, o, h, l, c, vol] = r.slice(0, 6).map(Number);
    if (![t, o, h, l, c, vol].every(Number.isFinite)) return { rows: [], error: `candle ${i} contains a non-finite number` };
    if (t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0 || vol < 0) return { rows: [], error: `candle ${i} has a non-positive price/time or negative volume` };
    if (h < l || h < Math.max(o, c) - 1e-12 || l > Math.min(o, c) + 1e-12) return { rows: [], error: `candle ${i} is internally inconsistent (high/low do not bound open/close)` };
    byTime.set(t, [t, o, h, l, c, vol]);
  }
  return { rows: [...byTime.values()].sort((a, b) => a[0] - b[0]) };
}
async function readJson(req: Request): Promise<{ body?: any; error?: string }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_CHARS) return { error: "body_too_large" };
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return { error: "body_too_large" };
  try { const b = JSON.parse(text); return b && typeof b === "object" ? { body: b } : { error: "body_must_be_a_json_object" }; } catch { return { error: "invalid_json" }; }
}
const fetchFn: FetchFn = (u, i) => fetch(u, i);
/** Short-lived edge cache for slow-moving upstream data (fundamentals, news). Bypassed where the Cache API does not exist (tests, Node). */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>, worthCaching: (v: T) => boolean = () => true): Promise<T> {
  const store = (globalThis as any).caches?.default as Cache | undefined;
  if (!store) return fn();
  const req = new Request(`https://eti-analysis-cache.internal/${encodeURIComponent(key)}`);
  try { const hit = await store.match(req); if (hit) return (await hit.json()) as T; } catch { /* cache miss */ }
  const v = await fn();
  if (!worthCaching(v)) return v;
  try { await store.put(req, new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` } })); } catch { /* best effort */ }
  return v;
}

// ---- data loaders ----
async function loadCandles(symbol: string, tfs: MtfTimeframe[], env: AnalysisApiEnv, provider?: string | null) {
  const order = providerOrder(env, provider), candles: Partial<Record<MtfTimeframe, Kline[]>> = {}, failures: Record<string, string> = {}, used = new Set<string>();
  const intervals = [...new Set(tfs.map(t => PROVIDER_INTERVAL[t]))];
  await Promise.all(intervals.map(async iv => {
    try { const r = await getMarketData("klines", { symbol, interval: iv, limit: iv === "1M" ? 120 : 300 }, order); (candles as any)[iv] = r.data as Kline[]; used.add(r.provider); }
    catch (e) { failures[iv] = e instanceof Error ? e.message : "unknown"; }
  }));
  return { candles, failures, providers: [...used] };
}
const mtfFrames = (s: MtfStrategy): MtfTimeframe[] => MTF_TIMEFRAMES.filter(t => t !== "1m" || oneMinuteAppropriate(s));

/** Operator-configured economic/fundamental events (ETI_EVENT_FEED_URL / ETI_EVENTS_JSON) relevant to a symbol. Never invented: no source means none. */
export async function eventsFor(symbol: string, cls: AssetClass, env: EventsEnv, now: number): Promise<{ events: MarketEvent[]; status: string; notes: string[] }> {
  const st = await loadEvents(env, now).catch(() => null);
  if (!st || st.status !== "loaded") return { events: [], status: st?.status ?? "error", notes: [st?.status === "error" ? `Event feed error: ${st.error ?? "unknown"}` : "No event calendar configured (set ETI_EVENT_FEED_URL or ETI_EVENTS_JSON): scheduled-event risk is unverified, not clear."] };
  const market = cls === "fx" ? "forex" : cls === "stock" ? "equities" : "crypto", ctx = { market, symbol, currencies: currenciesOf(market, symbol) };
  return { events: st.events.filter(e => relevant(e, ctx) && e.time >= now - 3 * 86400000 && e.time <= now + 7 * 86400000), status: "loaded", notes: [`Events from ${st.sources.join(", ")}${st.invalid ? ` (${st.invalid} malformed row(s) dropped)` : ""}`] };
}
function applyEventRisk(rep: EngineReport, events: MarketEvent[], now: number, notes: string[]) {
  const soon = events.filter(e => e.impact === "high" && e.time > now && e.time - now <= 86400000);
  for (const e of soon) { const w = `Event risk: high-impact "${e.title}" at ${new Date(e.time).toISOString()} (within 24h) [${e.source}]`; if (!rep.warnings.includes(w)) rep.warnings.push(w); }
  if (soon.length) rep.extras = { ...(rep.extras ?? {}), eventRisk: true };
  if (events.length) notes.push(`${events.length} scheduled event(s) in the window; ${soon.length} high-impact within 24h`);
}
type FundResult = { report: EngineReport; notes: string[]; setup?: string };
function loadFundamental(symbol: string, cls: AssetClass, env: AnalysisApiEnv, now: number): Promise<FundResult> {
  return cached(`fund:${cls}:${symbol}`, 900, () => loadFundamentalUncached(symbol, cls, env, now), r => r.report.status !== "unavailable");
}
async function loadFundamentalUncached(symbol: string, cls: AssetClass, env: AnalysisApiEnv, now: number): Promise<FundResult> {
  try {
    if (cls === "crypto") {
      const { input, notes } = await fetchCryptoFundamentals(symbol, env, fetchFn, now), rep = cryptoFundamentals({ ...input, symbol: input.symbol ?? symbol, now }), ev = await eventsFor(symbol, "crypto", env, now);
      applyEventRisk(rep, ev.events, now, notes); if (ev.status !== "loaded") rep.warnings.push(ev.notes[0]);
      notes.push("Token unlock schedules are not fetched by the Worker (the Tokenomist adapter lives in the Python backend): feed them as events or POST `unlocks`.");
      return { report: rep, notes };
    }
    if (cls === "stock") {
      const { input, notes } = await fetchStockFundamentals(symbol, env, fetchFn, now);
      try {
        const q = await fetchYahooQuote(symbol, "stock", fetchFn);
        if (!input.marketCap && input.sharesOutstanding) { input.marketCap = q.price * input.sharesOutstanding; input.priceAsOf = new Date(q.time).toISOString(); notes.push("Market cap derived as latest price x latest cover-page share count; companies with several share classes may be understated."); input.sources = [...(input.sources ?? []), { name: "Yahoo Finance price", retrievedAt: new Date(now).toISOString() }]; }
      } catch (e) { notes.push(`Price unavailable (${e instanceof Error ? e.message : "error"}): valuation is not assessed.`); }
      const rep = stockFundamentals({ ...input, symbol, now }), ev = await eventsFor(symbol, "stock", env, now); applyEventRisk(rep, ev.events, now, notes); if (ev.status !== "loaded") rep.warnings.push(ev.notes[0]);
      return { report: rep, notes };
    }
    if (cls === "fx") {
      const base = symbol.slice(0, 3), quote = symbol.slice(3, 6), [b, q] = await Promise.all([fetchCurrencyMacro(base, env, fetchFn), fetchCurrencyMacro(quote, env, fetchFn)]);
      let dxy: Awaited<ReturnType<typeof fetchDollarTrend>> = null; try { dxy = await fetchDollarTrend(env, fetchFn); } catch { /* optional input */ }
      const ev = await eventsFor(symbol, "fx", env, now), econ = ev.events.flatMap(e => e.currencies.filter(c => c === base || c === quote).map(c => ({ name: e.title, currency: c, time: new Date(e.time).toISOString(), impact: e.impact, source: e.source })));
      const rep = fxFundamentals({ pair: symbol, base: b.macro, quote: q.macro, events: econ, dollarIndexChangePct: dxy ?? undefined, sources: [{ name: "FRED (St. Louis Fed)", url: "https://fred.stlouisfed.org", retrievedAt: new Date(now).toISOString() }], now });
      rep.missing.push(...b.missing, ...q.missing);
      if (ev.status !== "loaded") rep.warnings.push(ev.notes[0]);
      rep.warnings.push("Policy bias, where shown, is derived from the policy-rate trend, not central-bank guidance.");
      return { report: rep, notes: [...b.missing, ...q.missing, ...ev.notes] };
    }
    return { report: fundamentalUnavailable(symbol, "Unknown asset class: cannot choose a fundamental data source", ["asset class"], now), notes: [] };
  } catch (e) {
    if (e instanceof SourceError) return { report: fundamentalUnavailable(symbol, e.message, [`${e.source} data`], now), notes: [], setup: e.configure };
    return { report: fundamentalUnavailable(symbol, `Fundamental data failed: ${e instanceof Error ? e.message : "unknown error"}`, ["fundamental data"], now), notes: [] };
  }
}
async function loadNews(symbol: string, cls: AssetClass, env: AnalysisApiEnv, now: number) {
  const n = await cached("news:all", 300, () => fetchNews(env, fetchFn, now), r => r.items.length > 0), items = filterBySubject(n.items, subjectAliases(symbol, cls));
  const failures = n.feeds.filter(f => f.status === "failed").map(f => `${f.feed}: ${f.error}`);
  return { assessment: assessSentiment(symbol, items, now, { feedFailures: failures }), feeds: n.feeds, scanned: n.items.length, rejectedAtSource: n.rejected.length };
}

export async function handleAnalysis(req: Request, env: AnalysisApiEnv): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), now = Date.now();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return reply({ error: "method_not_allowed", note: "Analytical endpoints only; they cannot place orders." }, 405);
  if (path === "/api/analysis") return reply({ service: "ETI analysis engine", endpoints: ["/api/analysis/technical", "/api/analysis/mtf", "/api/analysis/fundamental", "/api/analysis/news", "/api/analysis/intelligence", "/api/analysis/calibrate"], methods: "GET fetches data server-side (crypto candles via exchange providers); POST analyses data you supply", strategies: STRATEGIES, timeframes: MTF_TIMEFRAMES,
    configured: { FRED_API_KEY: !!env.FRED_API_KEY, SEC_USER_AGENT: !!env.SEC_USER_AGENT, COINGECKO_API_KEY: !!env.COINGECKO_API_KEY, NEWS_FEEDS_JSON: !!env.NEWS_FEEDS_JSON }, submitsOrder: false });
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown", cost = path.endsWith("/intelligence") ? 6 : path.endsWith("/calibrate") ? 8 : path.endsWith("/mtf") ? 4 : 2, wait = rateLimited(ip, cost, now);
  if (wait !== null) return reply({ error: "rate_limited", retryAfterSeconds: wait }, 429, { "retry-after": String(wait) });
  const post = req.method === "POST";
  let body: any = {};
  if (post) { const j = await readJson(req); if (j.error) return reply({ error: j.error }, j.error === "body_too_large" ? 413 : 400); body = j.body; }
  const q = (k: string) => (post && body[k] !== undefined ? String(body[k]) : url.searchParams.get(k));
  const symbol = parseSymbol(q("symbol") ?? (path.endsWith("/technical") || path.endsWith("/mtf") || path.endsWith("/fundamental") || path.endsWith("/news") || path.endsWith("/intelligence") || path.endsWith("/calibrate") ? "BTCUSDT" : null));
  if (!symbol) return reply({ error: "invalid_symbol", expected: "1-20 characters from A-Z, 0-9, '.', '_' or '-'" }, 400);
  const stratRaw = (q("strategy") ?? "intraday") as MtfStrategy;
  if (!STRATEGIES.includes(stratRaw)) return reply({ error: "invalid_strategy", strategies: STRATEGIES }, 400);
  const clsRaw = q("assetClass") ?? q("class"), cls: AssetClass = clsRaw === "crypto" || clsRaw === "fx" || clsRaw === "stock" ? clsRaw : inferAssetClass(symbol);

  try {
    if (path === "/api/analysis/technical") {
      const tf = (q("timeframe") ?? q("interval") ?? "1h") as MtfTimeframe;
      let rows: Kline[], provider = "supplied";
      if (post) { const s = sanitizeCandles(body.candles); if (s.error) return reply({ error: "invalid_candles", detail: s.error }, 400); rows = s.rows; }
      else {
        if (!MTF_TIMEFRAMES.includes(tf) || tf === "1Y") return reply({ error: "invalid_timeframe", timeframes: MTF_TIMEFRAMES.filter(t => t !== "1Y") }, 400);
        if (cls === "crypto") { const r = await getMarketData("klines", { symbol, interval: PROVIDER_INTERVAL[tf], limit: 300 }, providerOrder(env, q("provider"))); rows = r.data as Kline[]; provider = r.provider; }
        else if (cls === "stock" || cls === "fx") {
          const y = await loadYahooCandles(symbol, cls, [tf], fetchFn), got = y.candles[tf];
          if (!got?.length) return reply({ error: "market_data_unavailable", detail: y.failures[tf] ?? "no candles returned", notes: y.notes }, 424);
          rows = got; provider = "yahoo-finance";
        } else return reply({ error: "market_data_unavailable", detail: `Unknown asset class for ${symbol}: pass ?assetClass= or POST candles` }, 424);
      }
      let bench: { symbol: string; candles: Kline[] } | undefined;
      if (post && body.benchmark?.candles) { const b = sanitizeCandles(body.benchmark.candles); if (b.error) return reply({ error: "invalid_benchmark_candles", detail: b.error }, 400); bench = { symbol: parseSymbol(String(body.benchmark.symbol ?? "BENCHMARK")) ?? "BENCHMARK", candles: b.rows }; }
      const a = technicalAnalysis(symbol, tf, tf === "1M" || tf === "1w" ? rows : closedCandles(tf, rows, now), { now, benchmark: bench, detail: q("detail") === "lite" ? "lite" : "full" });
      return reply(isFullAnalysis(a) ? { ...a, dataQuality: { provider, candles: rows.length } } : { report: a.report, dataQuality: { provider, candles: rows.length } }, isFullAnalysis(a) ? 200 : 422);
    }
    if (path === "/api/analysis/mtf" || path === "/api/analysis/intelligence") {
      const wantIntel = path.endsWith("/intelligence"), frames = mtfFrames(stratRaw);
      let yahooNotes: string[] = [], candles: Partial<Record<MtfTimeframe, Kline[]>> = {}, failures: Record<string, string> = {}, providers: string[] = [], mtfNote: string | null = null, bench: { symbol: string; candles: Partial<Record<MtfTimeframe, Kline[]>> } | undefined;
      if (post && body.candles) {
        if (typeof body.candles !== "object" || Array.isArray(body.candles)) return reply({ error: "candles_must_be_an_object_keyed_by_timeframe" }, 400);
        for (const [tf, v] of Object.entries(body.candles)) { if (!MTF_TIMEFRAMES.includes(tf as MtfTimeframe)) return reply({ error: "invalid_timeframe", timeframe: tf, timeframes: MTF_TIMEFRAMES }, 400); const s = sanitizeCandles(v); if (s.error) return reply({ error: "invalid_candles", timeframe: tf, detail: s.error }, 400); candles[tf as MtfTimeframe] = s.rows; }
      } else if (cls === "crypto") {
        const l = await loadCandles(symbol, frames, env, q("provider")); candles = l.candles; failures = l.failures; providers = l.providers;
        const benchSym = q("benchmark") ?? (symbol.startsWith("BTC") ? "none" : "BTCUSDT");
        if (benchSym !== "none" && parseSymbol(benchSym)) { const bs = parseSymbol(benchSym)!, lb = await loadCandles(bs, ["1w", "1d", "4h", "1h"], env, q("provider")); bench = { symbol: bs, candles: lb.candles }; }
      } else if (cls === "stock" || cls === "fx") {
        const y = await loadYahooCandles(symbol, cls, frames, fetchFn); candles = y.candles; failures = y.failures; providers = Object.keys(y.candles).length ? ["yahoo-finance"] : []; yahooNotes = y.notes;
      } else mtfNote = `Unknown asset class for ${symbol}: pass ?assetClass=crypto|fx|stock or POST candles.`;
      const hasCandles = Object.keys(candles).length > 0;
      const detail = q("detail") === "lite" ? "lite" : "full";
      const mtf = hasCandles ? multiTimeframeAnalysis({ symbol, strategy: stratRaw, candles, now, benchmark: bench, detail }) : null;
      if (!wantIntel) return mtf ? reply({ ...mtf, dataQuality: { providers, failures, notes: yahooNotes } }) : reply({ error: "market_data_unavailable", detail: mtfNote ?? "No candles could be loaded", failures }, 424);

      // central intelligence
      let fundamental: EngineReport | null = null, fundMissing: string | undefined, setup: string | undefined, fundNotes: string[] = [];
      let sentiment = null as ReturnType<typeof assessSentiment> | null, sentMissing: string | undefined, feeds: unknown = undefined;
      const tasks: Promise<void>[] = [];
      if (post && body.fundamental) {
        const fa = (body.fundamental.assetClass ?? cls) as AssetClass, data = body.fundamental.data ?? {};
        try { fundamental = fa === "crypto" ? cryptoFundamentals({ ...data, symbol, now }) : fa === "stock" ? stockFundamentals({ ...data, symbol, now }) : fa === "fx" ? fxFundamentals({ ...data, pair: symbol, now }) : null; if (!fundamental) return reply({ error: "invalid_fundamental_assetClass" }, 400); }
        catch (e) { return reply({ error: "invalid_fundamental_data", detail: e instanceof Error ? e.message : "unknown" }, 400); }
      } else tasks.push(loadFundamental(symbol, cls, env, now).then(r => { fundamental = r.report; fundNotes = r.notes; setup = r.setup; if (r.report.status === "unavailable") fundMissing = r.report.warnings[0]; }));
      if (post && Array.isArray(body.news)) {
        if (body.news.length > MAX_NEWS_ITEMS) return reply({ error: "too_many_news_items", max: MAX_NEWS_ITEMS }, 400);
        sentiment = assessSentiment(symbol, body.news as NewsItem[], now);
      } else tasks.push(loadNews(symbol, cls, env, now).then(r => { sentiment = r.assessment; feeds = r.feeds; }).catch(e => { sentMissing = `News ingestion failed: ${e instanceof Error ? e.message : "error"}`; }));
      await Promise.all(tasks);
      let omni = null as ReturnType<typeof runOmnisignal> | null;
      if (mtf && q("include")?.includes("omnisignal") && hasCandles) {
        try { const c: Partial<Record<AlgoTf, Kline[]>> = {}; for (const tf of ALGO_TFS) if (candles[tf as MtfTimeframe]) c[tf] = candles[tf as MtfTimeframe]; omni = runOmnisignal({ symbol, strategy: stratRaw, candles: c, now }); } catch { omni = null; }
      }
      const brief = centralIntelligence({ symbol, assetClass: cls, strategy: stratRaw, mtf, fundamental, sentiment, omnisignal: omni, now, fundamentalMissingReason: fundMissing, sentimentMissingReason: sentMissing ?? (mtfNote ?? undefined) });
      return reply({ ...brief, technicalDetail: mtf ? { alignment: mtf.alignment, layers: mtf.layers, timeframes: mtf.timeframes.map(t => ({ timeframe: t.timeframe, layer: t.layer, mode: t.mode, stance: t.report.stance, score: t.report.score, confidence: t.report.confidence, closedCandles: t.closedCandles })) } : null, dataQuality: { providers, notes: yahooNotes, detail, candleFailures: failures, newsFeeds: feeds, fundamentalNotes: fundNotes, setupRequired: setup ?? null, technicalNote: mtfNote } });
    }
    if (path === "/api/analysis/fundamental") {
      if (post) {
        const fa = (body.assetClass ?? cls) as AssetClass, data = body.data;
        if (!data || typeof data !== "object") return reply({ error: "data_object_required" }, 400);
        const rep = fa === "crypto" ? cryptoFundamentals({ ...data, symbol, now }) : fa === "stock" ? stockFundamentals({ ...data, symbol, now }) : fa === "fx" ? fxFundamentals({ ...data, pair: symbol, now }) : null;
        return rep ? reply(rep) : reply({ error: "invalid_assetClass", expected: ["crypto", "fx", "stock"] }, 400);
      }
      const r = await loadFundamental(symbol, cls, env, now);
      return reply({ ...r.report, notes: r.notes, setupRequired: r.setup ?? null }, r.report.status === "unavailable" ? 503 : 200);
    }
    if (path === "/api/analysis/calibrate") {
      const tf = (q("timeframe") ?? "1d") as MtfTimeframe, horizon = Math.min(100, Math.max(1, Number(q("horizon") ?? 10) || 10)), maxSamples = Math.min(300, Math.max(10, Number(q("maxSamples") ?? 80) || 80));
      let rows: Kline[];
      if (post) { const sc = sanitizeCandles(body.candles); if (sc.error) return reply({ error: "invalid_candles", detail: sc.error }, 400); rows = sc.rows; }
      else {
        if (!MTF_TIMEFRAMES.includes(tf) || tf === "1Y") return reply({ error: "invalid_timeframe" }, 400);
        if (cls === "crypto") rows = (await getMarketData("klines", { symbol, interval: PROVIDER_INTERVAL[tf], limit: 1000 }, providerOrder(env, q("provider")))).data as Kline[];
        else { const y = await loadYahooCandles(symbol, cls === "fx" ? "fx" : "stock", [tf], fetchFn); rows = y.candles[tf] ?? []; if (!rows.length) return reply({ error: "market_data_unavailable", detail: y.failures[tf] ?? "no candles" }, 424); }
      }
      if (rows.length < horizon + 140) return reply({ error: "insufficient_history", detail: `Need at least ${horizon + 140} candles, have ${rows.length}` }, 422);
      return reply({ symbol, ...calibrateTechnical(rows, { timeframe: tf, horizon, maxSamples, detail: "lite" }), note: "Technical engine only; fundamentals and news have no price-based history to calibrate against." });
    }
    if (path === "/api/analysis/news") {
      if (post) { if (!Array.isArray(body.items)) return reply({ error: "items_array_required" }, 400); if (body.items.length > MAX_NEWS_ITEMS) return reply({ error: "too_many_news_items", max: MAX_NEWS_ITEMS }, 400); return reply(assessSentiment(symbol, body.items as NewsItem[], now)); }
      const r = await loadNews(symbol, cls, env, now);
      return reply({ ...r.assessment, feeds: r.feeds, itemsScanned: r.scanned, rejectedAtSource: r.rejectedAtSource });
    }
    return reply({ error: "not_found", path }, 404);
  } catch (e) {
    return reply({ error: "analysis_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown error", submitsOrder: false }, 502);
  }
}
