// Fundamental analysis engines for currencies, stocks and crypto. Pure scoring functions over supplied/fetched inputs.
// Missing data is reported as missing: it is never filled with defaults, and absence of information is never read as good news.
import { clamp, round, unavailableReport, type EngineReport, type Finding, type SourceRef, type Stance } from "./types.ts";

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString();
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
interface Part { id: string; label: string; weight: number; score100: number | null; detail: string; stance: Stance }
function compose(parts: Part[], engineName: string, subject: string, sources: SourceRef[], now: number, methodology: string, warnings: string[], missing: string[], extras: Record<string, unknown> = {}): EngineReport {
  const have = parts.filter(p => p.score100 !== null), wAll = parts.reduce((s, p) => s + p.weight, 0), wHave = have.reduce((s, p) => s + p.weight, 0);
  const comp = wHave ? have.reduce((s, p) => s + p.weight * p.score100!, 0) / wHave : 50;
  const completeness = wAll ? wHave / wAll : 0, score = (comp - 50) * 2;
  const findings: Finding[] = have.map(p => ({ id: p.id, kind: p.label, stance: p.stance, strength: Math.round(Math.abs(p.score100! - 50) * 2), description: p.detail }));
  for (const p of parts.filter(x => x.score100 === null)) missing.push(p.label);
  const spread = have.length ? Math.max(...have.map(p => p.score100!)) - Math.min(...have.map(p => p.score100!)) : 0;
  const conf = clamp(completeness * 70 + (have.length >= 3 ? 15 : 0) + (spread < 40 ? 15 : 5) - warnings.length * 3, 0, 100);
  const stance: Stance = !have.length ? "unavailable" : score >= 20 ? "bullish" : score <= -20 ? "bearish" : "neutral";
  return { engine: engineName, domain: "fundamental", subject, stance, score: round(score), confidence: round(conf, 0), confidenceType: "evidence_quality_not_probability", status: !have.length ? "unavailable" : completeness < 0.6 ? "partial" : "ok", completeness: round(completeness, 2),
    findings, warnings, missing, sources, asOf: iso(now), methodology, extras };
}
const staleWarn = (label: string, asOf: string | undefined, maxDays: number, now: number, w: string[]) => {
  if (!asOf) { w.push(`${label}: no as-of date supplied, freshness cannot be verified`); return; }
  const t = Date.parse(asOf); if (!Number.isFinite(t)) { w.push(`${label}: invalid as-of date`); return; }
  if (now - t > maxDays * DAY) w.push(`${label}: data is ${Math.round((now - t) / DAY)} days old (> ${maxDays}), may be outdated`);
  if (t - now > DAY) w.push(`${label}: as-of date is in the future, rejecting as unreliable`);
};

// =============================== FX ===============================
export interface CurrencyMacro { code: string; policyRatePct?: number; inflationYoYPct?: number; unemploymentPct?: number; gdpGrowthPct?: number; gdpBasis?: string; yield10yPct?: number; policyBias?: "hawkish" | "neutral" | "dovish"; policyBiasSource?: string; asOf?: string }
export interface EconomicEvent { name: string; currency: string; time: string; impact: "low" | "medium" | "high"; actual?: number; forecast?: number; previous?: number; source?: string }
export interface FxInput { pair: string; base: CurrencyMacro; quote: CurrencyMacro; dollarIndexChangePct?: { value: number; periodDays: number; asOf?: string }; events?: EconomicEvent[]; sources?: SourceRef[]; now?: number }
export function fxFundamentals(inp: FxInput): EngineReport {
  const now = inp.now ?? Date.now(), b = inp.base, q = inp.quote, warnings: string[] = [], missing: string[] = [];
  const diff = (k: keyof CurrencyMacro) => (num(b[k]) && num(q[k]) ? (b[k] as number) - (q[k] as number) : null);
  const real = (c: CurrencyMacro) => (num(c.policyRatePct) && num(c.inflationYoYPct) ? c.policyRatePct - c.inflationYoYPct : null);
  const rb = real(b), rq = real(q), realDiff = rb !== null && rq !== null ? rb - rq : null;
  const to100 = (v: number | null, scale: number, cap: number) => (v === null ? null : 50 + clamp(v * scale, -cap, cap) / cap * 50);
  const arrow = (v: number | null) => (v === null ? "n/a" : v > 0 ? "favours " + b.code : v < 0 ? "favours " + q.code : "neutral");
  const stanceFor = (v: number | null): Stance => (v === null || Math.abs(v) < 0.1 ? "neutral" : v > 0 ? "bullish" : "bearish");
  const rate = diff("policyRatePct"), yld = diff("yield10yPct"), gdp = diff("gdpGrowthPct"), unemp = diff("unemploymentPct");
  const biasV = (c: CurrencyMacro) => (c.policyBias === "hawkish" ? 1 : c.policyBias === "dovish" ? -1 : c.policyBias === "neutral" ? 0 : null);
  const bb = biasV(b), bq = biasV(q), biasD = bb !== null && bq !== null ? bb - bq : null;
  const usdInPair = b.code === "USD" ? 1 : q.code === "USD" ? -1 : 0;
  const dxy = usdInPair && inp.dollarIndexChangePct ? inp.dollarIndexChangePct.value * usdInPair : null;
  const parts: Part[] = [
    { id: "policy-rate", label: "policy rate differential", weight: 20, score100: to100(rate, 8, 20), detail: `${b.code} ${b.policyRatePct ?? "n/a"}% vs ${q.code} ${q.policyRatePct ?? "n/a"}%: differential ${rate === null ? "n/a" : round(rate)}pp ${arrow(rate)}`, stance: stanceFor(rate) },
    { id: "real-rate", label: "real rate differential", weight: 20, score100: to100(realDiff, 6, 20), detail: `Real policy rate (rate minus inflation): ${b.code} ${rb === null ? "n/a" : round(rb)}% vs ${q.code} ${rq === null ? "n/a" : round(rq)}%: ${arrow(realDiff)}`, stance: stanceFor(realDiff) },
    { id: "yield", label: "10y bond yield differential", weight: 15, score100: to100(yld, 10, 15), detail: `10y yield ${b.code} ${b.yield10yPct ?? "n/a"}% vs ${q.code} ${q.yield10yPct ?? "n/a"}%: ${arrow(yld)}`, stance: stanceFor(yld) },
    { id: "growth", label: "GDP growth differential", weight: 10, score100: to100(gdp, 5, 10), detail: `GDP growth ${b.code} ${b.gdpGrowthPct ?? "n/a"}% vs ${q.code} ${q.gdpGrowthPct ?? "n/a"}%${b.gdpBasis && q.gdpBasis && b.gdpBasis !== q.gdpBasis ? " (different bases, compare cautiously)" : ""}: ${arrow(gdp)}`, stance: stanceFor(gdp) },
    { id: "employment", label: "employment differential", weight: 8, score100: to100(unemp === null ? null : -unemp, 4, 8), detail: `Unemployment ${b.code} ${b.unemploymentPct ?? "n/a"}% vs ${q.code} ${q.unemploymentPct ?? "n/a"}% (lower is stronger): ${arrow(unemp === null ? null : -unemp)}`, stance: stanceFor(unemp === null ? null : -unemp) },
    { id: "policy-bias", label: "monetary policy stance", weight: 12, score100: to100(biasD, 1, 2), detail: `Policy bias ${b.code} ${b.policyBias ?? "n/a"} vs ${q.code} ${q.policyBias ?? "n/a"}${b.policyBiasSource || q.policyBiasSource ? ` (sources: ${[b.policyBiasSource, q.policyBiasSource].filter(Boolean).join("; ")})` : ""}`, stance: stanceFor(biasD) },
  ];
  if (usdInPair) parts.push({ id: "dollar", label: "dollar strength", weight: 10, score100: to100(dxy, 3, 10), detail: dxy === null ? "Dollar index trend unavailable" : `Broad dollar index changed ${inp.dollarIndexChangePct!.value}% over ${inp.dollarIndexChangePct!.periodDays}d, ${dxy > 0 ? "supporting" : "pressuring"} ${b.code}${b.code === "USD" ? "" : " via USD weakness"}`, stance: stanceFor(dxy) });
  for (const c of [b, q]) staleWarn(`${c.code} macro data`, c.asOf, 120, now, warnings);
  const events = (inp.events ?? []).filter(e => Number.isFinite(Date.parse(e.time)));
  for (const e of inp.events ?? []) if (!Number.isFinite(Date.parse(e.time))) warnings.push(`Economic event "${e.name}" has an invalid time and was ignored`);
  const upcoming = events.filter(e => (e.currency === b.code || e.currency === q.code) && Date.parse(e.time) > now && Date.parse(e.time) - now <= DAY && e.impact === "high");
  for (const e of upcoming) warnings.push(`Event risk: high-impact ${e.currency} release "${e.name}" at ${e.time} (within 24h): volatility and gaps are likely`);
  const rep = compose(parts, "fundamental:fx", inp.pair, inp.sources ?? [], now, "Currency fundamentals: base-minus-quote differentials in policy rate, real policy rate (rate minus inflation), 10y yield, GDP growth, unemployment, policy-bias, plus the dollar trend for USD pairs. Each differential maps to 0-100 with explicit caps. Positive score favours the BASE currency. Missing inputs are excluded and lower completeness.", warnings, missing, { differentials: { policyRatePp: rate, realRatePp: realDiff, yield10yPp: yld, gdpPp: gdp, unemploymentPp: unemp }, eventRisk: upcoming.length > 0 });
  const rel = events.filter(e => Date.parse(e.time) <= now && now - Date.parse(e.time) <= 3 * DAY && num(e.actual));
  for (const e of rel) rep.findings.push({ id: `evt-${e.name}`, kind: "economic_release", stance: "neutral", strength: e.impact === "high" ? 60 : 30, time: Date.parse(e.time), description: `${e.currency} ${e.name} (${e.time}): actual ${e.actual}${num(e.forecast) ? ` vs forecast ${e.forecast}` : ""}${num(e.previous) ? `, previous ${e.previous}` : ""}${e.source ? ` [${e.source}]` : " [no source given]"}` });
  return rep;
}

// =============================== STOCKS ===============================
export interface InsiderTx { date: string; type: "buy" | "sell"; valueUsd?: number; shares?: number; role?: string; plannedSale?: boolean }
export interface StockInput {
  symbol: string; name?: string; sector?: string; asOf?: string; priceAsOf?: string;
  revenueTTM?: number; revenuePrev?: number; netIncomeTTM?: number; netIncomePrev?: number; grossProfitTTM?: number; operatingIncomeTTM?: number; ebitdaTTM?: number;
  operatingCashFlowTTM?: number; capexTTM?: number; totalDebt?: number; cash?: number; interestExpenseTTM?: number; shareholdersEquity?: number;
  sharesOutstanding?: number; sharesOutstandingPrev?: number; marketCap?: number; epsTTM?: number; forwardPe?: number;
  sectorMedians?: { pe?: number; evEbitda?: number; operatingMarginPct?: number; revenueGrowthPct?: number };
  insiderTransactions?: InsiderTx[]; institutionalOwnershipPct?: number; institutionalOwnershipChangePct?: number; insiderOwnershipPct?: number;
  sources?: SourceRef[]; now?: number;
}
export function stockFundamentals(s: StockInput): EngineReport {
  const now = s.now ?? Date.now(), warnings: string[] = [], missing: string[] = [], d: Record<string, number | null> = {};
  const div = (a?: number, b?: number) => (num(a) && num(b) && b !== 0 ? a / b : null);
  const growth = (a?: number, b?: number) => (num(a) && num(b) && b > 0 ? (a / b - 1) * 100 : null);
  const revG = growth(s.revenueTTM, s.revenuePrev), niG = growth(s.netIncomeTTM, s.netIncomePrev);
  const gm = div(s.grossProfitTTM, s.revenueTTM), om = div(s.operatingIncomeTTM, s.revenueTTM), nm = div(s.netIncomeTTM, s.revenueTTM);
  const fcf = num(s.operatingCashFlowTTM) && num(s.capexTTM) ? s.operatingCashFlowTTM - Math.abs(s.capexTTM) : null;
  const fcfM = div(fcf ?? undefined, s.revenueTTM), conv = div(fcf ?? undefined, s.netIncomeTTM);
  const netDebt = num(s.totalDebt) && num(s.cash) ? s.totalDebt - s.cash : null, ndE = div(netDebt ?? undefined, s.ebitdaTTM), cov = div(s.operatingIncomeTTM, s.interestExpenseTTM);
  const pe = num(s.marketCap) && num(s.netIncomeTTM) && s.netIncomeTTM > 0 ? s.marketCap / s.netIncomeTTM : null, fcfYield = num(s.marketCap) && fcf !== null ? fcf / s.marketCap * 100 : null;
  const ev = num(s.marketCap) && netDebt !== null ? s.marketCap + netDebt : null, evE = div(ev ?? undefined, s.ebitdaTTM);
  const dil = growth(s.sharesOutstanding, s.sharesOutstandingPrev);
  Object.assign(d, { revenueGrowthPct: revG, grossMarginPct: gm === null ? null : gm * 100, operatingMarginPct: om === null ? null : om * 100, netMarginPct: nm === null ? null : nm * 100, freeCashFlow: fcf, fcfConversion: conv, netDebtToEbitda: ndE, interestCoverage: cov, peTTM: pe, fcfYieldPct: fcfYield, evToEbitda: evE, shareCountChangePct: dil });
  const sc = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo) * 100, 0, 100);
  const st = (v: number | null): Stance => (v === null ? "neutral" : v >= 60 ? "bullish" : v <= 40 ? "bearish" : "neutral");
  const f = (v: number | null, dp = 1) => (v === null ? "n/a" : round(v, dp));
  const parts: Part[] = [];
  const push = (id: string, label: string, weight: number, score: number | null, detail: string) => parts.push({ id, label, weight, score100: score === null ? null : round(score, 1), detail, stance: st(score) });
  const gs = [revG === null ? null : sc(revG, -10, 25), niG === null ? null : sc(niG, -20, 30)].filter((x): x is number => x !== null);
  push("growth", "growth", 20, gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : null, `Revenue growth ${f(revG)}% YoY, net income growth ${f(niG)}%${s.sectorMedians?.revenueGrowthPct !== undefined ? ` (sector median revenue growth ${s.sectorMedians.revenueGrowthPct}%)` : ""}`);
  const ps = [om === null ? null : sc(om * 100, 0, 30), nm === null ? null : sc(nm * 100, 0, 20)].filter((x): x is number => x !== null);
  push("profitability", "profit margins", 15, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null, `Gross ${f(d.grossMarginPct)}%, operating ${f(d.operatingMarginPct)}%, net ${f(d.netMarginPct)}%`);
  const cs = [fcfM === null ? null : sc(fcfM * 100, -5, 20), conv === null ? null : sc(conv, 0, 1.2)].filter((x): x is number => x !== null);
  push("cashflow", "cash flow", 15, cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null, `Free cash flow ${f(fcf, 0)}, FCF margin ${f(fcfM === null ? null : fcfM * 100)}%, FCF/net income ${f(conv, 2)}`);
  const bs = [ndE === null ? null : (netDebt! <= 0 ? 100 : sc(5 - ndE, 0, 5)), cov === null ? null : sc(cov, 1, 10)].filter((x): x is number => x !== null);
  push("balance-sheet", "debt and balance sheet", 15, bs.length ? bs.reduce((a, b) => a + b, 0) / bs.length : null, `Net debt ${f(netDebt, 0)}, net debt/EBITDA ${f(ndE, 2)}, interest coverage ${f(cov, 1)}x`);
  const med = s.sectorMedians, vs: number[] = [];
  if (pe !== null && med?.pe) vs.push(sc(1.5 - pe / med.pe, 0, 1)); else if (pe !== null) vs.push(sc(40 - pe, 0, 30));
  if (evE !== null && med?.evEbitda) vs.push(sc(1.5 - evE / med.evEbitda, 0, 1)); else if (evE !== null) vs.push(sc(25 - evE, 0, 20));
  if (fcfYield !== null) vs.push(sc(fcfYield, 0, 8));
  push("valuation", "valuation", 20, vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null, `P/E ${f(pe)}${med?.pe ? ` vs sector ${med.pe}` : " (no sector median: absolute bands, weaker evidence)"}, EV/EBITDA ${f(evE)}${med?.evEbitda ? ` vs sector ${med.evEbitda}` : ""}, FCF yield ${f(fcfYield)}%`);
  // Insider and institutional signals: open-market buys carry information; sells are ambiguous; planned (10b5-1) sells are discounted.
  const tx = (s.insiderTransactions ?? []).filter(t => Number.isFinite(Date.parse(t.date)) && now - Date.parse(t.date) <= 180 * DAY);
  const val = (t: InsiderTx) => (num(t.valueUsd) ? t.valueUsd : 0);
  const buys = tx.filter(t => t.type === "buy").reduce((a, t) => a + val(t), 0), sells = tx.filter(t => t.type === "sell").reduce((a, t) => a + val(t) * (t.plannedSale ? 0.25 : 1), 0);
  const own: number[] = [];
  if (s.insiderTransactions) own.push(buys + sells === 0 ? 50 : clamp(50 + (buys - sells) / (buys + sells) * 40, 10, 90));
  if (num(s.institutionalOwnershipChangePct)) own.push(sc(s.institutionalOwnershipChangePct, -10, 10));
  push("ownership", "insider and institutional activity", 10, own.length ? own.reduce((a, b) => a + b, 0) / own.length : null, `Insider open-market buys ${round(buys, 0)} vs weighted sells ${round(sells, 0)} (180d, ${tx.length} filings)${num(s.institutionalOwnershipPct) ? `; institutions hold ${s.institutionalOwnershipPct}% (change ${f(s.institutionalOwnershipChangePct ?? null)}pp)` : ""}`);
  // Management quality and competitive advantage cannot be scored automatically; only verifiable proxies are used.
  const prox: number[] = [];
  if (om !== null && med?.operatingMarginPct !== undefined) prox.push(sc(om * 100 - med.operatingMarginPct, -10, 10));
  if (dil !== null) prox.push(sc(-dil, -5, 3));
  push("moat-proxies", "competitive advantage and capital allocation (proxies)", 5, prox.length ? prox.reduce((a, b) => a + b, 0) / prox.length : null, `Operating margin vs sector ${f(d.operatingMarginPct)}% vs ${med?.operatingMarginPct ?? "n/a"}%; share count change ${f(dil)}% (dilution/buyback proxy). Management quality and moat need analyst judgement: these are proxies only`);
  staleWarn("Financial statements", s.asOf, 400, now, warnings);
  if (num(s.marketCap) || pe !== null) staleWarn("Price/market cap", s.priceAsOf, 3, now, warnings);
  if (!num(s.marketCap)) warnings.push("No market capitalisation supplied: valuation cannot be assessed");
  if (!s.insiderTransactions) warnings.push("Insider transactions not supplied (reliable Form 4 ingestion is not configured); no insider conclusion is drawn");
  if (num(s.netIncomeTTM) && s.netIncomeTTM < 0) warnings.push("Company is loss-making: earnings-based valuation ratios are not meaningful");
  return compose(parts, "fundamental:stock", s.symbol, s.sources ?? [], now, "Weighted 0-100 category scores (growth 20, margins 15, cash flow 15, balance sheet 15, valuation 20, insider/institutional 10, moat/capital-allocation proxies 5). Missing categories are excluded and reduce completeness and confidence. Valuation is relative to sector medians when supplied, otherwise absolute bands (weaker). Management quality is NOT scored beyond verifiable proxies.", warnings, missing, { derived: d });
}

// =============================== CRYPTO ===============================
export interface CryptoInput {
  symbol: string; name?: string; asOf?: string; purpose?: string; genesisDate?: string;
  team?: { publiclyIdentified?: boolean; founders?: string[]; notes?: string };
  supply?: { total?: number; circulating?: number; max?: number; priceUsd?: number; marketCapUsd?: number; fdvUsd?: number };
  unlocks?: { date: string; tokens: number }[]; vesting?: string;
  holders?: { top10Pct?: number; top100Pct?: number; excludesExchangesAndBurn?: boolean; insiderPct?: number };
  liquidity?: { volume24hUsd?: number; dexLiquidityUsd?: number; spreadBps?: number };
  exchanges?: { tier1Count?: number; totalCount?: number; names?: string[] };
  network?: { activeAddresses30d?: number; activeAddressesChange30dPct?: number; txCount30d?: number; tvlUsd?: number; feesUsd30d?: number };
  security?: { audits?: { firm: string; date?: string; url?: string }[]; sourceVerified?: boolean; upgradeable?: boolean; singleAdminKey?: boolean; mintable?: boolean; freezable?: boolean; knownExploitUnresolved?: boolean; bugBounty?: boolean };
  governance?: { model?: string; proposals90d?: number; turnoutPct?: number };
  adoption?: { users?: number; integrations?: number; revenueUsd30d?: number; notes?: string };
  development?: { commits90d?: number; contributors90d?: number; lastCommitDate?: string; repoUrl?: string };
  regulatory?: { risk?: "low" | "medium" | "high"; notes?: string; sources?: string[] };
  sources?: SourceRef[]; now?: number;
}
export type Legitimacy = "substantive" | "caution" | "unverified" | "high_risk";
export interface RedFlag { severity: "critical" | "high" | "medium"; flag: string }
export function cryptoFundamentals(c: CryptoInput): EngineReport {
  const now = c.now ?? Date.now(), warnings: string[] = [], missing: string[] = [], flags: RedFlag[] = [];
  const parts: Part[] = [], sc = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo) * 100, 0, 100);
  const st = (v: number | null): Stance => (v === null ? "neutral" : v >= 60 ? "bullish" : v <= 40 ? "bearish" : "neutral");
  const push = (id: string, label: string, weight: number, score: number | null, detail: string) => parts.push({ id, label, weight, score100: score === null ? null : round(score, 1), detail, stance: st(score) });
  const avg = (a: (number | null)[]) => { const x = a.filter((v): v is number => v !== null); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };
  const sp = c.supply, h = c.holders, lq = c.liquidity, sec = c.security, net = c.network, dev = c.development;
  // Purpose & team
  const purposeS = c.purpose && c.purpose.trim().length > 40 ? 65 : c.purpose ? 45 : null;
  const teamS = c.team ? (c.team.publiclyIdentified ? 75 : 25) : null;
  if (c.team && !c.team.publiclyIdentified) flags.push({ severity: "medium", flag: "Founders/team are not publicly identified" });
  push("purpose-team", "purpose and team", 12, avg([purposeS, teamS]), `${c.purpose ? `Stated purpose: ${c.purpose.slice(0, 160)}` : "No project purpose supplied"}; team ${c.team ? (c.team.publiclyIdentified ? `publicly identified${c.team.founders?.length ? ` (${c.team.founders.join(", ")})` : ""}` : "not publicly identified") : "unknown"}. Identification is a transparency signal, not proof of competence`);
  // Tokenomics
  const circ = sp && num(sp.circulating) && num(sp.total) && sp.total > 0 ? sp.circulating / sp.total : null, fdvMc = sp && num(sp.fdvUsd) && num(sp.marketCapUsd) && sp.marketCapUsd > 0 ? sp.fdvUsd / sp.marketCapUsd : null;
  const circAmt = sp?.circulating ?? 0, soon = (c.unlocks ?? []).filter(u => Number.isFinite(Date.parse(u.date)) && Date.parse(u.date) > now && Date.parse(u.date) - now <= 90 * DAY).reduce((a, u) => a + u.tokens, 0), unlockPct = circAmt > 0 ? soon / circAmt * 100 : null;
  if (circ !== null && circ < 0.15 && (fdvMc ?? 0) > 5) flags.push({ severity: "high", flag: `Only ${round(circ * 100, 0)}% of supply circulates and FDV is ${round(fdvMc!, 1)}x market cap: heavy future dilution` });
  else if (fdvMc !== null && fdvMc > 5) flags.push({ severity: "high", flag: `FDV is ${round(fdvMc, 1)}x market cap: heavy future dilution` });
  if (unlockPct !== null && unlockPct >= 10) flags.push({ severity: "high", flag: `${round(unlockPct, 1)}% of circulating supply unlocks within 90 days: sell pressure risk` });
  push("tokenomics", "tokenomics and supply", 18, avg([circ === null ? null : sc(circ, 0.1, 0.9), fdvMc === null ? null : sc(5 - fdvMc, 0, 4), unlockPct === null ? (c.unlocks ? 70 : null) : sc(15 - unlockPct, 0, 15)]),
    `Circulating ${circ === null ? "n/a" : round(circ * 100, 0) + "% of total"}, max supply ${sp?.max ?? "n/a"}, FDV/market-cap ${fdvMc === null ? "n/a" : round(fdvMc, 2)}x, 90d unlocks ${unlockPct === null ? (c.unlocks ? "none scheduled" : "unknown") : round(unlockPct, 1) + "% of circulating"}${c.vesting ? `; vesting: ${c.vesting}` : ""}`);
  // Holders
  if (h && num(h.top10Pct)) { if (h.top10Pct >= 70) flags.push({ severity: "critical", flag: `Top 10 holders control ${h.top10Pct}%${h.excludesExchangesAndBurn ? "" : " (may include exchange/contract wallets)"}: extreme concentration` }); else if (h.top10Pct >= 50) flags.push({ severity: "high", flag: `Top 10 holders control ${h.top10Pct}%: high concentration` }); }
  if (h && !h.excludesExchangesAndBurn && num(h.top10Pct)) warnings.push("Holder concentration may include exchange, burn or protocol-owned wallets: interpret with care");
  push("holders", "holder concentration", 14, h && num(h.top10Pct) ? sc(80 - h.top10Pct, 0, 60) : null, `Top 10 holders ${h?.top10Pct ?? "n/a"}%, top 100 ${h?.top100Pct ?? "n/a"}%, insiders ${h?.insiderPct ?? "n/a"}%`);
  // Liquidity & listings
  if (lq && num(lq.volume24hUsd) && lq.volume24hUsd < 100_000) flags.push({ severity: "high", flag: `24h volume $${Math.round(lq.volume24hUsd).toLocaleString("en-US")}: illiquid, exit risk and easy price manipulation` });
  if (lq && num(lq.dexLiquidityUsd) && lq.dexLiquidityUsd < 250_000) flags.push({ severity: "high", flag: `DEX liquidity only $${Math.round(lq.dexLiquidityUsd).toLocaleString("en-US")}` });
  push("liquidity", "liquidity", 12, avg([lq && num(lq.volume24hUsd) ? sc(Math.log10(Math.max(1, lq.volume24hUsd)), 4.5, 8) : null, lq && num(lq.dexLiquidityUsd) ? sc(Math.log10(Math.max(1, lq.dexLiquidityUsd)), 5, 7.5) : null, lq && num(lq.spreadBps) ? sc(60 - lq.spreadBps, 0, 55) : null]), `24h volume ${lq?.volume24hUsd ?? "n/a"} USD, DEX liquidity ${lq?.dexLiquidityUsd ?? "n/a"} USD, spread ${lq?.spreadBps ?? "n/a"} bps`);
  const ex = c.exchanges; if (ex && num(ex.tier1Count) && ex.tier1Count === 0) flags.push({ severity: "medium", flag: "No listing on a recognised tier-1 exchange" });
  push("listings", "exchange listings", 5, ex && num(ex.tier1Count) ? sc(ex.tier1Count, 0, 4) : null, `${ex?.tier1Count ?? "n/a"} tier-1 and ${ex?.totalCount ?? "n/a"} total venues${ex?.names?.length ? ` (${ex.names.slice(0, 5).join(", ")})` : ""}`);
  // Network, adoption, development
  push("network", "network and on-chain activity", 8, net ? avg([num(net.activeAddressesChange30dPct) ? sc(net.activeAddressesChange30dPct, -30, 30) : null, num(net.tvlUsd) ? sc(Math.log10(Math.max(1, net.tvlUsd)), 5, 9.5) : null, num(net.feesUsd30d) ? sc(Math.log10(Math.max(1, net.feesUsd30d)), 3, 8) : null, num(net.activeAddresses30d) ? sc(Math.log10(Math.max(1, net.activeAddresses30d)), 2, 6) : null]) : null,
    `Active addresses 30d ${net?.activeAddresses30d ?? "n/a"} (${net?.activeAddressesChange30dPct ?? "n/a"}% change), TVL ${net?.tvlUsd ?? "n/a"}, fees 30d ${net?.feesUsd30d ?? "n/a"} USD. On-chain activity can be inflated by wash/bot activity`);
  const ad = c.adoption;
  push("adoption", "actual adoption", 10, ad ? avg([num(ad.users) ? sc(Math.log10(Math.max(1, ad.users)), 2, 6.5) : null, num(ad.revenueUsd30d) ? sc(Math.log10(Math.max(1, ad.revenueUsd30d)), 3, 7.5) : null, num(ad.integrations) ? sc(ad.integrations, 0, 30) : null]) : null, `Users ${ad?.users ?? "n/a"}, protocol revenue 30d ${ad?.revenueUsd30d ?? "n/a"} USD, integrations ${ad?.integrations ?? "n/a"}${ad?.notes ? `; ${ad.notes}` : ""}`);
  const lastCommitAge = dev?.lastCommitDate && Number.isFinite(Date.parse(dev.lastCommitDate)) ? (now - Date.parse(dev.lastCommitDate)) / DAY : null;
  if (lastCommitAge !== null && lastCommitAge > 180) flags.push({ severity: "medium", flag: `No code commits for ${Math.round(lastCommitAge)} days: development appears abandoned` });
  push("development", "development activity", 6, dev ? avg([num(dev.commits90d) ? sc(dev.commits90d, 0, 150) : null, num(dev.contributors90d) ? sc(dev.contributors90d, 0, 15) : null, lastCommitAge === null ? null : sc(180 - lastCommitAge, 0, 170)]) : null, `${dev?.commits90d ?? "n/a"} commits and ${dev?.contributors90d ?? "n/a"} contributors in 90d, last commit ${dev?.lastCommitDate ?? "n/a"}${dev?.repoUrl ? ` (${dev.repoUrl})` : ""}`);
  // Smart-contract security
  const audits = sec?.audits ?? [];
  if (sec) {
    if (sec.knownExploitUnresolved) flags.push({ severity: "critical", flag: "A known exploit/vulnerability is reported as unresolved" });
    if (sec.mintable) flags.push({ severity: "high", flag: "Token supply is mintable by a privileged key" });
    if (sec.freezable) flags.push({ severity: "high", flag: "Privileged key can freeze holder balances" });
    if (sec.singleAdminKey && sec.upgradeable) flags.push({ severity: "critical", flag: "Upgradeable contracts controlled by a single admin key: holders can be rugged without notice" });
    if (audits.length === 0 && sec.sourceVerified === false) flags.push({ severity: "critical", flag: "No security audit and contract source is not verified" });
    else if (audits.length === 0) flags.push({ severity: "medium", flag: "No published security audit" });
  }
  push("security", "smart-contract security", 15, sec ? avg([audits.length ? sc(audits.length, 0, 2) : 15, sec.sourceVerified === undefined ? null : sec.sourceVerified ? 85 : 10, sec.upgradeable === undefined ? null : sec.upgradeable ? (sec.singleAdminKey ? 5 : 55) : 85, sec.mintable === undefined ? null : sec.mintable ? 15 : 85, sec.bugBounty === undefined ? null : sec.bugBounty ? 80 : 40]) : null,
    `${audits.length} audit(s)${audits.length ? ` (${audits.map(a => a.firm).join(", ")})` : ""}, source verified ${sec?.sourceVerified ?? "unknown"}, upgradeable ${sec?.upgradeable ?? "unknown"}, mintable ${sec?.mintable ?? "unknown"}. An audit reduces but never eliminates smart-contract risk`);
  push("governance", "governance", 4, c.governance ? avg([num(c.governance.proposals90d) ? sc(c.governance.proposals90d, 0, 8) : null, num(c.governance.turnoutPct) ? sc(c.governance.turnoutPct, 1, 20) : null]) : null, `Model ${c.governance?.model ?? "n/a"}, ${c.governance?.proposals90d ?? "n/a"} proposals/90d, turnout ${c.governance?.turnoutPct ?? "n/a"}%`);
  if (c.regulatory?.risk === "high") flags.push({ severity: "high", flag: `High regulatory exposure${c.regulatory.notes ? `: ${c.regulatory.notes}` : ""}` });
  push("regulatory", "regulatory exposure", 4, c.regulatory?.risk ? { low: 80, medium: 50, high: 15 }[c.regulatory.risk] : null, `Regulatory risk ${c.regulatory?.risk ?? "unknown"}${c.regulatory?.notes ? `: ${c.regulatory.notes}` : ""}`);
  staleWarn("Token data", c.asOf, 14, now, warnings);
  if (!c.team && !c.security) warnings.push("Team and contract-security data are absent: these are exactly the facts that separate legitimate projects from scams, and automatic sources rarely supply them");
  const crit = flags.filter(f => f.severity === "critical").length, high = flags.filter(f => f.severity === "high").length;
  const rep = compose(parts, "fundamental:crypto", c.symbol, c.sources ?? [], now, "Weighted 0-100 category scores (tokenomics 18, security 15, holders 14, purpose/team 12, liquidity 12, adoption 10, network 8, development 6, listings 5, governance 4, regulatory 4) plus a LEGITIMACY GATE: 'high_risk' if any critical red flag or >= 3 high flags; 'caution' if any high flag; 'unverified' if completeness < 0.5 (absence of information is not evidence of legitimacy); otherwise 'substantive'. The central intelligence layer will not issue a bullish verdict for a token whose legitimacy is high_risk or unverified, regardless of its chart.", warnings, missing);
  const legitimacy: Legitimacy = crit > 0 || high >= 3 ? "high_risk" : rep.completeness < 0.5 ? "unverified" : high > 0 ? "caution" : "substantive";
  if (legitimacy === "high_risk") { rep.score = Math.min(rep.score, -40); rep.stance = "bearish"; }
  else if (legitimacy === "unverified") { rep.score = Math.min(rep.score, 10); if (rep.stance === "bullish") rep.stance = "neutral"; rep.warnings.push("Legitimacy is UNVERIFIED: too little fundamental data to conclude the asset has real economic or technological value"); }
  else if (legitimacy === "caution") rep.score = Math.min(rep.score, 45);
  rep.confidence = legitimacy === "unverified" ? Math.min(rep.confidence, 35) : rep.confidence;
  for (const f of flags) rep.findings.unshift({ id: `flag-${f.flag.slice(0, 24)}`, kind: "red_flag", stance: "bearish", strength: f.severity === "critical" ? 95 : f.severity === "high" ? 75 : 50, description: `[${f.severity.toUpperCase()}] ${f.flag}` });
  rep.extras = { legitimacy, redFlags: flags, circulatingShare: circ, fdvToMarketCap: fdvMc, unlockPct90d: unlockPct };
  return rep;
}

export function fundamentalUnavailable(subject: string, why: string, missing: string[], now = Date.now()): EngineReport { return unavailableReport("fundamental", "fundamental", subject, why, missing, now); }
