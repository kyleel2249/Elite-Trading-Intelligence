/** 1. ETI COMMANDER: weighs agent reports, explains every disagreement, and obeys the Risk Manager's veto. */
import { makeReport, DIRECTIONAL_AGENTS } from "./types.ts";
import type { AgentId, AgentReport, Stance, TradeProposal } from "./types.ts";
import type { AuditSummary, RiskDecision, Severity } from "./controls.ts";
import { clamp } from "./math.ts";

const BASE_WEIGHT: Record<string, number> = { quant: 1, technical: 1, fundamental: 0.8, macro: 0.8, crypto: 0.8, news: 0.7, researcher: 0.5 };
export const AGREEMENT_THRESHOLD = 0.35, MIN_PARTICIPANTS = 3, DISSENT_CONFIDENCE = 0.35;

export interface Position { agent: AgentId; stance: Stance; confidence: number; reason: string }
export interface Dispute { topic: string; between: AgentId[]; positions: Position[]; explanation: string; resolution: string }
export interface Deliberation {
  direction: "long" | "short" | "none"; agreement: number; coverage: number; confidence: number; reason: string;
  participating: AgentId[]; abstaining: { agent: AgentId; reason: string }[]; weights: Record<string, number>;
  disputes: Dispute[]; dissent: Position[];
}

const pos = (r: AgentReport): Position => ({ agent: r.agent, stance: r.stance, confidence: r.confidence, reason: r.summary });

export function deliberate(reports: AgentReport[], audit: AuditSummary | null): Deliberation {
  const byId = new Map(reports.map((r) => [r.agent, r])), part: AgentReport[] = [], abstaining: Deliberation["abstaining"] = [], weights: Record<string, number> = {};
  for (const id of DIRECTIONAL_AGENTS) {
    const r = byId.get(id);
    if (!r || r.status !== "ok" || r.stance === "no_data") { abstaining.push({ agent: id, reason: !r ? "no report" : r.status === "error" ? "error: " + r.summary : "insufficient data: " + (r.missingInputs[0] ?? r.summary) }); continue; }
    part.push(r);
    const a = audit?.agentAccuracy[id]; weights[id] = BASE_WEIGHT[id] * (a && a.n >= 20 ? clamp(a.accuracy / 0.5, 0.5, 1.25) : 1);
  }
  const totalBase = DIRECTIONAL_AGENTS.reduce((s, id) => s + BASE_WEIGHT[id], 0), coverage = part.reduce((s, r) => s + BASE_WEIGHT[r.agent], 0) / totalBase;
  let num = 0, den = 0;
  for (const r of part) { const w = weights[r.agent] * Math.max(r.confidence, 0.05); num += w * (r.stance === "bullish" ? 1 : r.stance === "bearish" ? -1 : 0); den += w; }
  const agreement = den > 0 ? num / den : 0;
  const bulls = part.filter((r) => r.stance === "bullish" && r.confidence >= DISSENT_CONFIDENCE), bears = part.filter((r) => r.stance === "bearish" && r.confidence >= DISSENT_CONFIDENCE);
  let direction: Deliberation["direction"] = "none", reason: string;
  if (part.length < MIN_PARTICIPANTS) reason = `Only ${part.length} agent(s) produced a usable stance; at least ${MIN_PARTICIPANTS} are required for a consensus.`;
  else if (agreement >= AGREEMENT_THRESHOLD) { direction = "long"; reason = `Weighted agreement ${agreement.toFixed(2)} ≥ ${AGREEMENT_THRESHOLD}.`; }
  else if (agreement <= -AGREEMENT_THRESHOLD) { direction = "short"; reason = `Weighted agreement ${agreement.toFixed(2)} ≤ -${AGREEMENT_THRESHOLD}.`; }
  else reason = `Weighted agreement ${agreement.toFixed(2)} is inside ±${AGREEMENT_THRESHOLD}: no edge strong enough to act on.`;
  const disputes: Dispute[] = [];
  if (bulls.length && bears.length) {
    const names = (l: AgentReport[]) => l.map((r) => `${r.agent} (${r.confidence.toFixed(2)})`).join(", ");
    disputes.push({
      topic: "direction", between: [...bulls, ...bears].map((r) => r.agent), positions: [...bulls, ...bears].map(pos),
      explanation: `Bullish: ${names(bulls)}. Bearish: ${names(bears)}. Their evidence points in opposite directions; both camps are reported rather than averaged away.`,
      resolution: direction === "none" ? `Net weighted agreement ${agreement.toFixed(2)} did not clear the threshold, so the Commander stands aside.` : `Net weighted agreement ${agreement.toFixed(2)} favours ${direction}; the dissenting view is preserved below and the Risk Manager must still approve.`,
    });
  }
  const dissent = part.filter((r) => (direction === "long" && r.stance === "bearish") || (direction === "short" && r.stance === "bullish") || (direction === "none" && r.stance !== "neutral")).map(pos);
  const confidence = direction === "none" ? 0 : clamp(Math.abs(agreement) * (0.5 + 0.5 * coverage) * (1 - 0.1 * Math.min(3, dissent.filter((d) => d.confidence >= DISSENT_CONFIDENCE).length)), 0, 0.85);
  return { direction, agreement, coverage, confidence, reason, participating: part.map((r) => r.agent), abstaining, weights, disputes, dissent };
}

export interface FinalDecision {
  schema: "eti.decision/1"; id: string; action: "BUY" | "SELL" | "NO_TRADE"; confidence: number;
  consensus: { direction: Deliberation["direction"]; agreement: number; coverage: number; participating: AgentId[]; abstaining: Deliberation["abstaining"]; weights: Record<string, number> };
  proposal: TradeProposal | null; risk: { decision: RiskDecision["decision"]; approved: boolean; vetoes: string[]; sizing: RiskDecision["sizing"] } | null;
  vetoedBy: AgentId | null; disagreements: Dispute[]; dissent: Position[]; rationale: string[]; executionEligible: boolean; liveExecutionAllowed: false; notes: string[];
}

/** The Risk Manager's rejection is final: action becomes NO_TRADE and no later step may revive it. */
export function finalize(a: { id: string; deliberation: Deliberation; proposal: TradeProposal | null; risk: RiskDecision | null; securitySeverity: Severity }): FinalDecision {
  const d = a.deliberation, rationale: string[] = [d.reason], disputes = [...d.disputes];
  let action: FinalDecision["action"] = "NO_TRADE", vetoedBy: AgentId | null = null;
  if (d.direction !== "none") {
    const candidate = d.direction === "long" ? "BUY" : "SELL";
    if (!a.proposal || !a.risk) rationale.push(`Consensus favoured ${candidate} but no valid proposal could be built (ATR unavailable); standing aside.`);
    else if (!a.risk.approved) {
      vetoedBy = "risk"; rationale.push(`Risk Manager VETO of ${candidate}: ${a.risk.vetoes.join(", ")}. The veto is binding.`);
      disputes.push({ topic: "risk_veto", between: ["commander", "risk"], positions: [{ agent: "commander", stance: d.direction === "long" ? "bullish" : "bearish", confidence: d.confidence, reason: `Consensus favoured ${candidate} (agreement ${d.agreement.toFixed(2)}).` }, { agent: "risk", stance: "neutral", confidence: 1, reason: a.risk.checks.filter((c) => !c.passed && c.severity === "veto").map((c) => c.detail).join(" ") }], explanation: "The analysts' directional consensus conflicts with the independent risk review.", resolution: "Risk veto prevails; no trade." });
    } else { action = candidate; rationale.push(`Risk Manager ${a.risk.decision.toUpperCase()}${a.risk.warnings.length ? " (" + a.risk.warnings.join("; ") + ")" : ""}.`); }
  }
  if (d.abstaining.length) rationale.push("Abstaining (no data, not counted as neutral): " + d.abstaining.map((x) => x.agent).join(", ") + ".");
  if (a.securitySeverity !== "none") rationale.push("Fraud & Security Analyst severity: " + a.securitySeverity + ".");
  const notes = ["Confidence is a heuristic consensus score, not a probability of profit.", "Spot markets cannot be shorted: SELL means exit/avoid longs and is only executable against an existing position.", "Live execution is not available through the agent system."];
  return {
    schema: "eti.decision/1", id: a.id, action, confidence: action === "NO_TRADE" ? 0 : d.confidence,
    consensus: { direction: d.direction, agreement: d.agreement, coverage: d.coverage, participating: d.participating, abstaining: d.abstaining, weights: d.weights },
    proposal: a.proposal, risk: a.risk ? { decision: a.risk.decision, approved: a.risk.approved, vetoes: a.risk.vetoes, sizing: a.risk.sizing } : null,
    vetoedBy, disagreements: disputes, dissent: d.dissent, rationale, executionEligible: action !== "NO_TRADE" && a.risk?.approved === true, liveExecutionAllowed: false, notes,
  };
}

export function commanderReport(f: FinalDecision, now: number): AgentReport {
  const stance: Stance = f.action === "BUY" ? "bullish" : f.action === "SELL" ? "bearish" : "neutral";
  return makeReport("commander", { stance, confidence: f.confidence, summary: `${f.action}${f.vetoedBy ? " (vetoed by " + f.vetoedBy + ")" : ""}: ${f.rationale[0]}`, evidence: [{ label: "agreement", value: f.consensus.agreement }, { label: "coverage", value: f.consensus.coverage }, { label: "disagreements", value: f.disagreements.length }, { label: "participating", value: f.consensus.participating.join(",") }], warnings: f.notes }, now);
}
