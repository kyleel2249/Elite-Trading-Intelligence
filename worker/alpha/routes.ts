/**
 * /api/alpha/* routes and the scheduled research loop.
 * Reads are public (all data is public market or SEC data). Anything that spends quota, changes state or can place a paper order
 * requires the alpha token (ETI_ALPHA_TOKEN, falling back to ETI_EXECUTION_TOKEN). Live order endpoints are never reachable from here.
 */
import knowledgeData from "../knowledge.generated.json" with { type: "json" };
import { handleExecution, type ExecutionEnv } from "../execution.ts";
import { INTERVALS, type MarketEnv, type Kline } from "../market.ts";
import { Budget, type FetchLike } from "./budget.ts";
import { AlphaStore, type StoreEnv } from "./store.ts";
import { coverage, type CoverageEnv } from "./coverage.ts";
import { analyseSymbol, livePort, rebuildLeaderboard, resolveDiscoveryOutcomes, resolveOpenPredictions, saveAnalysis, scanCrypto, type Compact, type ScanCtx, type MarketPort } from "./scanner.ts";
import { discoverDex, discoverFilers, evaluateCopyForTicker, refreshInvestors, scanEquities, verifyAllEntities, type DexCandidate, type EntityState, type FilerCandidate, type ResearchEnv } from "./research.ts";
import { LAB_STRATEGIES, compatibility, poolSummaries, runLab, summariseLab, horizonOf, type LabSummary } from "./lab.ts";
import { accuracyOf, falseNegativeRate, type DiscoveryOutcome, type Prediction } from "./ledger.ts";
import { analyseFlow, analyseWallet, bidSupportPersistence, fetchWalletTransfers, flowEvidence, type WalletLabel } from "./flow.ts";
import { WATCH_ENTITIES, qualifyInvestor, secConfigured, type Disclosure, type WatchEntity } from "./sec.ts";
import { auditProfiles } from "./profiles.ts";
import { championChallenger, modelVersion } from "./monitor.ts";
import { DEFAULT_LIMITS, checkExposure, exposureOf, monitorPosition, recordOutcome, type PaperPosition, type StrategyPerf } from "./positions.ts";
import { fuse, independentValidation, sizePosition, type Fused } from "./fusion.ts";
import { equityConfigured, fetchEquityBars } from "./equities.ts";
import { consensusFor, evaluateDisclosure } from "./copytrade.ts";
import { page } from "./page.ts";
import type { AssetClass } from "./types.ts";

export interface AlphaEnv extends MarketEnv, ExecutionEnv, StoreEnv, CoverageEnv, ResearchEnv { ETI_ALPHA_TOKEN?: string; ALPHA_SUBREQUEST_BUDGET?: string }
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const ALPHA_INTERVALS = INTERVALS.filter(i => ["15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"].includes(i));

async function authorized(req: Request, env: AlphaEnv): Promise<boolean> {
  const token = env.ETI_ALPHA_TOKEN || env.ETI_EXECUTION_TOKEN, supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied) return false;
  const [a, b] = await Promise.all([token, supplied].map(v => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))), x = new Uint8Array(a), y = new Uint8Array(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0 && supplied.length === token.length;
}
const budgetOf = (env: AlphaEnv, dflt = 40) => new Budget(Math.min(900, Math.max(5, Number(env.ALPHA_SUBREQUEST_BUDGET) || dflt)));
export function makeCtx(env: AlphaEnv, now = Date.now(), f: FetchLike = fetch, market?: MarketPort, store = new AlphaStore(env)): ScanCtx {
  const budget = budgetOf(env); return { env, store, budget, now, fetch: f, market: market ?? livePort(env, budget) };
}
const symbolOk = (s: string, cls: string) => cls === "equity" ? /^[A-Z.]{1,6}$/.test(s) : /^[A-Z0-9]{5,20}$/.test(s);

/** Fresh end-to-end analysis of one asset (used by /fusion and by execution re-validation). */
export async function liveAnalysis(ctx: ScanCtx, env: AlphaEnv, symbol: string, assetClass: AssetClass, interval: string, withLab: boolean) {
  const { store, now } = ctx; let rows: Kline[], provider: string, exchange: string, bench: Kline[] | undefined, flow;
  if (assetClass === "equity") {
    const r = await fetchEquityBars(symbol, env, ctx.budget, ctx.fetch, now); if (!r.ok) return { error: r.reason };
    rows = r.data; provider = "alpaca"; exchange = "US equity (Alpaca " + (env.ALPACA_DATA_FEED === "sip" ? "SIP" : "IEX") + ")"; const spy = await fetchEquityBars("SPY", env, ctx.budget, ctx.fetch, now); bench = spy.ok ? spy.data : undefined;
  } else {
    const k = await ctx.market.klines(symbol, interval, 500); if (!k) return { error: "market_data_unavailable" }; rows = k.rows; provider = k.provider; exchange = k.provider + " spot";
    const b = symbol === "BTCUSDT" ? await ctx.market.klines("ETHUSDT", interval, 500) : await ctx.market.klines("BTCUSDT", interval, 500); bench = b?.rows;
    const tr = await ctx.market.trades(symbol), dp = await ctx.market.depth(symbol);
    if (tr) { const a = analyseFlow(tr, dp), samples = [...(await store.get<number[]>("flow:" + symbol, [])), a.bookImbalance1pct].slice(-24); await store.put("flow:" + symbol, samples, 7 * 86400); const per = bidSupportPersistence(samples); flow = { analysis: a, score: flowEvidence(a, per)?.score ?? null, persistence: per }; }
  }
  const prevDetail = await store.get<any>("detail:" + symbol + ":" + interval, null), copy = assetClass === "equity" ? await evaluateCopyForTicker(store, symbol, rows, interval, now) : [];
  const a = analyseSymbol({ symbol, assetClass, interval, rows, provider, exchange, now, benchmark: bench, withLab, flow, copy, prev: prevDetail?.fused ?? null, labCache: (await store.get<Record<string, LabSummary>>("labsummaries", {}))[symbol + ":" + interval] ?? null, external: copy.length ? { institutional: { score: Math.max(...copy.map(c => c.score)) / 100, evidence: copy.map(c => c.summary), sources: ["SEC EDGAR"] } } : undefined });
  if (!a) return { error: "insufficient_history" };
  return { analysis: a, flow: flow?.analysis ?? null, rows };
}

export async function handleAlpha(req: Request, env: AlphaEnv, now = Date.now(), f: FetchLike = fetch): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), q = url.searchParams, method = req.method;
  if (path === "/alpha") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (!path.startsWith("/api/alpha")) return err("not_found", 404);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { ...H, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" } });
  const sub = path.slice("/api/alpha".length) || "/", store = new AlphaStore(env), ctx = makeCtx(env, now, f, undefined, store);
  const needAuth = async () => (await authorized(req, env)) ? null : err("unauthorized", 401, { message: "Send Authorization: Bearer <ETI_ALPHA_TOKEN or ETI_EXECUTION_TOKEN>" });
  const body = async () => { try { return await req.json() as any; } catch { return null; } };
  const cls = (q.get("assetClass") || q.get("class") || "crypto") as AssetClass, interval = q.get("interval") || (cls === "equity" ? "1d" : "1h");
  if (!["crypto", "equity"].includes(cls)) return err("invalid_asset_class", 400);
  if (!(cls === "equity" ? interval === "1d" : ALPHA_INTERVALS.includes(interval))) return err("invalid_interval", 400, { allowed: cls === "equity" ? ["1d"] : ALPHA_INTERVALS });

  if (method === "GET") switch (sub) {
    case "/status": { const scans = { crypto: await store.get("scan:crypto", null), equity: await store.get("scan:equity", null) }; return json({ service: "ETI Global Alpha Intelligence", modelVersion: modelVersion(), persistence: store.mode, binding: store.binding, liveTradingEnabled: false, executionModes: ["paper", "testnet"], schedule: "every 15 minutes (see wrangler triggers)", scans, secConfigured: secConfigured(env), equityConfigured: equityConfigured(env), time: new Date(now).toISOString() }); }
    case "/coverage": return json(coverage(env, now));
    case "/leaderboard": { const lb = await store.get<{ updatedAt: string; entries: Compact[] }>("leaderboard", { updatedAt: "", entries: [] }); const min = Number(q.get("min") || 0), want = q.get("classification"); const entries = lb.entries.filter(e => e.overall >= min && (!want || e.classification === want) && (!q.get("assetClass") || e.assetClass === cls)); return json({ updatedAt: lb.updatedAt || null, count: entries.length, persistence: store.mode, entries, note: "Ranked by validated opportunity quality (classification, then overall score); early candidates are not executable trades." }); }
    case "/universe": { const book = await store.get<Record<string, Compact>>("discoveries", {}); let list = Object.values(book); if (q.get("classification")) list = list.filter(c => c.classification === q.get("classification")); if (q.get("assetClass")) list = list.filter(c => c.assetClass === cls); list.sort((a, b) => b.lastExamined - a.lastExamined); const dex = await store.get<DexCandidate[]>("dex", []); return json({ count: list.length, entries: list.slice(0, 500), dexTokens: dex.slice(0, 100), note: "Every investigated candidate is kept here, including rejected ones with the reasons that rejected them." }); }
    case "/candidate": { const sym = (q.get("symbol") || "").toUpperCase(); if (!symbolOk(sym, cls)) return err("invalid_symbol", 400); const d = await store.get<any>("detail:" + sym + ":" + interval, null); return d ? json(d) : err("not_found", 404, { message: "Not examined yet. GET /api/alpha/fusion?symbol=" + sym + " runs a fresh analysis." }); }
    case "/candles": {
      const sym = (q.get("symbol") || "").toUpperCase(); if (!symbolOk(sym, cls)) return err("invalid_symbol", 400);
      if (cls === "equity") { const r = await fetchEquityBars(sym, env, ctx.budget, f, now); return r.ok ? json({ symbol: sym, interval, rows: r.data.slice(-160) }) : err(r.reason, 503); }
      const k = await ctx.market.klines(sym, interval, 160); return k ? json({ symbol: sym, interval, provider: k.provider, rows: k.rows.slice(-160) }) : err("market_data_unavailable", 503);
    }
    case "/fusion": {
      const sym = (q.get("symbol") || "").toUpperCase(); if (!symbolOk(sym, cls)) return err("invalid_symbol", 400);
      const r = await liveAnalysis(ctx, env, sym, cls, interval, true); if ("error" in r) return err(r.error!, r.error === "insufficient_history" ? 422 : 503);
      await saveAnalysis(store, r.analysis, now, false, { flow: r.flow }); await rebuildLeaderboard(store, now); return json({ fused: r.analysis.fused, early: r.analysis.early, engine: r.analysis.engine ? { action: r.analysis.engine.signal.action, score: r.analysis.engine.signal.score, conviction: r.analysis.engine.signal.conviction, regime: r.analysis.engine.signal.regime, evidence: r.analysis.engine.signal.evidence, statisticalEdge: r.analysis.engine.signal.statisticalEdge, strategyAttribution: r.analysis.engine.signal.strategyAttribution } : null, lab: r.analysis.labSummary, flow: r.flow, budget: { used: ctx.budget.used, max: ctx.budget.max } });
    }
    case "/lab": { const sym = (q.get("symbol") || "").toUpperCase(); if (!symbolOk(sym, cls)) return err("invalid_symbol", 400); const k = cls === "equity" ? null : await ctx.market.klines(sym, interval, 1000); const rows = cls === "equity" ? await (async () => { const r = await fetchEquityBars(sym, env, ctx.budget, f, now); return r.ok ? r.data : null; })() : k?.rows; if (!rows) return err("market_data_unavailable", 503); const lab = runLab(rows, { symbol: sym, interval, assetClass: cls }); if (!lab) return err("insufficient_history", 422); const { trades, ...rest } = lab; await store.update<Record<string, LabSummary>>("labsummaries", {}, c => ({ ...c, [sym + ":" + interval]: summariseLab(lab, now) })); return json({ ...rest, tradeCounts: Object.fromEntries(Object.entries(trades).map(([k2, v]) => [k2, v.length])) }); }
    case "/lab/pooled": { const sums = Object.values(await store.get<Record<string, LabSummary>>("labsummaries", {})); const pool = poolSummaries(sums); return json({ ...pool, strategies: LAB_STRATEGIES.map(s => ({ id: s.id, name: s.name, traders: s.traders, kind: s.kind, testable: s.testable, requires: s.requires ?? null, assetClasses: s.assetClasses, horizons: s.horizons, preferredRegimes: s.preferredRegimes, note: s.note })), note: pool.markets ? "Pooled across " + pool.markets + " examined market(s); markets are correlated, so treat significance as optimistic." : "No market has been through the lab yet: run a scan or GET /api/alpha/lab?symbol=…" }); }
    case "/compat": { const id = q.get("strategy"); const regime = q.get("regime") as any; const list = id ? [id] : LAB_STRATEGIES.map(s => s.id); return json({ assetClass: cls, interval, horizon: horizonOf(interval), results: list.map(s => compatibility(s, { assetClass: cls, interval, regime: regime || undefined })) }); }
    case "/flow": { const sym = (q.get("symbol") || "").toUpperCase(); if (!symbolOk(sym, "crypto")) return err("invalid_symbol", 400); const tr = await ctx.market.trades(sym), dp = await ctx.market.depth(sym); if (!tr) return err("market_data_unavailable", 503); const a = analyseFlow(tr, dp), samples = [...(await store.get<number[]>("flow:" + sym, [])), a.bookImbalance1pct].slice(-24); await store.put("flow:" + sym, samples, 7 * 86400); return json({ symbol: sym, source: "exchange order flow (not on-chain)", analysis: a, persistence: bidSupportPersistence(samples), evidence: flowEvidence(a, bidSupportPersistence(samples)) }); }
    case "/investors/entities": { const st = await store.get<Record<string, EntityState>>("entities", {}), custom = await store.get<WatchEntity[]>("entities:custom", []); return json({ secConfigured: secConfigured(env), entities: [...WATCH_ENTITIES, ...custom].map(e => ({ ...e, verification: st[e.id]?.verification ?? { status: "unverified" }, lastCheckedAt: st[e.id]?.lastCheckedAt ? new Date(st[e.id].lastCheckedAt!).toISOString() : null })), note: "13F lags up to 45 days and shows only some long positions. Entities start unverified until EDGAR confirms the filer name." }); }
    case "/investors/candidates": return json({ criteria: { yearsDocumented: ">= 10", independentSources: ">= 2", primaryPerformanceRecord: "required", drawdownDisclosed: "required", methodologyDocumented: "required", wealthAlone: "never qualifies" }, candidates: await store.get<FilerCandidate[]>("investor:candidates", []) });
    case "/disclosures": { const all = await store.get<Disclosure[]>("disclosures", []); const t = q.get("ticker"), inv = q.get("investor"); const list = all.filter(d => (!t || d.ticker === t.toUpperCase()) && (!inv || d.investor.toLowerCase().includes(inv.toLowerCase()))); return json({ count: list.length, disclosures: list.slice(0, 300), note: "13F entries are delayed quarter-end snapshots, not current positions. Form 4 entries are confirmed transactions." }); }
    case "/copy": { const all = await store.get<Disclosure[]>("disclosures", []), custom = await store.get<WatchEntity[]>("entities:custom", []), ents = [...WATCH_ENTITIES, ...custom]; const evals = all.slice(0, 120).map(d => evaluateDisclosure(d, ents.find(e => e.id === d.entityId), null, consensusFor(d, all), now)); const by: Record<string, number> = {}; evals.forEach(e => { by[e.classification] = (by[e.classification] || 0) + 1; }); return json({ summary: by, evaluations: evals, note: "Evaluations here run without live market data, so adds are rejected for lack of it; GET /api/alpha/fusion?assetClass=equity&symbol=TICKER evaluates a ticker with current prices when Alpaca is configured." }); }
    case "/wallets": return json({ labels: await store.get<WalletLabel[]>("wallets", []), note: "ETI ships no unverified wallet labels. Add labels with a source and confidence; names are asserted only at confidence >= 0.8 with a source." });
    case "/wallets/activity": { const a = q.get("address") || ""; const r = await fetchWalletTransfers(a, Number(q.get("chainId") || 1), env.ETHERSCAN_API_KEY, ctx.budget, f); if (!r.ok) return err(r.reason, r.reason === "invalid_address" ? 400 : 503); return json(analyseWallet(a, r.data, await store.get<WalletLabel[]>("wallets", []), now)); }
    case "/dex": return json({ tokens: await store.get<DexCandidate[]>("dex", []), note: "Monitoring only: DEX tokens are never executable." });
    case "/predictions": { const p = await store.get<Prediction[]>("predictions", []); return json({ count: p.length, predictions: p.slice(0, 200), accuracy: accuracyOf(p) }); }
    case "/accuracy": { const p = await store.get<Prediction[]>("predictions", []), outs = Object.values(await store.get<Record<string, DiscoveryOutcome>>("outcomes", {})); return json({ predictions: accuracyOf(p), falseNegatives: falseNegativeRate(outs), note: "Computed only from predictions recorded at the time they were made." }); }
    case "/traders/audit": { const a = auditProfiles((knowledgeData as any).profiles); return json({ ...a, audits: q.get("all") ? a.audits : a.audits.filter(x => x.foundational) }); }
    case "/performance": {
      const sums = Object.values(await store.get<Record<string, LabSummary>>("labsummaries", {})), pool = poolSummaries(sums), perf = await store.get<Record<string, StrategyPerf>>("perf", {}), preds = await store.get<Prediction[]>("predictions", []), outs = Object.values(await store.get<Record<string, DiscoveryOutcome>>("outcomes", {}));
      const scans = [await store.get<any>("scan:crypto", null), await store.get<any>("scan:equity", null)].filter(Boolean), audit = auditProfiles((knowledgeData as any).profiles);
      return json({ modelVersion: modelVersion(), championChallenger: championChallenger(pool, perf), pooledLab: pool, paperTrading: Object.values(perf).map(p => ({ ...p, expectancyR: p.n ? Number((p.sumR / p.n).toFixed(2)) : null })), predictionAccuracy: accuracyOf(preds), falseNegatives: falseNegativeRate(outs), dataSourceReliability: scans.map(s => ({ scan: s.kind, at: s.startedAt, examined: s.examined.length, errors: s.errors.length, partial: s.partial, budget: s.budget })), profileCompleteness: { foundationalPresent: audit.foundationalPresent, evidenced: audit.evidenced, partial: audit.partial, seedText: audit.seedText } });
    }
    case "/positions": { const d = await needAuth(); if (d) return d; const pos = await store.get<PaperPosition[]>("positions", []); const equity = Number(q.get("equity")) || 0; return json({ open: pos.filter(p => p.status === "open"), closed: pos.filter(p => p.status === "closed").slice(0, 100), exposure: exposureOf(pos.filter(p => p.status === "open"), equity), limits: DEFAULT_LIMITS, protection: "virtual (checked each monitor run); the gateway does not place broker-side stop orders" }); }
    case "/audit": { const d = await needAuth(); return d ?? json({ entries: await store.get("audit", []) }); }
    default: return err("not_found", 404, { path });
  }

  if (method === "POST") {
    const denied = await needAuth(); if (denied) return denied;
    switch (sub) {
      case "/scan": { const b = (await body()) ?? {}, kind = b.kind || "crypto"; const c = makeCtx(env, now, f, undefined, store); if (kind === "crypto") return json(await scanCrypto(c, { topN: b.topN, interval: ALPHA_INTERVALS.includes(b.interval) ? b.interval : "1h" })); if (kind === "equity") return json(await scanEquities(c, env, { topN: b.topN })); if (kind === "dex") return json(await discoverDex(c)); if (kind === "investors") return json(await refreshInvestors(c, env, { maxEntities: b.maxEntities })); if (kind === "filers") return json(await discoverFilers(c, env)); return err("invalid_kind", 400, { allowed: ["crypto", "equity", "dex", "investors", "filers"] }); }
      case "/investors/verify": return json(await verifyAllEntities(ctx, env));
      case "/investors/entities": { const b = await body(); if (!b || !/^\d{1,10}$/.test(String(b.cik)) || typeof b.investor !== "string" || typeof b.entity !== "string" || typeof b.namePattern !== "string") return err("invalid_entity", 400, { required: ["investor", "entity", "cik", "namePattern"] }); try { new RegExp(b.namePattern); } catch { return err("invalid_name_pattern", 400); } const ent: WatchEntity = { id: "custom-" + String(b.cik).padStart(10, "0"), investor: b.investor.slice(0, 80), entity: b.entity.slice(0, 120), cik: String(b.cik).padStart(10, "0"), namePattern: b.namePattern.slice(0, 120), style: String(b.style || "unspecified").slice(0, 80), horizon: ["long_term", "medium_term", "high_turnover"].includes(b.horizon) ? b.horizon : "medium_term", followability: "limited", followNote: "user-added entity; followability defaults to limited until assessed" }; await store.update<WatchEntity[]>("entities:custom", [], c => [ent, ...c.filter(e => e.id !== ent.id)].slice(0, 50)); await store.audit("user", "add_entity", { cik: ent.cik }, now); return json({ ok: true, entity: ent, verification: "unverified until POST /api/alpha/investors/verify" }, 201); }
      case "/investors/candidates": { const b = await body(); if (!b || typeof b.name !== "string" || !b.evidence) return err("invalid_candidate", 400, { required: ["name", "evidence{yearsDocumented,independentSources,hasPrimaryPerformanceRecord,drawdownDisclosed,methodologyDocumented,wealthOnly}"] }); const e = b.evidence, ev = { yearsDocumented: Number(e.yearsDocumented) || 0, independentSources: Number(e.independentSources) || 0, hasPrimaryPerformanceRecord: e.hasPrimaryPerformanceRecord === true, drawdownDisclosed: e.drawdownDisclosed === true, methodologyDocumented: e.methodologyDocumented === true, wealthOnly: e.wealthOnly === true }, r = qualifyInvestor(ev); const rec: FilerCandidate = { cik: String(b.cik || "").padStart(10, "0"), name: b.name.slice(0, 120), filedOn: "", aumUsd: null, positions: null, top5Percent: null, status: r.status === "rejected" ? "rejected" : r.status === "qualified" ? "qualified" : "needs_evidence", missing: r.missing, discoveredAt: new Date(now).toISOString(), note: "evidence submitted by user: " + JSON.stringify(ev) }; await store.update<FilerCandidate[]>("investor:candidates", [], c => [rec, ...c].slice(0, 300)); await store.audit("user", "submit_investor_candidate", { name: rec.name, status: rec.status }, now); return json({ ok: true, qualification: r, record: rec }, 201); }
      case "/wallets": { const b = await body(); if (!b || !/^0x[0-9a-fA-F]{40}$/.test(String(b.address)) || typeof b.label !== "string") return err("invalid_wallet", 400, { required: ["address", "label", "kind", "source", "confidence"] }); const conf = Math.min(1, Math.max(0, Number(b.confidence) || 0)), w: WalletLabel = { address: String(b.address).toLowerCase(), label: b.label.slice(0, 100), kind: ["exchange", "fund", "treasury", "contract", "unknown"].includes(b.kind) ? b.kind : "unknown", source: typeof b.source === "string" && b.source.trim() ? b.source.slice(0, 200) : null, confidence: b.source ? conf : Math.min(conf, 0.5), addedAt: new Date(now).toISOString() }; await store.update<WalletLabel[]>("wallets", [], c => [w, ...c.filter(x => x.address !== w.address)].slice(0, 500)); await store.audit("user", "add_wallet_label", { address: w.address }, now); return json({ ok: true, label: w, note: w.source ? undefined : "No source given: confidence capped at 0.5 and the name will never be asserted" }, 201); }
      case "/predictions/resolve": return json(await resolveOpenPredictions(ctx));
      case "/execute/preview": case "/execute": return execute(req, env, ctx, store, sub === "/execute", await body());
      case "/positions/monitor": return json(await monitorPositions(ctx, env));
      default: return err("not_found", 404, { path });
    }
  }
  return err("method_not_allowed", 405);
}

// --------------------------------------------------------------------- execution bridge
async function execute(req: Request, env: AlphaEnv, ctx: ScanCtx, store: AlphaStore, submit: boolean, b: any) {
  if (!b) return err("invalid_json", 400);
  const symbol = String(b.symbol || "").toUpperCase(), assetClass: AssetClass = b.assetClass === "equity" ? "equity" : "crypto", interval = assetClass === "equity" ? "1d" : (ALPHA_INTERVALS.includes(b.interval) ? b.interval : "1h"), equity = Number(b.accountEquity), risk = Math.min(1, Number(b.riskPercent) || 0.25);
  if (!symbolOk(symbol, assetClass)) return err("invalid_symbol", 400); if (!(equity > 0)) return err("account_equity_required", 400, { message: "Send accountEquity (your paper/testnet account size) so the position can be sized and exposure-checked." });
  if (env.ETI_KILL_SWITCH === "true") return err("execution_disabled", 423, { reason: "Emergency kill switch is active" });
  const stored = await store.get<any>("detail:" + symbol + ":" + interval, null), steps: { step: string; pass: boolean; detail: string }[] = [], step = (s: string, pass: boolean, detail: string) => steps.push({ step: s, pass, detail });
  step("discovered", !!stored, stored ? "examined at " + new Date(stored.savedAt).toISOString() : "not in the discovery database; run a scan or /fusion first");
  step("stored_executable", !!stored?.fused?.executable, stored?.fused ? stored.fused.classification + " / " + stored.fused.executableReason : "n/a");
  step("stored_fresh", !!stored && ctx.now - stored.savedAt <= 24 * 3600_000, stored ? "age " + Math.round((ctx.now - stored.savedAt) / 60000) + " min (max 1440)" : "n/a");
  const live = await liveAnalysis(ctx, env, symbol, assetClass, interval, false);
  if ("error" in live) { step("fresh_data", false, live.error!); return json({ approved: false, steps }, 409); }
  const f: Fused = live.analysis.fused; step("fresh_data", true, "re-fetched " + live.rows.length + " candles from " + f.exchange);
  step("revalidated_executable", f.executable, f.classification + " / " + f.executableReason); step("independent_validation", f.validation.approved, f.validation.reasons.join("; ") || "all checks passed");
  const plan = f.plan, size = plan ? sizePosition({ equity, riskPercent: risk, entry: plan.entry, stop: plan.stop }) : null; step("position_size", !!size, size ? size.quantity + " units, notional " + size.notional + ", risk " + size.riskAmount : "no plan or invalid input");
  const qty = size ? (assetClass === "equity" ? Math.floor(size.quantity) : size.quantity) : 0; step("quantity_valid", qty > 0, assetClass === "equity" ? "whole shares only (" + qty + ")" : String(qty));
  const open = (await store.get<PaperPosition[]>("positions", [])).filter(p => p.status === "open"), ex = size ? checkExposure(open, { symbol, assetClass, notional: qty * (plan?.entry ?? 0) }, equity) : { ok: false, reasons: ["no size"] }; step("exposure_limits", ex.ok, ex.reasons.join("; ") || "within limits");
  const broker = assetClass === "equity" ? "alpaca" : "binance", ok = steps.every(s => s.pass);
  const response = { approved: ok, mode: assetClass === "equity" ? "paper (Alpaca)" : "testnet (Binance)", broker, symbol, plan, size: size && { ...size, quantity: qty }, classification: f.classification, steps, protectiveOrders: "virtual: stop and targets are monitored each run; no broker-side stop is placed", submit: submit ? undefined : "POST /api/alpha/execute with the same body to submit to the paper/testnet gateway" };
  if (!ok || !submit || !plan || !size) return json(response, ok ? 200 : 409);
  const clientOrderId = "alpha-" + symbol.toLowerCase() + "-" + ctx.now.toString(36);
  const strategyIds = f.strategyAgreement.map(s => s.moduleId);
  const gw = await handleExecution(new Request("https://internal/api/orders", { method: "POST", headers: { authorization: req.headers.get("authorization") || "", "content-type": "application/json" }, body: JSON.stringify({ broker, symbol, side: "buy", type: "market", quantity: qty, clientOrderId, riskConfirmed: true, executionSource: { actorType: "strategy", actorId: "eti-global-alpha", sourceName: f.classification + (strategyIds.length ? " [" + strategyIds.join(",") + "]" : "") } }) }), env);
  const gwBody: any = await gw.json().catch(() => ({}));
  if (gw.status !== 201 || (gwBody.mode !== "paper" && gwBody.mode !== "testnet")) return json({ ...response, submitted: false, gatewayStatus: gw.status, gateway: gwBody }, gw.status >= 400 ? gw.status : 502);
  const pos: PaperPosition = { id: "pos:" + clientOrderId, symbol, assetClass, broker, mode: gwBody.mode, qty, entry: plan.entry, stop: plan.stop, targets: plan.targets.map(t => t.price), openedAt: ctx.now, interval, strategyIds, classification: f.classification, clientOrderId, brokerOrderId: gwBody.order?.id ?? gwBody.order?.orderId ?? null, status: "open", tp1Touched: false, exitPrice: null, exitAt: null, exitReason: null, rMultiple: null, protection: "virtual_monitored" };
  await store.push("positions", pos, 300); await store.audit("system", "paper_order_submitted", { symbol, qty, mode: gwBody.mode, clientOrderId }, ctx.now);
  return json({ ...response, submitted: true, position: pos, gateway: { status: gw.status, mode: gwBody.mode, brokerOrderId: pos.brokerOrderId } }, 201);
}
export async function monitorPositions(ctx: ScanCtx, env: AlphaEnv) {
  const pos = await ctx.store.get<PaperPosition[]>("positions", []); let perf = await ctx.store.get<Record<string, StrategyPerf>>("perf", {}), closed = 0, checked = 0; const next = [...pos];
  for (const [i, p] of pos.entries()) {
    if (p.status !== "open") continue; let rows: Kline[] | null = null;
    if (p.assetClass === "crypto") rows = (await ctx.market.klines(p.symbol, p.interval, 1000))?.rows ?? null; else { const r = await fetchEquityBars(p.symbol, env, ctx.budget, ctx.fetch, ctx.now); rows = r.ok ? r.data : null; }
    if (!rows) continue; checked++; const upd = monitorPosition(p, rows, ctx.now, p.assetClass === "equity" ? 20 : 96); next[i] = upd; if (upd.status === "closed") { closed++; perf = recordOutcome(perf, upd); }
  }
  await ctx.store.put("positions", next); await ctx.store.put("perf", perf); return { checked, closed };
}

// ----------------------------------------------------------------------- scheduled loop
export async function runScheduled(env: AlphaEnv, now = Date.now(), f: FetchLike = fetch) {
  const log: Record<string, unknown> = {}, store = new AlphaStore(env), run = async (name: string, fn: (c: ScanCtx) => Promise<unknown>) => { try { log[name] = await fn(makeCtx(env, now, f, undefined, store)); } catch (e) { log[name] = { error: e instanceof Error ? e.message : "unknown" }; } };
  const minute = new Date(now).getUTCMinutes(), hour = new Date(now).getUTCHours();
  await run("crypto_scan", c => scanCrypto(c, { topN: 10, interval: "1h" }));
  await run("resolve_predictions", c => resolveOpenPredictions(c)); await run("monitor_positions", c => monitorPositions(c, env));
  if (minute < 15) { await run("equity_scan", c => scanEquities(c, env, { topN: 8 })); await run("sec_investors", c => refreshInvestors(c, env, { maxEntities: 3 })); await run("dex_discovery", c => discoverDex(c)); await run("discovery_outcomes", c => resolveDiscoveryOutcomes(c)); }
  if (hour === 7 && minute < 15) await run("new_filers", c => discoverFilers(c, env));
  await store.put("scheduled:last", { at: new Date(now).toISOString(), log }); return log;
}
