// Collects the evidence for the ETI Daily Intelligence Report by calling ETI's own engines in-process:
//   crypto   -> Precision engine (hard risk gates) + Market Readiness engine (Binance/Bybit/OKX public data)
//   forex    -> Readiness engine + signal engine on candles from the operator FX adapter (ETI_FX_CANDLES_URL)
//   gold     -> same FX adapter, symbol XAUUSD; readiness is market-level (schedule and calendar) because XAU is not an FX currency pair
//   stocks   -> Readiness engine + signal engine on Alpaca IEX candles (ALPACA_API_KEY / ALPACA_SECRET_KEY)
// A Worker invocation may make a limited number of subrequests (50 on the Free plan), so work is planned against a budget; assets that do not fit are
// reported as deferred, never guessed. Nothing here invents data: any failure becomes an "unavailable" asset with the reason.
import { handleReadiness, eventsFor, type ReadinessEnv } from "../readiness/api.ts";
import { handlePrecision } from "../precision/api.ts";
import { sourceFor, US_SYMBOL_RE, type PriceSource } from "../readiness/sources.ts";
import { signalFromCandles, MIN_CANDLES, type SignalResult } from "../signals.ts";
import { getMarketData, providerOrder, type Kline } from "../market.ts";
import type { PrecisionEnv } from "../precision/stores.ts";
import type { AssetResult, CollectedData, EventLite, ExchangeLite, ReadinessLite, SessionLite, SetupLite } from "./report.ts";

export type DailyEnv = ReadinessEnv & PrecisionEnv & {
  ETI_DAILY_STOCKS?: string; ETI_DAILY_SUBREQUEST_BUDGET?: string; ETI_DAILY_RISK_PCT?: string; ETI_DAILY_HOUR_UTC?: string; ETI_DAILY_ENABLED?: string;
};

/** Conservative estimates of subrequests per asset (market-data candles, depth, quote, reference series, plus the signal-engine candle fetch). */
export const COST = { events: 1, crypto: 19, forex: 10, gold: 2, stock: 10 } as const;
export const DEFAULT_BUDGET = 44, DEFAULT_RISK_PCT = 0.5, DEFAULT_STOCKS = ["AAPL", "MSFT", "NVDA"];
const HOUR = 3_600_000;

type Handler = (req: Request, env: any) => Promise<Response>;
interface Json { ok: boolean; status: number; body: any }
async function internal(handler: Handler, path: string, env: unknown): Promise<Json> {
  try {
    const res = await handler(new Request(`https://eti.internal${path}`), env);
    let body: any = null; try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) { return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : "unknown" } }; }
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const why = (j: Json) => String(j.body?.error ?? j.body?.message ?? (j.status ? `HTTP ${j.status}` : "request failed")) + (j.body?.detail ? `: ${j.body.detail}` : "");

export function liteReadiness(r: any): ReadinessLite | null {
  const o = r?.overall; if (!o || typeof o.status !== "string") return null;
  return {
    status: o.status, statusLabel: String(o.statusLabel ?? o.status), recommendation: String(o.recommendation ?? ""), reasons: strs(o.reasons), blockers: strs(o.blockers), caps: strs(o.caps),
    evaluated: Number(o.evaluated) || 0, notEvaluated: strs(o.notEvaluated), schedule: strs(o.schedule), liveConditionsApplied: !!o.liveConditionsApplied, label: String(o.label ?? ""),
    factors: (Array.isArray(o.factors) ? o.factors : []).map((f: any) => ({ id: Number(f.id), factor: String(f.factor ?? ""), rating: String(f.rating ?? ""), headline: String(f.headline ?? ""), detail: strs(f.detail) })),
    eventHits: (Array.isArray(o.eventHits) ? o.eventHits : []).map((h: any) => ({ title: String(h.title ?? ""), impact: String(h.impact ?? ""), time: String(h.time ?? ""), severity: String(h.severity ?? ""), phase: String(h.phase ?? "") })),
    closures: (Array.isArray(o.closures) ? o.closures : []).map((c: any) => ({ exchange: String(c.exchange ?? ""), date: String(c.date ?? ""), name: String(c.name ?? ""), kind: String(c.kind ?? "") })),
  };
}
const liteExchanges = (r: any): ExchangeLite[] => (Array.isArray(r?.exchanges) ? r.exchanges : []).map((e: any) => ({ exchange: String(e.exchange), name: String(e.name ?? e.exchange), open: !!e.open, reason: String(e.reason ?? ""), next: e.next ? { at: String(e.next.at), event: String(e.next.event) } : null, closureToday: e.closureToday ? String(e.closureToday) : null }));
const liteSessions = (r: any): SessionLite[] => (Array.isArray(r?.sessions) ? r.sessions : []).map((s: any) => ({ session: String(s.session), label: String(s.label ?? s.session), activeNow: !!s.activeNow, status: String(s.assessment?.status ?? ""), statusLabel: String(s.assessment?.statusLabel ?? ""), reason: String(s.assessment?.reasons?.[0] ?? "") })).filter((s: SessionLite) => s.status);

/** Precision-engine signal (crypto spot) -> report form. Validated means the engine's own decision.tradeable (all hard risk gates passed). */
export function setupFromPrecision(s: any): SetupLite {
  const dir = s?.direction === "BUY" || s?.direction === "SELL" ? s.direction : "NO TRADE";
  const entry = num(s?.entry), stop = num(s?.stopLoss), tps = (Array.isArray(s?.takeProfits) ? s.takeProfits : []).map((t: any) => num(t?.price)).filter((x: number | null): x is number => x !== null);
  const failed = (Array.isArray(s?.riskChecks) ? s.riskChecks : []).filter((g: any) => g?.status === "fail").map((g: any) => `${g.label}: ${g.detail}`);
  const validated = s?.decision?.tradeable === true && dir !== "NO TRADE" && entry !== null && stop !== null;
  const conf = s?.confidence, calibrated = conf?.type === "calibrated_probability";
  const blockers = validated ? [] : [...failed, ...strs(s?.decision?.reasons)];
  return {
    source: "precision", direction: validated ? dir : "NO TRADE", lean: dir === "NO TRADE" ? null : dir, validated, blockers: blockers.length || validated ? blockers : ["ETI Precision engine returned NO TRADE"],
    strategy: String(s?.strategy ?? "intraday"), timeframe: String(s?.setupTimeframe ?? ""), entry, stop, targets: tps,
    stopPct: num(s?.volatility?.stopPercent) ?? (entry && stop ? Math.abs(entry - stop) / entry * 100 : null),
    rewardRisk: num(s?.riskReward?.netToFinalTarget), rewardRiskBasis: `net of estimated costs to ${s?.riskReward?.finalTarget ?? "final target"}`,
    score: num(s?.opportunityScore?.value), scoreBand: typeof s?.opportunityScore?.band === "string" ? s.opportunityScore.band : null, conviction: null,
    confidenceNote: calibrated ? `calibrated probability ${(Number(conf.probability) * 100).toFixed(0)}%` : "confidence is qualitative (no validated calibration model)",
    winRate: null, samples: 0, atrPercent: num(s?.volatility?.atrPercent), volatility: typeof s?.volatility?.classification === "string" ? s.volatility.classification : null,
    liquidity: typeof s?.marketLiquidity?.status === "string" ? s.marketLiquidity.status : null, invalidation: strs(s?.invalidation), expiresAt: typeof s?.expiresAt === "string" ? s.expiresAt : null,
    asOf: typeof s?.dataTimestamp === "string" ? s.dataTimestamp : null, costsIncluded: true,
    hardChecks: s?.riskCheckSummary ? { passed: Number(s.riskCheckSummary.passed) || 0, failed: Number(s.riskCheckSummary.failed) || 0, notEvaluated: Number(s.riskCheckSummary.notEvaluated) || 0 } : null,
  };
}

/** Signal-engine result on candles (forex, gold, stocks) -> report form. Stricter than the engine's own tradeable flag: needs fresh candles and a replay edge. */
export function setupFromSignal(sig: SignalResult, interval: string, now: number, maxAgeMs = 3 * HOUR): SetupLite {
  const v = sig.historicalValidation, age = now - Date.parse(sig.asOf), blockers: string[] = [];
  if (!(age <= maxAgeMs && age >= -5 * 60_000)) blockers.push(`latest candle is ${Math.round(age / 60_000)} min old (market closed or data stale)`);
  if (sig.conviction !== "high" || sig.gatedAction === "WAIT") blockers.push(`conviction is ${sig.conviction} (score ${sig.score}); the quality gate needs |score| of at least 55`);
  if (v.status !== "computed" || v.winRate === null) blockers.push(`replay has only ${v.sampleCount} resolved samples (minimum 20)`);
  else if (v.winRate <= 50) blockers.push(`replay win rate ${v.winRate}% over ${v.sampleCount} samples is not above 50%`);
  const validated = blockers.length === 0, entry = sig.entry, stop = sig.stopLoss;
  return {
    source: "signal-engine", direction: validated ? sig.label : "NO TRADE", lean: sig.label, validated, blockers, strategy: "multi-method confluence", timeframe: interval,
    entry, stop, targets: sig.targets.map(t => t.price), stopPct: entry && stop ? Math.abs(entry - stop) / entry * 100 : null,
    rewardRisk: sig.targets[2]?.rewardRisk ?? null, rewardRiskBasis: "gross to TP3", score: sig.score, scoreBand: null, conviction: sig.conviction,
    confidenceNote: `heuristic score ${sig.score}, not a probability${v.winRate !== null ? `; replay win rate ${v.winRate}% (n=${v.sampleCount})` : ""}`,
    winRate: v.winRate, samples: v.sampleCount, atrPercent: sig.indicators ? Number(sig.indicators.atrPercent.toFixed(3)) : null, volatility: null, liquidity: null,
    invalidation: sig.invalidation, expiresAt: null, asOf: sig.asOf, costsIncluded: false, hardChecks: null,
  };
}

async function candleSetup(src: PriceSource, symbol: string, now: number): Promise<{ setup: SetupLite | null; price: AssetResult["price"]; error: string | null }> {
  try {
    const rows: Kline[] = await src.candles(symbol, "1h", 1000);
    const last = rows.at(-1); const price = last ? { last: last[4], asOf: new Date(last[0]).toISOString(), provider: src.name } : null;
    if (rows.length < MIN_CANDLES) return { setup: null, price, error: `only ${rows.length} hourly candles available (need ${MIN_CANDLES})` };
    const built = signalFromCandles(rows, symbol, src.name, "1h");
    return built ? { setup: setupFromSignal(built.signal, "1h", now), price, error: null } : { setup: null, price, error: "signal engine could not compute a result" };
  } catch (e) { return { setup: null, price: null, error: e instanceof Error ? e.message : "candle request failed" }; }
}
const statusOf = (r: ReadinessLite | null, setup: SetupLite | null): AssetResult["status"] => !r && !setup ? "unavailable" : r?.liveConditionsApplied && setup ? "evaluated" : "partial";

async function collectBitcoin(env: DailyEnv): Promise<{ asset: AssetResult; exchanges: ExchangeLite[]; sessions: SessionLite[] }> {
  const [r, p, t] = await Promise.all([
    internal(handleReadiness, "/api/readiness?market=crypto&symbol=BTCUSDT&strategy=intraday&scope=now", env),
    internal(handlePrecision, "/api/precision/signal?symbol=BTCUSDT&strategy=intraday", env),
    getMarketData("ticker", { symbol: "BTCUSDT", interval: "1m", limit: 1 }, providerOrder(env as any, null)).then(x => ({ ok: true as const, x }), () => ({ ok: false as const, x: null })),
  ]);
  const readiness = r.ok ? liteReadiness(r.body) : null, setup = p.ok ? setupFromPrecision(p.body) : null;
  const tk: any = t.ok ? t.x.data : null, last = num(tk?.lastPrice) ?? num(tk?.price) ?? num(tk?.last) ?? (typeof tk?.lastPrice === "string" ? Number(tk.lastPrice) : null);
  const notes = [!readiness ? `readiness unavailable (${why(r)})` : "", !setup ? `Precision engine unavailable (${why(p)})` : ""].filter(Boolean);
  return {
    asset: { key: "BTCUSD", label: "BTC/USD", instrument: "BTCUSDT spot (USDT proxy for BTC/USD)", market: "crypto", status: statusOf(readiness, setup), note: notes.length ? notes.join("; ") : null, readiness, setup,
      price: last !== null && Number.isFinite(last) ? { last, asOf: new Date().toISOString(), provider: t.ok ? String(t.x.provider) : null } : null },
    exchanges: r.ok ? liteExchanges(r.body) : [], sessions: r.ok ? liteSessions(r.body) : [],
  };
}
async function collectForex(env: DailyEnv, now: number): Promise<{ asset: AssetResult; sessions: SessionLite[] }> {
  const src = sourceFor("forex", env), [r, c] = await Promise.all([
    internal(handleReadiness, "/api/readiness?market=forex&symbol=EURUSD&strategy=intraday&scope=now", env),
    src ? candleSetup(src, "EURUSD", now) : Promise.resolve(null),
  ]);
  const readiness = r.ok ? liteReadiness(r.body) : null;
  const note = !src ? "No forex price feed is connected (set ETI_FX_CANDLES_URL): schedule and calendar conditions only, no setup can be computed." : !readiness ? `readiness unavailable (${why(r)})` : c?.error ? `setup unavailable (${c.error})` : null;
  return { asset: { key: "EURUSD", label: "EUR/USD", instrument: "EURUSD spot", market: "forex", status: statusOf(readiness, c?.setup ?? null), note, readiness, setup: c?.setup ?? null, price: c?.price ?? null }, sessions: r.ok ? liteSessions(r.body) : [] };
}
async function collectGold(env: DailyEnv, now: number): Promise<AssetResult> {
  const src = sourceFor("forex", env), [r, c] = await Promise.all([
    internal(handleReadiness, "/api/readiness?market=forex&strategy=intraday&scope=now", env),
    src ? candleSetup(src, "XAUUSD", now) : Promise.resolve(null),
  ]);
  const readiness = r.ok ? liteReadiness(r.body) : null;
  const note = !src ? "No forex/metals price feed is connected (set ETI_FX_CANDLES_URL; the adapter is asked for symbol XAUUSD): market-level schedule and calendar conditions only, no setup can be computed." : c?.error ? `setup unavailable (${c.error})` : "Readiness is market-level (forex schedule and USD calendar); gold's own live conditions are limited to the XAUUSD candle analysis.";
  return { key: "XAUUSD", label: "XAU/USD", instrument: "XAUUSD spot gold", market: "commodity", status: statusOf(readiness, c?.setup ?? null) === "evaluated" ? "partial" : statusOf(readiness, c?.setup ?? null), note, readiness, setup: c?.setup ?? null, price: c?.price ?? null };
}
async function collectStock(env: DailyEnv, symbol: string, now: number): Promise<AssetResult> {
  const src = sourceFor("equities", env), [r, c] = await Promise.all([
    internal(handleReadiness, `/api/readiness?market=equities&symbol=${encodeURIComponent(symbol)}&strategy=intraday&scope=now`, env),
    src ? candleSetup(src, symbol, now) : Promise.resolve(null),
  ]);
  const readiness = r.ok ? liteReadiness(r.body) : null;
  const note = !src ? "No equities feed is connected (set the ALPACA_API_KEY and ALPACA_SECRET_KEY secrets): no stock can be selected." : !readiness ? `readiness unavailable (${why(r)})` : c?.error ? `setup unavailable (${c.error})` : null;
  return { key: "STOCK", label: symbol, instrument: `${symbol} (US equity, IEX feed)`, market: "equities", status: statusOf(readiness, c?.setup ?? null), note, readiness, setup: c?.setup ?? null, price: c?.price ?? null };
}

export function parseStocks(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map(s => s.trim().toUpperCase()).filter(s => US_SYMBOL_RE.test(s));
  return [...new Set(list.length ? list : DEFAULT_STOCKS)].slice(0, 5);
}
export function budgetOf(env: { ETI_DAILY_SUBREQUEST_BUDGET?: string }): number { const n = Number(env.ETI_DAILY_SUBREQUEST_BUDGET); return Number.isFinite(n) && n >= 10 && n <= 900 ? Math.floor(n) : DEFAULT_BUDGET; }
export function riskPctOf(env: { ETI_DAILY_RISK_PCT?: string }): number { const n = Number(env.ETI_DAILY_RISK_PCT); return Number.isFinite(n) && n > 0 && n <= 5 ? n : DEFAULT_RISK_PCT; }

const rankStatus = (s?: string) => ["FAVOURABLE", "SELECTIVELY_FAVOURABLE", "UNCERTAIN", "HIGH_RISK", "AVOID_TRADING"].indexOf(s ?? "");
/** Best stock candidate: a validated setup beats none, then the better readiness verdict, then the higher score; unassessed candidates come last. */
export function pickStock(cands: AssetResult[]): AssetResult | null {
  if (!cands.length) return null;
  const key = (a: AssetResult) => [a.setup?.validated ? 0 : 1, a.readiness ? (rankStatus(a.readiness.status) < 0 ? 9 : rankStatus(a.readiness.status)) : 9, -(a.setup?.score ?? -999)];
  return [...cands].sort((x, y) => { const a = key(x), b = key(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; })[0];
}

export async function collectDailyData(env: DailyEnv, now = Date.now()): Promise<CollectedData> {
  const limit = budgetOf(env), stocks = parseStocks(env.ETI_DAILY_STOCKS);
  let used = 0; const deferred: string[] = [], fit = (cost: number, name: string) => { if (used + cost > limit) { deferred.push(name); return false; } used += cost; return true; };
  fit(COST.events, "economic calendar");
  const doCrypto = fit(COST.crypto, "BTC/USD"), doFx = fit(COST.forex, "EUR/USD"), doGold = fit(COST.gold, "XAU/USD"), stockRun = stocks.filter(s => fit(COST.stock, s));
  const skipped = (key: AssetResult["key"], label: string, instrument: string, market: AssetResult["market"]): AssetResult => ({ key, label, instrument, market, status: "deferred", note: "Skipped to stay inside the subrequest budget; raise ETI_DAILY_SUBREQUEST_BUDGET on a plan with more subrequests.", readiness: null, setup: null, price: null });

  const [events, btc, fx, gold, stockResults] = await Promise.all([
    eventsFor(env, now).catch(e => ({ status: "error" as const, sources: [] as string[], events: [], invalid: 0, error: e instanceof Error ? e.message : "calendar failed", fetchedAt: now })),
    doCrypto ? collectBitcoin(env) : Promise.resolve(null),
    doFx ? collectForex(env, now) : Promise.resolve(null),
    doGold ? collectGold(env, now) : Promise.resolve(null),
    Promise.all(stockRun.map(s => collectStock(env, s, now))),
  ]);
  const evs: EventLite[] = events.events.filter(e => e.time >= now - 24 * HOUR && e.time <= now + 72 * HOUR).map(e => ({ title: e.title, impact: e.impact, category: e.category, time: new Date(e.time).toISOString(), currencies: e.currencies, markets: e.markets, symbols: e.symbols }));
  const picked = pickStock(stockResults);
  const stockAsset: AssetResult = picked ? { ...picked, label: picked.label, candidates: stockResults.map(c => `${c.label}: ${c.readiness ? c.readiness.statusLabel : "not assessed"}${c.setup?.validated ? ", validated setup" : ""}`) }
    : skipped("STOCK", "Selected stock", "US equity watchlist", "equities");
  const assets: AssetResult[] = [
    fx?.asset ?? skipped("EURUSD", "EUR/USD", "EURUSD spot", "forex"),
    gold ?? skipped("XAUUSD", "XAU/USD", "XAUUSD spot gold", "commodity"),
    btc?.asset ?? skipped("BTCUSD", "BTC/USD", "BTCUSDT spot (USDT proxy for BTC/USD)", "crypto"),
    stockAsset,
  ];
  return {
    now, assets, riskPerTradePct: riskPctOf(env), budget: { limit, used, deferred },
    calendar: { status: events.status, error: events.error ?? null, sources: events.sources, events: evs },
    exchanges: btc?.exchanges ?? [], sessions: { crypto: btc?.sessions ?? [], forex: fx?.sessions ?? [] },
  };
}
