/** Continuous research jobs: US equity scan, SEC investor monitoring, DEX token discovery, new-manager discovery. */
import { Budget, type FetchLike } from "./budget.ts";
import { AlphaStore } from "./store.ts";
import { analyseSymbol, saveAnalysis, rebuildLeaderboard, type ScanCtx, type ScanReport, type Compact } from "./scanner.ts";
import { equityConfigured, fetchEquityBars, fetchScreener, watchlist, type EquityEnv } from "./equities.ts";
import * as S from "./sec.ts";
import { evaluateDisclosure, consensusFor, type CopyEvaluation } from "./copytrade.ts";
import { buildPlan } from "./fusion.ts";
import { compatibility, type LabSummary } from "./lab.ts";
import * as F from "./flow.ts";
import { round } from "./indicators.ts";
import type { Kline } from "../market.ts";
import type { Prediction } from "./ledger.ts";
import { createPrediction } from "./ledger.ts";

export type ResearchEnv = EquityEnv & S.SecEnv & { ETHERSCAN_API_KEY?: string; OPENFIGI_API_KEY?: string };

// ------------------------------------------------------------------ investors
export interface EntityState { verification?: S.EntityVerification; lastCheckedAt?: number; processed13f?: Record<string, number>; processedForm4?: Record<string, number> }
export async function refreshInvestors(ctx: ScanCtx, env: ResearchEnv, opts: { maxEntities?: number; minIntervalMs?: number } = {}) {
  const { store, budget, now } = ctx, f = ctx.fetch, out = { checked: [] as string[], disclosures: 0, errors: [] as string[], skipped: "" };
  if (!S.secConfigured(env)) { out.skipped = "sec_user_agent_not_configured"; return out; }
  const states = await store.get<Record<string, EntityState>>("entities", {}), custom = await store.get<S.WatchEntity[]>("entities:custom", []);
  const all = [...S.WATCH_ENTITIES, ...custom], due = all.filter(e => now - (states[e.id]?.lastCheckedAt ?? 0) > (opts.minIntervalMs ?? 6 * 3600_000)).sort((a, b) => (states[a.id]?.lastCheckedAt ?? 0) - (states[b.id]?.lastCheckedAt ?? 0)).slice(0, opts.maxEntities ?? 4);
  const found: S.Disclosure[] = [], cusips = new Set<string>();
  for (const ent of due) {
    if (budget.left < 2) { out.errors.push("budget_exhausted"); break; }
    const st = states[ent.id] ?? {}; st.processed13f ??= {}; st.processedForm4 ??= {};
    if (st.verification?.status !== "verified") st.verification = await S.verifyEntity(ent, env, budget, f, now);
    const verified = st.verification.status === "verified";
    const sub = await S.fetchSubmissions(ent.cik, env, budget, f);
    if (!sub.ok) { out.errors.push(ent.id + ":" + sub.reason); states[ent.id] = { ...st, lastCheckedAt: now }; continue; }
    const f13 = sub.data.filings.filter(x => x.kind === "13F-HR" && x.reportDate).sort((a, b) => b.reportDate!.localeCompare(a.reportDate!));
    if (f13[0] && !st.processed13f[f13[0].accession] && budget.left >= 4) {
      const [cur, prev] = [await S.fetchInfoTable(ent.cik, f13[0], env, budget, f), f13[1] ? await S.fetchInfoTable(ent.cik, f13[1], env, budget, f) : null];
      if (cur.ok) { const changes = S.diff13F(prev && prev.ok ? prev.data : [], cur.data), ds = S.disclosuresFromChanges(ent, verified, f13[0], prev && prev.ok ? changes : changes.filter(c => c.kind === "NEW").map(c => ({ ...c, kind: "UNCHANGED" as const })), now); found.push(...ds); ds.forEach(d => cusips.add(d.assetKey)); st.processed13f[f13[0].accession] = now; if (!(prev && prev.ok)) out.errors.push(ent.id + ":no_prior_13f_snapshot_so_changes_not_derived"); }
      else out.errors.push(ent.id + ":13f_" + cur.reason);
    }
    for (const f4 of sub.data.filings.filter(x => x.kind === "4").slice(0, 3)) {
      if (st.processedForm4[f4.accession] || budget.left < 1) continue; const r = await S.fetchForm4(ent.cik, f4, env, budget, f);
      if (r.ok) { found.push(...S.disclosuresFromForm4(ent, verified, f4, r.data, now)); st.processedForm4[f4.accession] = now; } else out.errors.push(ent.id + ":form4_" + r.reason);
    }
    for (const x of sub.data.filings.filter(y => y.kind === "13D" || y.kind === "13G").slice(0, 3)) {
      found.push({ id: "13dg:" + ent.cik + ":" + x.accession, investor: ent.investor, entityId: ent.id, entity: ent.entity, cik: ent.cik, form: x.form, type: "ownership_filing", asset: "(see filing)", assetKey: x.accession, ticker: null, eventDate: x.reportDate, filingDate: x.filingDate, source: S.filingUrl(ent.cik, x.accession, x.primaryDocument), shares: null, valueUsd: null, deltaPct: null, delay: S.classifyDelay(x.kind, x.reportDate, x.filingDate, now), attribution: { status: verified ? "verified" : "unverified", confidence: verified ? 0.95 : 0.4, basis: verified ? "filed under a verified EDGAR entity" : "CIK not yet verified" }, observedAt: new Date(now).toISOString(), note: "13D/13G index entry: the subject company and percentage need the filing document and are not parsed" });
    }
    st.lastCheckedAt = now; for (const k of Object.keys(st.processed13f)) if (now - st.processed13f[k] > 400 * 86400000) delete st.processed13f[k]; states[ent.id] = st; out.checked.push(ent.id);
  }
  if (cusips.size && budget.left > 0) { const map = await S.mapCusips([...cusips].slice(0, 100), budget, f, env.OPENFIGI_API_KEY); for (const d of found) if (map[d.assetKey]) d.ticker = map[d.assetKey].ticker; }
  await store.put("entities", states);
  if (found.length) await store.update<S.Disclosure[]>("disclosures", [], cur => { const ids = new Set(found.map(d => d.id)); return [...found, ...cur.filter(d => !ids.has(d.id))].slice(0, 800); });
  out.disclosures = found.length; await store.audit("system", "refresh_investors", { checked: out.checked, disclosures: found.length }, now); return out;
}
export async function verifyAllEntities(ctx: ScanCtx, env: ResearchEnv) {
  const states = await ctx.store.get<Record<string, EntityState>>("entities", {}), custom = await ctx.store.get<S.WatchEntity[]>("entities:custom", []), res: Record<string, S.EntityVerification> = {};
  if (!S.secConfigured(env)) return { error: "sec_user_agent_not_configured" as const, results: res };
  for (const e of [...S.WATCH_ENTITIES, ...custom]) { if (ctx.budget.left < 1) break; const v = await S.verifyEntity(e, env, ctx.budget, ctx.fetch, ctx.now); res[e.id] = v; states[e.id] = { ...(states[e.id] ?? {}), verification: v }; }
  await ctx.store.put("entities", states); await ctx.store.audit("user", "verify_entities", { results: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.status])) }, ctx.now); return { error: null, results: res };
}
export function marketForCopy(rows: Kline[], interval: string, assetClass: "crypto" | "equity", labSummary: LabSummary | null) {
  const plan = rows.length >= 20 ? buildPlan(rows) : null, last = rows[rows.length - 1];
  const names = labSummary ? labSummary.results.filter(r => r.kind !== "combination" && r.status !== "not_testable" && labSummary.latestVotes[r.id] === 1 && compatibility(r.id, { assetClass, interval }).compatible).map(r => r.name) : [];
  return { rows, interval, assetClass, rrToTp2: plan ? (plan.targets[1].price - plan.entry) / (plan.entry - plan.stop) : null, stageBias: "none" as const, labLongVotes: names.length, labCompatibleNames: names, price: last ? last[4] : 0 };
}
export async function evaluateCopyForTicker(store: AlphaStore, ticker: string, rows: Kline[] | null, interval: string, now: number, labSummary: LabSummary | null = null, stageBias: "bullish" | "risk" | "none" = "none"): Promise<CopyEvaluation[]> {
  const all = await store.get<S.Disclosure[]>("disclosures", []), custom = await store.get<S.WatchEntity[]>("entities:custom", []), ents = [...S.WATCH_ENTITIES, ...custom];
  return all.filter(d => d.ticker === ticker).map(d => { const m = rows ? { ...marketForCopy(rows, interval, "equity", labSummary), stageBias } : null; return evaluateDisclosure(d, ents.find(e => e.id === d.entityId), m, consensusFor(d, all), now); });
}

// ------------------------------------------------------------------ equities
export async function scanEquities(ctx: ScanCtx, env: ResearchEnv, opts: { topN?: number } = {}): Promise<ScanReport> {
  const { store, budget, now } = ctx, report: ScanReport = { kind: "equity", startedAt: new Date(now).toISOString(), interval: "1d", universe: { size: 0, kept: 0, dropped: {}, venue: "alpaca (US equities)" }, examined: [], newListings: [], predictionsCreated: 0, errors: [], budget: { used: 0, max: budget.max }, partial: false, persistence: store.mode };
  if (!equityConfigured(env)) { report.errors.push("alpaca_keys_not_configured"); await store.put("scan:equity", report); return report; }
  const wl = watchlist(env), screen = await fetchScreener(env, budget, ctx.fetch), universe = [...new Set([...wl, ...screen])]; report.universe.size = universe.length; report.universe.kept = universe.length;
  const examined = await store.get<Record<string, number>>("examined:equity", {}), picks = universe.sort((a, b) => (examined[a] ?? 0) - (examined[b] ?? 0)).slice(0, Math.min(opts.topN ?? 8, 25));
  const spy = await fetchEquityBars("SPY", env, budget, ctx.fetch, now), bench = spy.ok ? spy.data : undefined;
  for (const sym of picks) {
    const bars = await fetchEquityBars(sym, env, budget, ctx.fetch, now); if (!bars.ok) { report.errors.push(sym + ":" + bars.reason); if (bars.reason === "subrequest_budget_exhausted") { report.partial = true; break; } continue; }
    const prev = (await store.get<any>("detail:" + sym + ":1d", null))?.fused ?? null, copy = await evaluateCopyForTicker(store, sym, bars.data, "1d", now, null);
    const inst = copy.length ? { score: Math.max(...copy.map(c => c.score)) / 100, evidence: copy.map(c => c.classification + ": " + c.investor + " " + c.summary), sources: ["SEC EDGAR"] } : undefined;
    const a = analyseSymbol({ symbol: sym, assetClass: "equity", interval: "1d", rows: bars.data, provider: "alpaca", exchange: "US equity (Alpaca " + (env.ALPACA_DATA_FEED === "sip" ? "SIP" : "IEX") + " feed)", now, benchmark: bench, withLab: true, copy, external: inst ? { institutional: inst } : undefined, prev });
    examined[sym] = now; if (!a) { report.errors.push(sym + ":insufficient_history"); continue; }
    const c = await saveAnalysis(store, a, now, false, { dataCaveat: env.ALPACA_DATA_FEED === "sip" ? null : "IEX feed volume understates consolidated volume" }); report.examined.push({ symbol: sym, classification: c.classification, overall: c.overall });
    const p = createPrediction(a.fused, 20); if (p) { const preds = await store.get<Prediction[]>("predictions", []); if (!preds.some(x => x.symbol === p.symbol && x.interval === p.interval && x.status === "open")) { await store.push("predictions", p, 1000); report.predictionsCreated++; } }
  }
  await store.put("examined:equity", examined); await rebuildLeaderboard(store, now); report.budget.used = budget.used; report.partial = report.partial || budget.left <= 0; await store.put("scan:equity", report); return report;
}

// ------------------------------------------------------------------ DEX tokens
export interface DexCandidate { chainId: string; tokenAddress: string; symbol: string; name: string; pairUrl: string | null; liquidityUsd: number; volume24hUsd: number; ageHours: number | null; riskScore: number; flags: string[]; security: F.TokenSecurity | null; status: "WATCHLIST" | "REJECTED"; reasons: string[]; examinedAt: string; executable: false }
export async function discoverDex(ctx: ScanCtx, opts: { max?: number } = {}) {
  const { store, budget, now } = ctx, f = ctx.fetch, profiles = (await F.fetchLatestDexProfiles(budget, f)).filter(p => p.chainId in F.DEX_CHAIN_IDS).slice(0, opts.max ?? 30), pairs = await F.fetchDexPairsForTokens(profiles, budget, f);
  const best = new Map<string, F.DexPair>(); for (const p of pairs) { const k = p.chainId + ":" + p.tokenAddress.toLowerCase(), cur = best.get(k); if (!cur || p.liquidityUsd > cur.liquidityUsd) best.set(k, p); }
  const ranked = [...best.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd), out: DexCandidate[] = [];
  for (const [i, p] of ranked.entries()) {
    const a = F.assessDexPair(p, now), sec = i < 6 ? await F.fetchTokenSecurity(p.chainId, p.tokenAddress, budget, f) : null, ev = F.onchainEvidenceForDex(p, sec, now);
    const thin = p.liquidityUsd < 10_000, reject = sec?.verdict === "critical" || a.riskScore >= 0.6 || thin;
    out.push({ chainId: p.chainId, tokenAddress: p.tokenAddress, symbol: p.symbol, name: p.name, pairUrl: p.url, liquidityUsd: p.liquidityUsd, volume24hUsd: p.volume24hUsd, ageHours: a.ageHours, riskScore: a.riskScore, flags: [...a.flags, ...(sec?.flags ?? []).map(x => "contract: " + x)], security: sec, status: reject ? "REJECTED" : "WATCHLIST", reasons: reject ? [sec?.verdict === "critical" ? "critical contract flags" : thin ? "liquidity under $10k: untradeable in any meaningful size" : "market-structure risk " + a.riskScore, ...a.flags].slice(0, 4) : ["on-chain evidence score " + round(ev.score, 2) + "; monitoring only (no execution venue)"], examinedAt: new Date(now).toISOString(), executable: false });
  }
  await store.update<DexCandidate[]>("dex", [], cur => { const ids = new Set(out.map(c => c.chainId + c.tokenAddress)); return [...out, ...cur.filter(c => !ids.has(c.chainId + c.tokenAddress))].slice(0, 300); });
  await store.audit("system", "discover_dex", { examined: out.length }, now); return { examined: out.length, watchlist: out.filter(c => c.status === "WATCHLIST").length, rejected: out.filter(c => c.status === "REJECTED").length, budget: { used: budget.used, max: budget.max } };
}

// -------------------------------------------------------- new-manager discovery
export interface FilerCandidate { cik: string; name: string; filedOn: string; aumUsd: number | null; positions: number | null; top5Percent: number | null; status: "needs_evidence" | "rejected" | "qualified"; missing: string[]; discoveredAt: string; note: string }
export async function discoverFilers(ctx: ScanCtx, env: ResearchEnv, opts: { maxFilers?: number; minAumUsd?: number } = {}) {
  const { store, budget, now } = ctx;
  if (!S.secConfigured(env)) return { error: "sec_user_agent_not_configured", added: 0 };
  const day = new Date(now - 86400000); while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() - 1);
  const y = day.getUTCFullYear(), q = Math.floor(day.getUTCMonth() / 3) + 1, ymd = day.toISOString().slice(0, 10).replace(/-/g, "");
  if (!budget.take()) return { error: "subrequest_budget_exhausted", added: 0 };
  let text = ""; try { const r = await ctx.fetch("https://www.sec.gov/Archives/edgar/daily-index/" + y + "/QTR" + q + "/form." + ymd + ".idx", { headers: S.secHeaders(env) }); if (!r.ok) return { error: "daily_index_http_" + r.status, added: 0 }; text = await r.text(); } catch { return { error: "network_error", added: 0 }; }
  const known = new Set([...S.WATCH_ENTITIES.map(e => e.cik)]), existing = await store.get<FilerCandidate[]>("investor:candidates", []), have = new Set(existing.map(c => c.cik));
  const filers = S.parseDailyIndex(text).filter(x => x.form === "13F-HR" && !known.has(x.cik) && !have.has(x.cik)).slice(0, opts.maxFilers ?? 3), added: FilerCandidate[] = [];
  for (const fl of filers) {
    const acc = (fl.file.match(/(\d{10}-\d{2}-\d{6})/) || [])[1]; if (!acc || budget.left < 2) continue;
    const r = await S.fetchInfoTable(fl.cik, { form: fl.form, kind: "13F-HR", filingDate: fl.date, reportDate: null, accession: acc, primaryDocument: "" }, env, budget, ctx.fetch);
    const pos = r.ok ? r.data : null, total = pos ? pos.reduce((a, p) => a + p.valueUsd, 0) : null, top5 = pos && total ? pos.map(p => p.valueUsd).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0) / total * 100 : null;
    const q2 = S.qualifyInvestor({ yearsDocumented: 0, independentSources: 0, hasPrimaryPerformanceRecord: false, drawdownDisclosed: false, methodologyDocumented: false, wealthOnly: false, disclosedAumUsd: total ?? undefined });
    if (total !== null && total < (opts.minAumUsd ?? 1e9)) continue;
    added.push({ cik: fl.cik, name: fl.name, filedOn: fl.date, aumUsd: total === null ? null : Math.round(total), positions: pos ? pos.length : null, top5Percent: top5 === null ? null : round(top5, 1), status: q2.status === "qualified" ? "needs_evidence" : q2.status === "rejected" ? "needs_evidence" : "needs_evidence", missing: q2.missing, discoveredAt: new Date(now).toISOString(), note: "found via the EDGAR daily 13F index; disclosed AUM is not evidence of skill; submit documented evidence via POST /api/alpha/investors/candidates to qualify" });
  }
  if (added.length) await store.put("investor:candidates", [...added, ...existing].slice(0, 300)); await store.audit("system", "discover_filers", { added: added.length }, now); return { error: null, added: added.length, considered: filers.length };
}
export type { Compact };
