/** Runs all twelve agents over one market snapshot and records every structured exchange on a message bus. */
import { AGENT_IDS, MessageBus, errorReport, validateReport } from "./types.ts";
import type { AccountState, AgentId, AgentMessage, AgentReport, Integrity, MarketInput, SuppliedData } from "./types.ts";
import { cryptoIntelligence, buildProposal, eliteTraderResearcher, eventHazard, macroIntelligence, newsIntelligence, quantitativeAnalyst, technicalAnalyst } from "./analysts.ts";
import { fundamentalAnalyst } from "./fundamental.ts";
import { auditorReport, executionReport, prepareTicket, riskManager, riskReport, securityAnalyst } from "./controls.ts";
import type { AuditSummary, DecisionRecord, ExecutionRequest, ExecutionReview, RiskDecision, SecurityReport } from "./controls.ts";
import { commanderReport, deliberate, finalize } from "./commander.ts";
import type { Deliberation, FinalDecision } from "./commander.ts";

export interface AnalyzeInput {
  market: MarketInput; supplied?: SuppliedData; account?: AccountState; integrity: Integrity; audit?: AuditSummary | null;
  execution?: ExecutionRequest; maxOrderQuantity?: number; now?: number; id?: string;
}
export interface AnalysisResult {
  schema: "eti.analysis/1"; id: string; symbol: string; interval: string; generatedAt: string;
  decision: FinalDecision; deliberation: Deliberation; reports: AgentReport[]; risk: RiskDecision | null; security: SecurityReport; execution: ExecutionReview;
  messages: AgentMessage[]; dataQuality: Record<string, unknown>; disclosures: string[];
}

export function analyze(input: AnalyzeInput): AnalysisResult {
  const now = input.now ?? Date.now(), id = input.id ?? crypto.randomUUID(), bus = new MessageBus();
  const ctx = { market: input.market, supplied: input.supplied ?? {}, now, integrity: input.integrity };
  const safe = (agent: AgentId, fn: () => AgentReport): AgentReport => {
    let r: AgentReport;
    try { r = fn(); } catch (e) { return errorReport(agent, e instanceof Error ? e.message : "unknown", now); }
    const errs = validateReport(r);
    return errs.length ? errorReport(agent, "invalid report: " + errs.join(","), now) : r;
  };
  const reports = new Map<AgentId, AgentReport>();
  const run = (agent: AgentId, fn: () => AgentReport) => { const r = safe(agent, fn); reports.set(agent, r); bus.send(agent, "commander", "report", r, now); return r; };
  run("quant", () => quantitativeAnalyst(ctx)); run("technical", () => technicalAnalyst(ctx)); run("fundamental", () => fundamentalAnalyst(ctx));
  run("macro", () => macroIntelligence(ctx)); run("crypto", () => cryptoIntelligence(ctx)); run("news", () => newsIntelligence(ctx)); run("researcher", () => eliteTraderResearcher(ctx));
  let security: SecurityReport;
  try { security = securityAnalyst(ctx); } catch (e) { security = { ...errorReport("security", e instanceof Error ? e.message : "unknown", now), severity: "high", flags: [{ id: "security_agent_failed", severity: "high", detail: "Security analysis failed; failing closed." }] }; }
  reports.set("security", security); bus.send("security", "all", "security_alert", { severity: security.severity, flags: security.flags }, now);
  const audit = input.audit ?? null, aud = auditorReport(audit, now); reports.set("auditor", aud); bus.send("auditor", "commander", "report", aud, now);

  const delib = deliberate([...reports.values()], audit);
  for (const d of delib.disputes) bus.send("commander", "all", "dispute", d, now);
  let proposal = null as ReturnType<typeof buildProposal>, risk: RiskDecision | null = null;
  if (delib.direction !== "none") {
    proposal = buildProposal(input.market.symbol, delib.direction === "long" ? "buy" : "sell", input.market.candles);
    if (proposal) {
      bus.send("commander", "risk", "proposal", proposal, now);
      risk = riskManager({ proposal, market: input.market, account: input.account, integrity: input.integrity, security: { severity: security.severity }, hazard: eventHazard(ctx.supplied.news, now), now });
      bus.send("risk", "commander", "risk_decision", risk, now);
    }
  }
  const decision = finalize({ id, deliberation: delib, proposal, risk, securitySeverity: security.severity });
  for (const d of decision.disagreements) if (d.topic === "risk_veto") bus.send("commander", "all", "dispute", d, now);
  const execution = prepareTicket({ request: input.execution, action: decision.action, proposal: decision.action === "NO_TRADE" ? null : proposal, risk: decision.action === "NO_TRADE" ? null : risk, account: input.account, integrity: input.integrity, maxOrderQuantity: input.maxOrderQuantity, decisionId: id });
  bus.send("execution", "commander", "execution_review", execution, now);
  bus.send("commander", "all", "final_decision", decision, now);
  reports.set("risk", riskReport(risk, now)); reports.set("execution", executionReport(execution, now)); reports.set("commander", commanderReport(decision, now));

  const m = input.market;
  return {
    schema: "eti.analysis/1", id, symbol: m.symbol, interval: m.interval, generatedAt: new Date(now).toISOString(), decision, deliberation: delib,
    reports: AGENT_IDS.map((a) => reports.get(a)!), risk, security, execution, messages: bus.messages,
    dataQuality: { provider: m.provider, candles: m.candles.length, lastCandleOpen: m.candles.length ? new Date(m.candles[m.candles.length - 1][0]).toISOString() : null, orderBook: m.depth ? "rest_snapshot" : "unavailable", priceCrossCheck: m.crossCheck ? m.crossCheck.provider : "not_performed", failures: m.failures },
    disclosures: ["Agents are deterministic statistical/rule-based modules, not language models.", "Fundamental, macro, news and on-chain agents analyse only provider data or data supplied with the request; absent data is reported as insufficient, never invented.", "Outputs are analytical and are not financial advice. No outcome, return or win rate is guaranteed."],
  };
}

export function toDecisionRecord(r: AnalysisResult, executed = false): DecisionRecord {
  const stances: DecisionRecord["stances"] = {};
  for (const rep of r.reports) if (rep.status === "ok" && (rep.stance === "bullish" || rep.stance === "bearish") && rep.agent !== "commander") stances[rep.agent] = rep.stance;
  const p = r.decision.action === "NO_TRADE" ? null : r.decision.proposal;
  return { schema: "eti.agent.decision/1", id: r.id, at: r.generatedAt, symbol: r.symbol, interval: r.interval, action: r.decision.action, confidence: r.decision.confidence, entry: p?.entry ?? null, stop: p?.stop ?? null, targets: p?.targets ?? null, riskDecision: r.risk?.decision ?? null, stances, disputes: r.decision.disagreements.length, vetoedBy: r.decision.vetoedBy, executed };
}
