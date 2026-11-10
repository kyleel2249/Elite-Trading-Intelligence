// Elite Trader integration (Phase 5): evaluates a proposed trade against the documented methodologies in ETI's Elite Trader
// research database (worker/knowledge.generated.json, produced from app/knowledge) and the candle-testable strategy modules.
// Evidence only: it reports whether a documented principle is consistent with the trade. It never says an investor "would take
// this trade", never attributes a position to anyone, and never invents performance. Modules that need data candles do not
// carry (earnings, macro) are reported as not applicable.
import knowledgeData from "../knowledge.generated.json" with { type: "json" };
import { indicators } from "../signals.ts";
import { attributionFor, runModules, stanceOf, type AttributionEntry, type ModuleResult, type Regime } from "../strategies.ts";
import type { Kline } from "../market.ts";
import type { TimeframeSummary } from "./omnisignal.ts";
import type { FlowAnalysis } from "./flow.ts";

type KB = { generatedAt: string | null; source: string; profiles: any[]; strategies: any[]; freshness?: { researchDate?: string } };
const KB_DATA = knowledgeData as KB;

export type PrincipleStatus = "supports" | "opposes" | "neutral" | "not_applicable" | "info";
export interface PrincipleCheck { id: string; principle: string; status: PrincipleStatus; evidence: string; documentedBy: string[] }
export interface EliteAssessment {
  available: boolean; reason?: string; direction: 1 | -1;
  knowledge: { source: string; generatedAt: string | null; researchDate: string | null; profiles: number; strategies: number };
  regime: Regime | null; supporting: number; opposing: number; neutral: number; suppressed: number; notApplicable: number;
  alignment: "supports" | "mixed" | "opposes" | "unavailable";
  principles: PrincipleCheck[]; attribution: AttributionEntry[]; warnings: string[];
  disclosures: { status: "not_available"; reason: string };
  influencesDecision: boolean; limitations: string;
}
export const ELITE_LIMITATIONS = "Documented-methodology consistency only. No private algorithms, undisclosed positions or unpublished results are claimed, no investor is said to endorse this trade, and no performance is attributed to any trader.";

const kbMeta = (kb: KB = KB_DATA) => ({ source: kb.source, generatedAt: kb.generatedAt, researchDate: kb.freshness?.researchDate ?? null, profiles: kb.profiles.length, strategies: kb.strategies.length });
/** Names of the people whose documented methodology a strategy module is inspired by, taken from the research database. */
export function documentedBy(moduleIds: string[], kb: KB = KB_DATA): string[] {
  const names = new Set<string>();
  for (const id of moduleIds) for (const s of kb.strategies.filter(x => x.id === id)) for (const n of s.inspired_by ?? []) names.add(String(n));
  return [...names];
}
const consensusOf = (rs: ModuleResult[], ids: string[], dir: 1 | -1): { status: PrincipleStatus; evidence: string } => {
  const sel = rs.filter(r => ids.includes(r.moduleId)), act = sel.filter(r => r.status === "active");
  if (!sel.length) return { status: "not_applicable", evidence: "no module" };
  if (!act.length) return { status: "not_applicable", evidence: sel.map(r => `${r.name}: ${r.status} (${r.reason})`).join("; ") };
  const sup = act.filter(r => stanceOf(r, dir) === "supporting"), opp = act.filter(r => stanceOf(r, dir) === "opposing");
  const status: PrincipleStatus = opp.length && !sup.length ? "opposes" : sup.length && !opp.length ? "supports" : sup.length && opp.length ? "neutral" : "neutral";
  return { status, evidence: act.map(r => `${r.name}: ${r.reason}`).join("; ") };
};

export interface PlanView { entryZone: [number, number] | null; stopLoss: number | null; takeProfits: { price: number; rewardRisk: number }[] | null }
export function assessElite(rows: Kline[] | undefined, dir: 1 | -1, plan: PlanView, exec: TimeframeSummary | null | undefined, flow?: FlowAnalysis | null, kb: KB = KB_DATA): EliteAssessment {
  const base = { direction: dir, knowledge: kbMeta(kb), disclosures: { status: "not_available" as const, reason: "ETI's analysed instruments are crypto spot pairs; no verified investor disclosure feed exists for them, so none is used or implied. Equity disclosures (13F/Form 4) are handled by the separate investor-activity service." }, influencesDecision: false, limitations: ELITE_LIMITATIONS };
  const ind = rows ? indicators(rows) : null;
  if (!rows || !ind) return { ...base, available: false, reason: "At least 210 execution-timeframe candles are required for the candle-testable modules", regime: null, supporting: 0, opposing: 0, neutral: 0, suppressed: 0, notApplicable: 0, alignment: "unavailable", principles: [], attribution: [], warnings: [] };
  const { regime, results } = runModules(rows, ind), attribution = attributionFor(results, dir);
  const count = (s: string) => attribution.filter(a => a.stance === s).length, supporting = count("supporting"), opposing = count("opposing");
  const by = (ids: string[]) => documentedBy(ids, kb);
  const trend = consensusOf(results, ["turtle_trend", "seykota_mechanical", "minervini_vcp"], dir), brk = consensusOf(results, ["darvas_box"], dir), rev = consensusOf(results, ["wyckoff_supply_demand"], dir), struct = consensusOf(results, ["ptj_structure_preservation"], dir);
  const mom: PrincipleCheck = exec ? { id: "momentum", principle: "Momentum trading", status: exec.momentum * dir > 15 ? "supports" : exec.momentum * dir < -15 ? "opposes" : "neutral", evidence: `execution-timeframe momentum score ${exec.momentum.toFixed(0)} (volume ${exec.volumeConfirms ? "confirms" : "does not confirm"}, relative volume ${exec.relativeVolume.toFixed(2)}x)`, documentedBy: by(["oneil_canslim", "minervini_vcp"]) } : { id: "momentum", principle: "Momentum trading", status: "not_applicable", evidence: "execution-timeframe analysis unavailable", documentedBy: [] };
  const entry = plan.entryZone, stop = plan.stopLoss, tps = plan.takeProfits, risk = entry && stop ? Math.abs((entry[0] + entry[1]) / 2 - stop) : 0;
  const risky = !(stop && risk > 0), rr1 = tps?.[0]?.rewardRisk ?? 0;
  const principles: PrincipleCheck[] = [
    { id: "trend_following", principle: "Trend following", ...trend, documentedBy: by(["turtle_trend", "seykota_mechanical", "minervini_vcp"]) }, mom,
    { id: "breakout_trading", principle: "Breakout trading", ...brk, documentedBy: by(["darvas_box", "turtle_trend"]) },
    { id: "reversal_trading", principle: "Reversal trading", ...rev, documentedBy: by(["wyckoff_supply_demand"]) },
    { id: "capital_preservation", principle: "Risk management and capital preservation", status: risky ? "opposes" : rr1 >= 1 ? "supports" : "neutral", evidence: risky ? "no valid stop-loss, so there is no invalidation level" : `explicit invalidation at the stop (${(risk / ((entry![0] + entry![1]) / 2) * 100).toFixed(2)}% from entry), TP1 reward/risk ${rr1.toFixed(2)}; long-term structure: ${struct.evidence}`, documentedBy: by(["ptj_structure_preservation", "soros_reflexivity"]) },
    flow && flow.available ? { id: "volume_footprint", principle: "Volume footprint (absorption, abnormal activity)", status: flow.supports === "unavailable" ? "not_applicable" : flow.supports, evidence: `${flow.stanceBias} ${flow.pressureBasis === "taker_buy_volume" ? "taker-volume imbalance" : "close-location pressure proxy"}${flow.flags.length ? "; " + flow.flags.map(f => f.kind.replace(/_/g, " ")).join(", ") : "; no abnormal bars"}. ${flow.caveat}`, documentedBy: by(["wyckoff_supply_demand"]) } : { id: "volume_footprint", principle: "Volume footprint (absorption, abnormal activity)", status: "not_applicable", evidence: "insufficient candles", documentedBy: [] },
    { id: "position_sizing", principle: "Position sizing", status: "info", evidence: "Fixed-fraction risk to the stop only. Kelly-style up-sizing is withheld because no statistically demonstrated edge exists (docs/RESEARCH_FINDINGS.md).", documentedBy: by(["druck_liquidity_macro", "simons_quant"]) },
    { id: "portfolio_management", principle: "Portfolio management", status: "info", evidence: "Enforced outside the signal: one position per symbol, a position cap, daily-loss and consecutive-loss limits, and the server-side risk gateway.", documentedBy: [] },
    { id: "entry_exit", principle: "Entry and exit methodologies", status: tps && tps.length === 3 && !risky ? "supports" : "neutral", evidence: tps ? `entry zone, ATR-based stop and three staged targets (40/30/30) with break-even after TP1 and a trailing stop after TP2` : "no complete plan", documentedBy: by(["turtle_trend", "seykota_mechanical"]) },
    { id: "statistical_validation", principle: "Statistical validation", status: "info", evidence: "Confidence is uncalibrated unless a calibration table with enough samples applies; see the calibration field.", documentedBy: by(["simons_quant"]) },
  ];
  const warnings: string[] = [];
  if (supporting === 0 && opposing >= 2) warnings.push(`${opposing} documented-methodology modules oppose this direction and none support it`);
  const against = results.filter(r => r.status === "active" && stanceOf(r, dir) === "opposing").map(r => r.name);
  if (against.length && supporting === 0) warnings.push(`Opposing: ${against.join(", ")}`);
  if (regime.state === "range" && trend.status === "supports") warnings.push("Trend-following modules agree, but the regime is a range (ADX<20), where those methods are documented to whipsaw");
  const alignment = supporting >= 2 && opposing === 0 ? "supports" : opposing >= 2 && supporting === 0 ? "opposes" : "mixed";
  return { ...base, available: true, regime, supporting, opposing, neutral: count("neutral"), suppressed: count("suppressed"), notApplicable: count("not_applicable"), alignment, principles, attribution, warnings };
}
