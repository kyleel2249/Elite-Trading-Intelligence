// Central intelligence: receives independent EngineReports (technical/multi-timeframe, fundamental, sentiment) and produces one brief.
// It never forces agreement. Disagreements between engines are reported as conflicts, and hard vetoes (crypto legitimacy, data
// sufficiency, manipulated news) can cap a verdict regardless of how strong another engine looks. It is analytical only: it cannot submit orders.
import type { MtfAnalysis, MtfStrategy } from "./mtf.ts";
import type { SentimentAssessment } from "./sentiment.ts";
import type { OmnisignalResult } from "../algo/omnisignal.ts";
import { clamp, round, type AssetClass, type EngineReport, type SourceRef, type Stance } from "./types.ts";

export type Verdict = "BULLISH_CASE" | "BEARISH_CASE" | "NEUTRAL" | "CONFLICTED" | "AVOID" | "INSUFFICIENT_DATA";
export interface DomainView { domain: "technical" | "fundamental" | "sentiment"; stance: Stance; score: number; confidence: number; baseWeight: number; effectiveWeight: number; status: EngineReport["status"]; summary: string }
export interface EngineConflict { between: [string, string]; detail: string; severity: "moderate" | "high" }
export interface Veto { id: string; effect: "avoid" | "cap_bullish" | "downweight" | "warn"; reason: string }
export interface IntelligenceBrief {
  symbol: string; assetClass: AssetClass; strategy: MtfStrategy; generatedAt: string;
  verdict: Verdict; netScore: number; confidence: number; confidenceType: "evidence_quality_not_probability";
  domains: DomainView[]; conflicts: EngineConflict[]; vetoes: Veto[]; coverage: { available: string[]; unavailable: string[] };
  headline: string; reasoning: string[]; timing: string[]; risks: string[]; whatWouldChangeThisView: string[];
  evidenceLedger: SourceRef[]; engineReports: EngineReport[];
  crossCheck: { omnisignal: { decision: string; confidence: number; agrees: boolean | null; note: string } | null };
  disclaimer: string; submitsOrder: false; liveExecutionAllowed: false;
}
export const BASE_WEIGHTS: Record<AssetClass, { technical: number; fundamental: number; sentiment: number }> = {
  crypto: { technical: 0.40, fundamental: 0.35, sentiment: 0.25 }, fx: { technical: 0.40, fundamental: 0.40, sentiment: 0.20 }, stock: { technical: 0.35, fundamental: 0.45, sentiment: 0.20 }, unknown: { technical: 0.5, fundamental: 0.3, sentiment: 0.2 },
};
/** Short horizons lean on technicals, long horizons on fundamentals; weights always re-normalise. */
const STRATEGY_TILT: Record<MtfStrategy, number> = { scalp: 0.15, intraday: 0.08, swing: 0, position: -0.15 };
const DISCLAIMER = "Analytical evidence only, not investment advice. Scores are heuristic evidence measures, not probabilities of profit. No engine can predict markets; past patterns do not guarantee future results.";

export interface IntelligenceInput {
  symbol: string; assetClass: AssetClass; strategy: MtfStrategy; mtf?: MtfAnalysis | null; fundamental?: EngineReport | null; sentiment?: SentimentAssessment | null;
  omnisignal?: OmnisignalResult | null; now?: number; fundamentalMissingReason?: string; sentimentMissingReason?: string;
}
const sgn = (s: Stance) => (s === "bullish" ? 1 : s === "bearish" ? -1 : 0);
const label = (s: Stance) => (s === "unavailable" ? "unavailable" : s);

export function centralIntelligence(inp: IntelligenceInput): IntelligenceBrief {
  const now = inp.now ?? Date.now(), strat = inp.strategy, w0 = BASE_WEIGHTS[inp.assetClass], tilt = STRATEGY_TILT[strat];
  const base = { technical: w0.technical + tilt, fundamental: w0.fundamental - tilt, sentiment: w0.sentiment };
  const reports: { domain: DomainView["domain"]; r: EngineReport | null; summary: string }[] = [
    { domain: "technical", r: inp.mtf?.report ?? null, summary: inp.mtf ? `${inp.mtf.alignment.replace(/_/g, " ")}; ${inp.mtf.guidance[0] ?? ""}` : "no technical analysis" },
    { domain: "fundamental", r: inp.fundamental ?? null, summary: inp.fundamental ? `${inp.fundamental.findings.slice(0, 2).map(f => f.description).join(" | ")}` : inp.fundamentalMissingReason ?? "no fundamental analysis" },
    { domain: "sentiment", r: inp.sentiment?.report ?? null, summary: inp.sentiment ? `${inp.sentiment.events.length} events, manipulation risk ${inp.sentiment.manipulation.risk}/100` : inp.sentimentMissingReason ?? "no news analysis" },
  ];
  const vetoes: Veto[] = [], risks: string[] = [], reasoning: string[] = [], timing: string[] = [], change: string[] = [];
  // ---- hard vetoes and down-weights ----
  const fundExtras = inp.fundamental?.extras as { legitimacy?: string; redFlags?: { severity: string; flag: string }[] } | undefined;
  const legit = fundExtras?.legitimacy;
  let avoid = false, capBullish = false;
  if (inp.assetClass === "crypto") {
    if (legit === "high_risk") { avoid = true; vetoes.push({ id: "crypto-legitimacy", effect: "avoid", reason: `Fundamental legitimacy is HIGH RISK (${(fundExtras?.redFlags ?? []).filter(f => f.severity !== "medium").slice(0, 3).map(f => f.flag).join("; ")}). A bullish chart cannot compensate.` }); }
    else if (legit === "unverified" || !inp.fundamental || inp.fundamental.status === "unavailable") { capBullish = true; vetoes.push({ id: "crypto-unverified", effect: "cap_bullish", reason: "The token's real economic or technological value could not be verified (team, tokenomics, security and adoption data are missing). A bullish verdict is withheld: chart strength alone is not a reason to buy a token." }); }
    else if (legit === "caution") vetoes.push({ id: "crypto-caution", effect: "warn", reason: "Fundamental red flags of high severity exist; position risk is elevated even if technicals are constructive." });
  }
  const manip = inp.sentiment?.manipulation.risk ?? 0;
  const sentimentScale = manip >= 60 ? 0.3 : manip >= 35 ? 0.6 : 1;
  if (sentimentScale < 1) vetoes.push({ id: "news-integrity", effect: "downweight", reason: `News/social flow shows manipulation indicators (risk ${manip}/100): sentiment weight reduced to ${round(sentimentScale * 100, 0)}% of normal.` });
  const evRisk = (inp.fundamental?.extras as { eventRisk?: boolean } | undefined)?.eventRisk === true;
  if (evRisk) vetoes.push({ id: "event-risk", effect: "warn", reason: "A high-impact scheduled release is due within 24 hours: expect volatility and gaps; analysis before the release may be invalidated by it." });

  // ---- domain views ----
  const views: DomainView[] = reports.map(({ domain, r, summary }) => {
    const ok = !!r && r.status !== "unavailable" && r.stance !== "unavailable";
    const bw = base[domain] * (domain === "sentiment" ? sentimentScale : 1);
    const eff = ok ? bw * (0.3 + 0.7 * r!.confidence / 100) : 0;
    return { domain, stance: r?.stance ?? "unavailable", score: r?.score ?? 0, confidence: r?.confidence ?? 0, baseWeight: round(bw, 3), effectiveWeight: eff, status: r?.status ?? "unavailable", summary };
  });
  const avail = views.filter(v => v.effectiveWeight > 0), wSum = avail.reduce((s, v) => s + v.effectiveWeight, 0);
  for (const v of views) v.effectiveWeight = round(wSum > 0 ? v.effectiveWeight / wSum : 0, 3);
  const net = wSum > 0 ? avail.reduce((s, v) => s + v.effectiveWeight * v.score, 0) : 0;
  // ---- conflicts: independent engines pointing opposite ways are reported, never averaged away ----
  const conflicts: EngineConflict[] = [];
  const dirOf = (v: DomainView) => (v.stance === "bullish" ? 1 : v.stance === "bearish" ? -1 : 0);
  for (let i = 0; i < avail.length; i++) for (let j = i + 1; j < avail.length; j++) {
    const a = avail[i], b = avail[j];
    if (dirOf(a) !== 0 && dirOf(b) !== 0 && dirOf(a) !== dirOf(b) && Math.abs(a.score) >= 20 && Math.abs(b.score) >= 20) {
      const hint = [a.domain, b.domain].sort().join("+") === "fundamental+technical" ? (a.domain === "technical" ? a : b).stance === "bullish" ? "price action is constructive but the underlying assessment is negative: strength may be unsupported" : "fundamentals look supportive but price action is weak: the market has not (yet) agreed" : "narrative and price/fundamentals disagree";
      conflicts.push({ between: [a.domain, b.domain], detail: `${a.domain} is ${a.stance} (${round(a.score, 0)}) while ${b.domain} is ${b.stance} (${round(b.score, 0)}): ${hint}`, severity: Math.min(Math.abs(a.score), Math.abs(b.score)) >= 40 ? "high" : "moderate" });
    }
  }
  for (const v of avail) if (v.stance === "conflicted") conflicts.push({ between: [v.domain, v.domain], detail: `${v.domain} analysis is internally conflicted: ${inp.mtf && v.domain === "technical" ? inp.mtf.conflicts.slice(0, 2).join("; ") : inp.sentiment && v.domain === "sentiment" ? inp.sentiment.conflicts.slice(0, 1).map(c => c.detail).join("; ") : "see engine report"}`, severity: "moderate" });
  // ---- verdict ----
  let verdict: Verdict;
  const rawDir = net >= 20 ? "BULLISH_CASE" : net <= -20 ? "BEARISH_CASE" : "NEUTRAL";
  if (avail.length < 2) verdict = "INSUFFICIENT_DATA";
  else if (avoid) verdict = "AVOID";
  else if (conflicts.some(c => c.severity === "high") && Math.abs(net) < 35) verdict = "CONFLICTED";
  else if (conflicts.length >= 2 && Math.abs(net) < 30) verdict = "CONFLICTED";
  else verdict = rawDir;
  if (verdict === "BULLISH_CASE" && capBullish) { verdict = "NEUTRAL"; reasoning.push(`Evidence leaned bullish (net ${round(net, 0)}) but the verdict is capped at NEUTRAL: see veto "crypto-unverified".`); }
  const coverage = { available: avail.map(v => v.domain), unavailable: views.filter(v => v.effectiveWeight === 0).map(v => v.domain) };
  const baseConf = wSum > 0 ? avail.reduce((s, v) => s + v.effectiveWeight * v.confidence, 0) : 0;
  const confidence = clamp(baseConf - conflicts.reduce((s, c) => s + (c.severity === "high" ? 15 : 8), 0) - coverage.unavailable.length * 6 - (evRisk ? 8 : 0) - (manip >= 35 ? 8 : 0), 0, 100);
  // ---- narrative ----
  for (const v of views) reasoning.push(`${v.domain[0].toUpperCase() + v.domain.slice(1)}: ${label(v.stance)}${v.effectiveWeight > 0 ? ` (score ${round(v.score, 0)}, confidence ${round(v.confidence, 0)}, weight ${round(v.effectiveWeight * 100, 0)}%)` : ` (${v.summary})`}`);
  if (avail.length < 2) reasoning.push("Fewer than two independent evidence domains are available: no integrated conclusion is drawn.");
  for (const c of conflicts) reasoning.push(`Conflict (${c.severity}): ${c.detail}`);
  if (inp.mtf) { timing.push(...inp.mtf.guidance); const dom = inp.mtf.timeframes.filter(t => t.analysis && t.report.stance === (net >= 0 ? "bullish" : "bearish")).sort((a, b) => b.report.confidence - a.report.confidence)[0]; const inv = dom?.analysis?.structure.invalidationLevel; if (inv) change.push(`A close through ${round(inv, 4)} on ${dom!.timeframe} would invalidate the ${dom!.timeframe} structure supporting this view`); }
  if (inp.mtf?.conflicts.length) risks.push(...inp.mtf.conflicts.slice(0, 3).map(c => `Timeframe conflict: ${c}`));
  for (const rpt of reports.flatMap(r => r.r ? r.r.warnings : []).slice(0, 6)) risks.push(rpt);
  if (inp.fundamental && fundExtras?.redFlags?.length) risks.push(...fundExtras.redFlags.slice(0, 4).map(f => `[${f.severity}] ${f.flag}`));
  if (inp.sentiment?.manipulation.signals.length) risks.push(`Manipulation indicators: ${[...new Set(inp.sentiment.manipulation.signals.map(s => s.kind))].join(", ")}`);
  if (legit && legit !== "substantive") change.push(`Legitimacy is "${legit}": verified team, audited contracts, healthy liquidity and real usage would change the fundamental view`);
  if (inp.sentiment?.unverifiedSocial) change.push(`${inp.sentiment.unverifiedSocial} social narrative(s) are unverified: credible corroboration would raise their weight`);
  if (avail.length < 3) change.push(`Missing evidence domains (${coverage.unavailable.join(", ")}) would make the view more reliable if supplied`);
  // ---- cross-check with the existing Omnisignal execution engine (informational, not part of the weighted score) ----
  let cross: IntelligenceBrief["crossCheck"]["omnisignal"] = null;
  if (inp.omnisignal) {
    const d = inp.omnisignal.decision, dir = d === "BUY" ? 1 : d === "SELL" ? -1 : 0, vdir = verdict === "BULLISH_CASE" ? 1 : verdict === "BEARISH_CASE" ? -1 : 0;
    const agrees = dir === 0 || vdir === 0 ? null : dir === vdir;
    cross = { decision: d, confidence: inp.omnisignal.confidence, agrees, note: agrees === null ? `Omnisignal is ${d}: no directional comparison possible` : agrees ? "The independent Swift/Gainz execution engines point the same way as this brief" : "The Swift/Gainz execution engines point the OPPOSITE way to this brief: treat as a conflict and do not act on either alone" };
    if (agrees === false) risks.push(cross.note);
  }
  const names: Record<Verdict, string> = { BULLISH_CASE: "Evidence favours a bullish case", BEARISH_CASE: "Evidence favours a bearish case", NEUTRAL: "No clear directional edge", CONFLICTED: "Evidence conflicts: no direction is justified", AVOID: "Avoid: fundamental red flags outweigh any technical setup", INSUFFICIENT_DATA: "Insufficient evidence to conclude" };
  const sources = reports.flatMap(r => r.r?.sources ?? []);
  const ledger = [...new Map(sources.map(s => [`${s.name}|${s.publishedAt ?? ""}|${s.url ?? ""}`, s])).values()].slice(0, 40);
  return { symbol: inp.symbol, assetClass: inp.assetClass, strategy: strat, generatedAt: new Date(now).toISOString(), verdict, netScore: round(net, 1), confidence: round(confidence, 0), confidenceType: "evidence_quality_not_probability", domains: views, conflicts, vetoes, coverage,
    headline: `${names[verdict]}${verdict === "BULLISH_CASE" || verdict === "BEARISH_CASE" ? ` (net ${round(net, 0)}, confidence ${round(confidence, 0)})` : ""}`, reasoning, timing, risks: [...new Set(risks)].slice(0, 12), whatWouldChangeThisView: change,
    evidenceLedger: ledger, engineReports: reports.flatMap(r => (r.r ? [r.r] : [])), crossCheck: { omnisignal: cross }, disclaimer: DISCLAIMER, submitsOrder: false, liveExecutionAllowed: false };
}
