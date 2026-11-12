/**
 * Discovery pipeline: universe scan -> per-asset analysis -> fusion -> persistence -> predictions.
 * Every investigated candidate is recorded, including rejected ones with their reasons (the discovery database).
 * All network access goes through a Budget; when it runs out the scan stops and reports partial coverage.
 */
import { getMarketData, providerOrder, AllProvidersFailed, type Depth, type Kline, type MarketEnv, type Trade } from "../market.ts";
import { signalFromCandles, MIN_CANDLES } from "../signals.ts";
import { Budget, type FetchLike } from "./budget.ts";
import { analyseEarlyAlpha } from "./earlyalpha.ts";
import { runLab, summariseLab, type LabSummary, type LabResult } from "./lab.ts";
import { fuse, type Fused } from "./fusion.ts";
import { analyseFlow, bidSupportPersistence, flowEvidence, type FlowAnalysis } from "./flow.ts";
import { createPrediction, outcomeOfDiscovery, resolvePrediction, type Prediction } from "./ledger.ts";
import { AlphaStore } from "./store.ts";
import type { AssetClass, ExternalInputs } from "./types.ts";
import { type CopyEvaluation } from "./copytrade.ts";

// ----------------------------------------------------------------- market port
export interface MarketPort {
  klines(symbol: string, interval: string, limit: number): Promise<{ rows: Kline[]; provider: string } | null>;
  trades(symbol: string): Promise<Trade[] | null>;
  depth(symbol: string): Promise<Depth | null>;
}
export function livePort(env: MarketEnv, budget: Budget): MarketPort {
  const call = async (endpoint: "klines" | "trades" | "depth", symbol: string, interval: string, limit: number) => {
    if (!budget.take()) return null;
    try { return await getMarketData(endpoint, { symbol, interval, limit }, providerOrder(env)); } catch (e) { if (e instanceof AllProvidersFailed) return null; return null; }
  };
  return {
    async klines(s, i, l) { const r = await call("klines", s, i, l); return r ? { rows: r.data as Kline[], provider: r.provider } : null; },
    async trades(s) { const r = await call("trades", s, "1m", 500); return r ? r.data as Trade[] : null; },
    async depth(s) { const r = await call("depth", s, "1m", 100); return r ? r.data as Depth : null; },
  };
}

// ----------------------------------------------------------------- universe
export interface UniverseRow { symbol: string; base: string; last: number; quoteVolume: number; changePct: number; venue: string }
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
export const parseBinanceTickers = (j: any): UniverseRow[] => (Array.isArray(j) ? j : []).map((t: any) => ({ symbol: String(t.symbol), base: String(t.symbol).replace(/USDT$/, ""), last: num(t.lastPrice), quoteVolume: num(t.quoteVolume), changePct: num(t.priceChangePercent), venue: "binance" })).filter((r: UniverseRow) => /USDT$/.test(r.symbol));
export const parseBybitTickers = (j: any): UniverseRow[] => (j?.retCode === 0 && Array.isArray(j?.result?.list) ? j.result.list : []).map((t: any) => ({ symbol: String(t.symbol), base: String(t.symbol).replace(/USDT$/, ""), last: num(t.lastPrice), quoteVolume: num(t.turnover24h), changePct: num(t.price24hPcnt) * 100, venue: "bybit" })).filter((r: UniverseRow) => /USDT$/.test(r.symbol));
export const parseOkxTickers = (j: any): UniverseRow[] => (j?.code === "0" && Array.isArray(j?.data) ? j.data : []).filter((t: any) => /-USDT$/.test(String(t.instId))).map((t: any) => { const open = num(t.open24h), last = num(t.last); return { symbol: String(t.instId).replace("-", ""), base: String(t.instId).split("-")[0], last, quoteVolume: num(t.volCcy24h), changePct: open > 0 ? (last - open) / open * 100 : 0, venue: "okx" }; });
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDD", "PYUSD", "EUR", "EURI", "AEUR", "GBP", "TRY", "BRL", "USD1", "UST", "USDE", "XUSD", "RLUSD", "BFUSD"]);
export function filterUniverse(rows: UniverseRow[], minQuoteVolume = 1_000_000) {
  const dropped = { leveraged: 0, stable: 0, lowVolume: 0, invalid: 0 }, kept: UniverseRow[] = [];
  for (const r of rows) {
    if (!(r.last > 0) || !Number.isFinite(r.quoteVolume)) dropped.invalid++;
    else if (STABLES.has(r.base)) dropped.stable++;
    else if (/(UP|DOWN|BULL|BEAR)$/.test(r.base) && r.base.length > 4) dropped.leveraged++;
    else if (r.quoteVolume < minQuoteVolume) dropped.lowVolume++;
    else kept.push(r);
  }
  return { kept, dropped };
}
export async function fetchUniverse(b: Budget, f: FetchLike = fetch): Promise<{ rows: UniverseRow[]; venue: string | null; errors: string[] }> {
  const attempts: [string, string, (j: any) => UniverseRow[]][] = [
    ["binance", "https://data-api.binance.vision/api/v3/ticker/24hr", parseBinanceTickers], ["binance", "https://api.binance.com/api/v3/ticker/24hr", parseBinanceTickers],
    ["bybit", "https://api.bybit.com/v5/market/tickers?category=spot", parseBybitTickers], ["okx", "https://www.okx.com/api/v5/market/tickers?instType=SPOT", parseOkxTickers]];
  const errors: string[] = [];
  for (const [venue, url, parse] of attempts) {
    if (!b.take()) { errors.push("budget_exhausted"); break; }
    try { const r = await f(url, { headers: { accept: "application/json" } }); if (!r.ok) { errors.push(venue + "_http_" + r.status); continue; } const rows = parse(await r.json()); if (rows.length >= 20) return { rows, venue, errors }; errors.push(venue + "_empty"); } catch { errors.push(venue + "_network_error"); }
  }
  return { rows: [], venue: null, errors };
}

// -------------------------------------------------------------- per-asset analysis
export interface AnalyseParams { symbol: string; assetClass: AssetClass; interval: string; rows: Kline[]; provider: string; exchange: string; now: number; benchmark?: Kline[]; flow?: { analysis: FlowAnalysis; score: number | null; persistence?: { share: number; n: number; persistent: boolean } } | null; external?: ExternalInputs; copy?: CopyEvaluation[]; prev?: Fused | null; withLab: boolean; labCache?: LabSummary | null }
export interface Analysis { fused: Fused; lab: LabResult | null; labSummary: LabSummary | null; early: NonNullable<ReturnType<typeof analyseEarlyAlpha>>; engine: ReturnType<typeof signalFromCandles> }
export function analyseSymbol(p: AnalyseParams): Analysis | null {
  const ext: ExternalInputs = { ...(p.external ?? {}) };
  const early = analyseEarlyAlpha(p.rows, { assetClass: p.assetClass, interval: p.interval, benchmark: p.benchmark, external: ext }); if (!early) return null;
  const engine = p.rows.length >= MIN_CANDLES ? signalFromCandles(p.rows, p.symbol, p.provider, p.interval) : null;
  const lab = p.withLab ? runLab(p.rows, { symbol: p.symbol, interval: p.interval, assetClass: p.assetClass }) : null, labSummary = lab ? summariseLab(lab, p.now) : p.labCache ?? null;
  let invalidatedBy: string | null = null;
  if (p.prev?.plan && ["DEVELOPING_OPPORTUNITY", "CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY"].includes(p.prev.classification) && p.rows[p.rows.length - 1][4] < p.prev.plan.stop) invalidatedBy = "closed below the stop (" + p.prev.plan.stop + ") set when it was classified " + p.prev.classification;
  const fused = fuse({ symbol: p.symbol, assetClass: p.assetClass, interval: p.interval, exchange: p.exchange, provider: p.provider, now: p.now, rows: p.rows, early, signal: engine?.signal ?? null, lab, flow: p.flow?.analysis ?? null, flowScore: p.flow?.score ?? null, copy: p.copy, invalidatedBy });
  if (!lab && labSummary) { fused.strategyAgreement = labSummary.results.filter(r => r.kind !== "combination" && r.status !== "not_testable" && labSummary.latestVotes[r.id] === 1).map(r => ({ moduleId: r.id, name: r.name, traders: r.traders, status: r.status, oosExpectancyR: r.oosAvgR })); }
  return { fused, lab, labSummary, early, engine };
}

// ------------------------------------------------------------------ persistence
export interface Compact { symbol: string; assetClass: string; exchange: string; interval: string; classification: string; kind: string; executable: boolean; overall: number; early: number; technical: number | null; risk: number; liquidity: number; validation: number; price: number; stage: string; reasons: string[]; vetoes: string[]; firstSeen: number; lastExamined: number; newListing: boolean; history: { at: number; classification: string }[] }
const CLASS_RANK: Record<string, number> = { HIGH_CONVICTION_OPPORTUNITY: 6, CONFIRMED_OPPORTUNITY: 5, DEVELOPING_OPPORTUNITY: 4, EARLY_ACCUMULATION: 3, WATCHLIST: 2, INVALIDATED: 1, REJECTED: 0 };
export const compactOf = (f: Fused, prev: Compact | undefined, now: number, newListing: boolean): Compact => ({ symbol: f.symbol, assetClass: f.assetClass, exchange: f.exchange, interval: f.interval, classification: f.classification, kind: f.kind, executable: f.executable, overall: f.scores.overall, early: f.scores.early, technical: f.scores.technical, risk: f.scores.risk, liquidity: f.scores.liquidity, validation: f.scores.validation, price: f.price, stage: f.stage,
  reasons: (f.vetoes.length ? f.vetoes : f.reasons).slice(0, 3), vetoes: f.vetoes, firstSeen: prev?.firstSeen ?? now, lastExamined: now, newListing: newListing || !!prev?.newListing && now - (prev?.firstSeen ?? now) < 7 * 86400000, history: [...(prev && prev.classification !== f.classification ? [{ at: now, classification: f.classification }] : prev ? [] : [{ at: now, classification: f.classification }]), ...(prev?.history ?? [])].slice(0, 8) });
export const rankOf = (c: { classification: string; overall: number }) => (CLASS_RANK[c.classification] ?? 0) * 1000 + c.overall;
export async function saveAnalysis(store: AlphaStore, a: Analysis, now: number, newListing = false, extra: Record<string, unknown> = {}): Promise<Compact> {
  const f = a.fused, key = f.symbol + ":" + f.interval;
  let book = await store.get<Record<string, Compact>>("discoveries", {}); const c = compactOf(f, book[key], now, newListing); book[key] = c;
  const entries = Object.entries(book); if (entries.length > 900) { entries.sort((x, y) => y[1].lastExamined - x[1].lastExamined); book = Object.fromEntries(entries.slice(0, 900)); }
  await store.put("discoveries", book);
  await store.put("detail:" + key, { fused: f, early: a.early, engine: a.engine ? { action: a.engine.signal.action, score: a.engine.signal.score, conviction: a.engine.signal.conviction, tradeable: a.engine.signal.tradeable, regime: a.engine.signal.regime, evidence: a.engine.signal.evidence, statisticalEdge: a.engine.signal.statisticalEdge, strategyAttribution: a.engine.signal.strategyAttribution } : null, lab: a.labSummary, savedAt: now, ...extra }, 3 * 86400);
  if (a.labSummary && a.lab) await store.update<Record<string, LabSummary>>("labsummaries", {}, cur => { const n = { ...cur, [key]: a.labSummary! }; const k = Object.keys(n); if (k.length > 150) delete n[k.sort((x, y) => n[x].at - n[y].at)[0]]; return n; });
  return c;
}
export async function rebuildLeaderboard(store: AlphaStore, now: number) {
  const book = await store.get<Record<string, Compact>>("discoveries", {}); const list = Object.values(book).sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 200);
  await store.put("leaderboard", { updatedAt: new Date(now).toISOString(), entries: list }); return list;
}
async function maybePredict(store: AlphaStore, f: Fused) {
  const p = createPrediction(f); if (!p) return null;
  const preds = await store.get<Prediction[]>("predictions", []); if (preds.some(x => x.symbol === p.symbol && x.interval === p.interval && x.status === "open")) return null;
  await store.push("predictions", p, 1000); return p;
}

// --------------------------------------------------------------------- scans
export interface ScanCtx { env: MarketEnv & Record<string, any>; store: AlphaStore; budget: Budget; now: number; fetch: FetchLike; market: MarketPort }
export interface ScanReport { kind: string; startedAt: string; interval: string; universe: { size: number; kept: number; dropped: Record<string, number>; venue: string | null }; examined: { symbol: string; classification: string; overall: number }[]; newListings: string[]; predictionsCreated: number; errors: string[]; budget: { used: number; max: number }; partial: boolean; persistence: string }
export async function scanCrypto(ctx: ScanCtx, opts: { topN?: number; interval?: string; deepN?: number } = {}): Promise<ScanReport> {
  const { store, budget, now } = ctx, interval = opts.interval ?? "1h", topN = Math.min(opts.topN ?? 10, 30), deepN = Math.min(opts.deepN ?? 4, topN);
  const report: ScanReport = { kind: "crypto", startedAt: new Date(now).toISOString(), interval, universe: { size: 0, kept: 0, dropped: {}, venue: null }, examined: [], newListings: [], predictionsCreated: 0, errors: [], budget: { used: 0, max: budget.max }, partial: false, persistence: store.mode };
  const uni = await fetchUniverse(budget, ctx.fetch); report.errors.push(...uni.errors); report.universe.venue = uni.venue; report.universe.size = uni.rows.length;
  if (!uni.rows.length) { report.partial = true; report.budget.used = budget.used; await store.put("scan:crypto", report); return report; }
  const { kept, dropped } = filterUniverse(uni.rows); report.universe.kept = kept.length; report.universe.dropped = dropped;
  const seen = await store.get<Record<string, number>>("universe:seen", {}), baseline = Object.keys(seen).length === 0, fresh = baseline ? [] : kept.filter(r => !(r.symbol in seen)).map(r => r.symbol);
  const seenNext = { ...seen }; for (const r of uni.rows) if (!(r.symbol in seenNext)) seenNext[r.symbol] = now; await store.put("universe:seen", seenNext); report.newListings = fresh.slice(0, 20);
  const examined = await store.get<Record<string, number>>("examined:crypto", {}), stale = 4 * 3600_000;
  const pool = kept.filter(r => r.symbol !== "BTCUSDT" && now - (examined[r.symbol] ?? 0) > stale && r.changePct > -15).sort((a, b) => (fresh.includes(b.symbol) ? 1e18 : 0) + b.quoteVolume - ((fresh.includes(a.symbol) ? 1e18 : 0) + a.quoteVolume));
  const picks = pool.slice(0, topN);
  const bench = await ctx.market.klines("BTCUSDT", interval, 500), results: { r: UniverseRow; a: Analysis }[] = [];
  for (const r of picks) {
    const k = await ctx.market.klines(r.symbol, interval, 500); if (!k) { report.errors.push(r.symbol + ":no_candles"); if (budget.left <= 0) { report.partial = true; break; } continue; }
    const prev = (await store.get<any>("detail:" + r.symbol + ":" + interval, null))?.fused ?? null;
    const a = analyseSymbol({ symbol: r.symbol, assetClass: "crypto", interval, rows: k.rows, provider: k.provider, exchange: k.provider + " spot", now, benchmark: bench?.rows, withLab: false, prev, labCache: (await store.get<Record<string, LabSummary>>("labsummaries", {}))[r.symbol + ":" + interval] ?? null });
    if (a) results.push({ r, a }); else report.errors.push(r.symbol + ":insufficient_history");
    examined[r.symbol] = now;
  }
  await store.put("examined:crypto", Object.fromEntries(Object.entries(examined).filter(([, t]) => now - t < 3 * 86400000)));
  results.sort((x, y) => y.a.fused.scores.overall - x.a.fused.scores.overall);
  for (const [i, { r, a }] of results.entries()) {
    let final = a;
    if (i < deepN && a.fused.classification !== "REJECTED" && budget.left >= 3) {
      const [tr, dp] = [await ctx.market.trades(r.symbol), await ctx.market.depth(r.symbol)];
      const analysis = tr ? analyseFlow(tr, dp) : null; let persistence;
      if (analysis) { const samples = await store.get<number[]>("flow:" + r.symbol, []), next = [...samples, analysis.bookImbalance1pct].slice(-24); await store.put("flow:" + r.symbol, next, 7 * 86400); persistence = bidSupportPersistence(next); }
      const fe = analysis ? flowEvidence(analysis, persistence) : null;
      const k = await ctx.market.klines(r.symbol, interval, 500);
      if (k) { const re = analyseSymbol({ symbol: r.symbol, assetClass: "crypto", interval, rows: k.rows, provider: k.provider, exchange: k.provider + " spot", now, benchmark: bench?.rows, withLab: true, flow: analysis ? { analysis, score: fe?.score ?? null, persistence } : null, prev: a.fused }); if (re) final = re; }
    }
    const c = await saveAnalysis(store, final, now, fresh.includes(r.symbol), { flow: i < deepN ? "see fused.scores.orderFlow" : null });
    report.examined.push({ symbol: r.symbol, classification: c.classification, overall: c.overall });
    if (await maybePredict(store, final.fused)) report.predictionsCreated++;
  }
  await rebuildLeaderboard(store, now); report.budget.used = budget.used; report.partial = report.partial || budget.left <= 0;
  await store.put("scan:crypto", report); await store.audit("system", "scan_crypto", { examined: report.examined.length, errors: report.errors.length }, now); return report;
}

export async function resolveOpenPredictions(ctx: ScanCtx, maxSymbols = 6): Promise<{ checked: number; resolved: number }> {
  const preds = await ctx.store.get<Prediction[]>("predictions", []), open = preds.filter(p => p.status === "open"); let checked = 0, resolved = 0; const next = [...preds];
  const groups = new Map<string, Prediction[]>(); open.forEach(p => groups.set(p.symbol + "|" + p.interval, [...(groups.get(p.symbol + "|" + p.interval) ?? []), p]));
  for (const [key, list] of [...groups].slice(0, maxSymbols)) {
    const [symbol, interval] = key.split("|"); if (list[0].assetClass !== "crypto") continue; const k = await ctx.market.klines(symbol, interval, 1000); if (!k) continue; checked++;
    for (const p of list) { const r = resolvePrediction(p, k.rows, ctx.now), i = next.findIndex(x => x.id === p.id); if (i >= 0) { if (r.status !== "open") resolved++; next[i] = r; } }
  }
  await ctx.store.put("predictions", next); return { checked, resolved };
}
export async function resolveDiscoveryOutcomes(ctx: ScanCtx, maxSymbols = 4) {
  const book = await ctx.store.get<Record<string, Compact>>("discoveries", {}), outs = await ctx.store.get<Record<string, any>>("outcomes", {}); let n = 0;
  for (const c of Object.values(book).filter(c => c.assetClass === "crypto" && ["REJECTED", "WATCHLIST"].includes(c.classification) && !outs[c.symbol + ":" + c.interval + ":" + c.lastExamined])) {
    if (n >= maxSymbols || ctx.now - c.lastExamined < 24 * 3600_000 * 2) continue; const k = await ctx.market.klines(c.symbol, c.interval, 1000); if (!k) continue; n++;
    outs[c.symbol + ":" + c.interval + ":" + c.lastExamined] = outcomeOfDiscovery({ symbol: c.symbol, classification: c.classification, price: c.price, discoveredAt: c.lastExamined, horizonBars: 48, interval: c.interval }, k.rows);
  }
  const keys = Object.keys(outs); if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete outs[k]; await ctx.store.put("outcomes", outs); return n;
}
