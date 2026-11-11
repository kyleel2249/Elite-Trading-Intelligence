/**
 * Unified intelligence fusion + independent validation.
 *
 * Three layers that must not approve their own conclusions:
 *   Discovery (early alpha, scanner) -> Research (lab, investors, flow) -> Decision (independentValidation).
 * independentValidation() takes ONLY raw candles and the proposed plan. It never reads the early-alpha score, the fusion
 * score or the engine's conviction, so a high score upstream cannot vouch for itself. Hard failures cap everything:
 * a high investor-consensus or early-alpha score never overrides a hard risk failure.
 * This validator is rule-based and deterministic; it is not an LLM.
 */
import { INTERVAL_SECONDS, type Kline } from "../market.ts";
import type { SignalResult } from "../signals.ts";
import type { LabResult } from "./lab.ts";
import type { EarlyAlphaResult } from "./earlyalpha.ts";
import { dollarVolume24h, liquidityScore } from "./earlyalpha.ts";
import type { AssetClass, Classification } from "./types.ts";
import type { FlowAnalysis, DexAssessment, TokenSecurity } from "./flow.ts";
import type { CopyEvaluation } from "./copytrade.ts";
import { atrAt, clamp, round } from "./indicators.ts";

export interface TradePlan { side: "long"; entry: number; entryZone: [number, number]; stop: number; targets: { target: 1 | 2 | 3; price: number; rewardRisk: number }[]; invalidation: string; stopDistancePct: number }
export interface Check { id: string; pass: boolean; hard: boolean; detail: string }
export interface Validation { approved: boolean; score: number; checks: Check[]; reasons: string[]; method: string }

export function buildPlan(rows: Kline[]): TradePlan | null {
  const n = rows.length, atr = atrAt(rows, 14); if (n < 20 || !(atr > 0)) return null;
  const entry = rows[n - 1][4], swingLow = Math.min(...rows.slice(-10).map(r => r[3]));
  const dist = Math.max(Math.min(entry - swingLow + 0.2 * atr, 3 * atr), 1.2 * atr, entry * 0.002), stop = entry - dist;
  return { side: "long", entry, entryZone: [round(entry - 0.5 * atr, 8), entry], stop: round(stop, 8), stopDistancePct: round(dist / entry * 100, 2),
    targets: ([1, 2, 3] as const).map(r => ({ target: r, price: round(entry + dist * (r === 1 ? 1.5 : r === 2 ? 3 : 4.5), 8), rewardRisk: r === 1 ? 1.5 : r === 2 ? 3 : 4.5 })),
    invalidation: "Close below " + round(stop, 8) + " (or the signal / candle stream goes stale) invalidates the setup" };
}

export function independentValidation(rows: Kline[], ctx: { interval: string; assetClass: AssetClass; now: number; plan: TradePlan | null; washScore?: number; dexCritical?: boolean; attributionUnverified?: boolean }): Validation {
  const checks: Check[] = [], add = (id: string, pass: boolean, hard: boolean, detail: string) => checks.push({ id, pass, hard, detail });
  const n = rows.length, sec = INTERVAL_SECONDS[ctx.interval] ?? 3600, last = rows[n - 1];
  add("history", n >= 200, true, n + " candles available (need 200)");
  if (n < 20) return { approved: false, score: 0, checks, reasons: ["insufficient history"], method: METHOD };
  const monotonic = rows.every((r, i) => i === 0 || r[0] > rows[i - 1][0]), sane = rows.every(r => r[2] >= Math.max(r[1], r[4]) - 1e-12 && r[3] <= Math.min(r[1], r[4]) + 1e-12 && r[4] > 0);
  add("integrity", monotonic && sane, true, monotonic && sane ? "candles are ordered and OHLC-consistent" : "candles are out of order or violate OHLC bounds");
  const maxAge = ctx.assetClass === "equity" ? Math.max(sec * 3, 5 * 86400) : sec * 3, age = (ctx.now - last[0]) / 1000; add("freshness", age <= maxAge && age >= -60, true, "latest candle is " + Math.round(age) + "s old (max " + maxAge + "s" + (ctx.assetClass === "equity" ? ", allows weekends and holidays" : "") + ")");
  const usd = dollarVolume24h(rows, ctx.interval), liq = liquidityScore(usd, ctx.assetClass); add("liquidity", liq >= 0.3, true, "24h traded value " + Math.round(usd).toLocaleString("en-US") + " (score " + liq + "; below 0.3 is illiquid)");
  const atr = atrAt(rows, 14), atrPct = atr / last[4] * 100; add("volatility", atrPct <= 12, false, "ATR is " + round(atrPct, 2) + "% of price (limit 12%)");
  add("manipulation", (ctx.washScore ?? 0) < 0.6, true, "wash-trading score " + (ctx.washScore ?? 0) + " (hard limit 0.6)");
  if (ctx.dexCritical !== undefined) add("contract_security", !ctx.dexCritical, true, ctx.dexCritical ? "token contract has critical security flags" : "no critical contract flags (not a safety guarantee)");
  if (ctx.attributionUnverified !== undefined) add("attribution", !ctx.attributionUnverified, true, ctx.attributionUnverified ? "investor attribution is unverified" : "investor attribution verified");
  const zeroShare = rows.slice(-60).filter(r => r[5] === 0).length / 60; add("continuity", zeroShare <= 0.1, false, round(zeroShare * 100, 0) + "% zero-volume bars in the last 60");
  const p = ctx.plan; add("plan_exists", !!p, true, p ? "trade plan derived" : "no trade plan could be derived");
  if (p) {
    const d = p.entry - p.stop, atrStops = d / atr; add("plan_geometry", d > 0 && p.targets.every((t, i) => t.price > (i ? p.targets[i - 1].price : p.entry)), true, "stop below entry and targets ascending");
    add("stop_not_noise", atrStops >= 1, true, "stop is " + round(atrStops, 2) + " ATR away (needs >= 1 so ordinary noise does not trigger it)");
    add("stop_not_wide", atrStops <= 4, false, "stop is " + round(atrStops, 2) + " ATR away (limit 4)");
    const rr2 = (p.targets[1].price - p.entry) / d; add("reward_risk", rr2 >= 1.5, true, "reward/risk to TP2 is " + round(rr2, 2) + " (needs >= 1.5)");
    const hi = Math.max(...rows.slice(-120).map(r => r[2])); add("room_to_target", p.targets[0].price <= hi * 1.15, false, "TP1 is " + round((p.targets[0].price / hi - 1) * 100, 1) + "% versus the 120-bar high");
  }
  const hard = checks.filter(c => c.hard), soft = checks.filter(c => !c.hard), hardFail = hard.filter(c => !c.pass), softPass = soft.filter(c => c.pass).length;
  const score = round(100 * (hard.filter(c => c.pass).length / Math.max(1, hard.length) * 0.7 + (soft.length ? softPass / soft.length : 1) * 0.3), 0);
  const approved = hardFail.length === 0 && softPass >= Math.ceil(soft.length * 0.6);
  return { approved, score: hardFail.length ? Math.min(score, 49) : score, checks, reasons: [...hardFail.map(c => "HARD FAIL " + c.id + ": " + c.detail), ...soft.filter(c => !c.pass).map(c => "warning " + c.id + ": " + c.detail)], method: METHOD };
}
const METHOD = "Rule-based independent validator: recomputes liquidity, integrity, freshness, volatility and plan geometry from raw candles only; does not read early-alpha, fusion or engine scores";

// -------------------------------------------------------------------------- fusion
export interface FusionInput {
  symbol: string; assetClass: AssetClass; interval: string; exchange: string; provider: string; now: number; rows: Kline[];
  early: EarlyAlphaResult; signal: SignalResult | null; lab: LabResult | null; flow?: FlowAnalysis | null; flowScore?: number | null;
  copy?: CopyEvaluation[]; dex?: { assessment: DexAssessment; security: TokenSecurity | null } | null; invalidatedBy?: string | null;
}
export interface Scores { early: number; technical: number | null; fundamental: null; institutional: number | null; investorFollowing: number | null; onchain: number | null; orderFlow: number | null; liquidity: number; risk: number; validation: number; overall: number }
export interface Fused {
  symbol: string; assetClass: AssetClass; exchange: string; interval: string; classification: Classification; kind: "discovery_candidate" | "executable_trade"; executable: boolean; executableReason: string;
  scores: Scores; price: number; stage: EarlyAlphaResult["stage"]; stageBias: EarlyAlphaResult["stageBias"]; reasons: string[]; vetoes: string[]; plan: TradePlan | null; validation: Validation;
  strategyAgreement: { moduleId: string; name: string; traders: string; status: string; oosExpectancyR: number | null }[]; confidence: { evidenceCoverage: number; note: string };
  catalysts: string[]; investorActivity: string[]; sources: string[]; discoveredAt: string; asOf: string; engine: { action: string | null; score: number | null; conviction: string | null; tradeable: boolean | null };
}

export function fuse(inp: FusionInput): Fused {
  const { rows, early, signal, lab } = inp, last = rows[rows.length - 1], price = last[4];
  const plan = buildPlan(rows);
  const copyBest = (inp.copy ?? []).filter(c => c.classification !== "REJECTED_OPPORTUNITY" && c.classification !== "STALE_DISCLOSURE");
  const validation = independentValidation(rows, { interval: inp.interval, assetClass: inp.assetClass, now: inp.now, plan, washScore: inp.flow?.washScore, dexCritical: inp.dex?.security ? inp.dex.security.verdict === "critical" : undefined, attributionUnverified: (inp.copy ?? []).length ? (inp.copy ?? []).some(c => c.checks.some(k => k.id === "source_verified" && k.pass === false)) && copyBest.length === 0 : undefined });
  const liq = liquidityScore(early.metrics.dollarVolume24h, inp.assetClass) * 100;
  const technical = signal ? clamp((signal.score + 100) / 200) * 100 * (signal.label === "BUY" ? 1 : 0.6) : null;
  const institutional = (inp.copy ?? []).length ? Math.max(...(inp.copy ?? []).map(c => c.score)) : null;
  const following = copyBest.length ? Math.max(...copyBest.map(c => c.score)) : null;
  const onchain = early.factors.find(f => f.id === "onchain")?.score != null ? (early.factors.find(f => f.id === "onchain")!.score as number) * 100 : null;
  const orderFlow = inp.flowScore != null ? inp.flowScore * 100 : null;
  const riskParts = [clamp((atrAt(rows, 14) / price * 100) / 12), inp.flow?.washScore ?? 0, inp.dex?.assessment.riskScore ?? 0, early.stageBias === "risk" ? 0.7 : 0, 1 - liq / 100];
  const risk = round(100 * Math.min(1, Math.max(...riskParts) * 0.6 + (riskParts.reduce((a, b) => a + b, 0) / riskParts.length) * 0.4), 0);
  const w: [number | null, number][] = [[early.score, 0.25], [technical, 0.2], [institutional, 0.08], [following, 0.04], [onchain, 0.06], [orderFlow, 0.07], [liq, 0.1], [validation.score, 0.2]];
  const used = w.filter(([v]) => v !== null) as [number, number][], base = used.reduce((a, [v, k]) => a + v * k, 0) / used.reduce((a, [, k]) => a + k, 0);
  let overall = base * (1 - 0.4 * risk / 100); if (!validation.approved) overall = Math.min(overall, 60); overall = round(overall, 1);
  const scores: Scores = { early: early.score, technical: technical === null ? null : round(technical, 1), fundamental: null, institutional, investorFollowing: following, onchain, orderFlow, liquidity: round(liq, 0), risk, validation: validation.score, overall };

  const vetoes = validation.checks.filter(c => c.hard && !c.pass).map(c => c.id + ": " + c.detail);
  if (inp.dex?.security?.verdict === "critical") vetoes.push("contract_security: critical token-contract flags");
  const agreeing = lab ? lab.results.filter(r => r.status !== "not_testable" && r.kind !== "combination" && lab.latestVotes[r.id] === 1 && r.compat.compatible && (r.status === "promoted" || r.status === "candidate")) : [];
  const strategyAgreement = lab ? lab.results.filter(r => r.status !== "not_testable" && r.kind !== "combination" && lab.latestVotes[r.id] === 1).map(r => ({ moduleId: r.id, name: r.name, traders: r.traders, status: r.status, oosExpectancyR: r.outOfSample.avgR })) : [];
  const stage = early.stage, reasons = [...early.stageReasons, ...early.factors.filter(f => f.score !== null && f.score >= 0.65 && f.weight > 0).map(f => f.label + ": " + f.evidence[0])];
  let cls: Classification;
  if (inp.invalidatedBy) cls = "INVALIDATED";
  else if (vetoes.length || (early.score < 25 && !(signal && signal.conviction === "high"))) cls = "REJECTED";
  else if ((stage === "BREAKOUT_CONFIRMATION" || stage === "TREND_EXPANSION") && validation.approved && (technical ?? 0) >= 60) {
    cls = signal?.tradeable && signal.label === "BUY" && agreeing.length >= 2 && overall >= 70 && early.evidenceCoverage >= 0.5 && !inp.dex ? "HIGH_CONVICTION_OPPORTUNITY" : "CONFIRMED_OPPORTUNITY";
  } else if (stage === "BREAKOUT_FORMATION" || (early.score >= 60 && (technical ?? 0) >= 55 && early.stageBias !== "risk")) cls = "DEVELOPING_OPPORTUNITY";
  else if ((stage === "EARLY_ACCUMULATION" || stage === "PRE_ACCUMULATION") && early.score >= 50) cls = "EARLY_ACCUMULATION";
  else cls = early.score >= 35 && early.stageBias !== "risk" ? "WATCHLIST" : "REJECTED";
  if (early.stageBias === "risk" && cls !== "REJECTED" && cls !== "INVALIDATED") cls = "WATCHLIST";

  const executable = (cls === "CONFIRMED_OPPORTUNITY" || cls === "HIGH_CONVICTION_OPPORTUNITY") && validation.approved && !inp.dex && !!plan && signal?.label === "BUY";
  const executableReason = executable ? "passed independent validation; execution still requires the in-process order safeguards and explicit authorization" : inp.dex ? "DEX tokens have no connected execution venue" : cls === "REJECTED" || cls === "INVALIDATED" ? "rejected or invalidated" : !validation.approved ? "independent validation not approved" : "discovery candidate only: confirmation and validation criteria not yet met";
  const copyNotes = (inp.copy ?? []).map(c => c.classification + ": " + c.investor + " " + c.summary);
  return { symbol: inp.symbol, assetClass: inp.assetClass, exchange: inp.exchange, interval: inp.interval, classification: cls, kind: executable ? "executable_trade" : "discovery_candidate", executable, executableReason, scores, price, stage, stageBias: early.stageBias, reasons, vetoes, plan, validation, strategyAgreement,
    confidence: { evidenceCoverage: early.evidenceCoverage, note: early.uncertainty }, catalysts: early.factors.find(f => f.id === "catalyst")?.score != null ? early.factors.find(f => f.id === "catalyst")!.evidence : ["no catalyst feed connected"], investorActivity: copyNotes,
    sources: [inp.provider + " public market data (" + inp.exchange + ")", ...(inp.dex ? ["dexscreener.com", ...(inp.dex.security ? ["gopluslabs.io"] : [])] : []), ...(copyNotes.length ? ["SEC EDGAR"] : [])], discoveredAt: new Date(inp.now).toISOString(), asOf: new Date(last[0]).toISOString(),
    engine: { action: signal?.action ?? null, score: signal?.score ?? null, conviction: signal?.conviction ?? null, tradeable: signal?.tradeable ?? null } };
}

/** Risk-based position size. Notional is capped so one trade cannot exceed maxNotionalPct of equity. */
export function sizePosition(i: { equity: number; riskPercent: number; entry: number; stop: number; maxNotionalPct?: number }): { quantity: number; notional: number; riskAmount: number; riskPercent: number; cappedByNotional: boolean } | null {
  const { equity, entry, stop } = i; if (![equity, entry, stop, i.riskPercent].every(Number.isFinite) || equity <= 0 || entry <= stop || stop <= 0 || i.riskPercent <= 0) return null;
  const riskPct = Math.min(i.riskPercent, 1), riskAmt = equity * riskPct / 100, q0 = riskAmt / (entry - stop), cap = equity * (i.maxNotionalPct ?? 20) / 100 / entry, q = Math.min(q0, cap);
  return { quantity: Number(q.toPrecision(6)), notional: round(q * entry, 2), riskAmount: round(q * (entry - stop), 2), riskPercent: riskPct, cappedByNotional: q < q0 };
}
