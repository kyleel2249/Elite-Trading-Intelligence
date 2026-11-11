/**
 * ETI multi-agent contracts. Every agent emits schema-validated, structured data; nothing is free text only.
 * Confidence values are heuristic scores in [0,1], NOT probabilities of profit.
 */
import type { Depth, Kline } from "../market.ts";
export type { Depth, Kline };

export const AGENT_IDS = [
  "commander", "quant", "technical", "fundamental", "macro", "crypto",
  "news", "researcher", "risk", "execution", "auditor", "security",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];
/** Agents whose stance contributes to the directional consensus. Risk/Execution/Auditor/Security never vote on direction. */
export const DIRECTIONAL_AGENTS: AgentId[] = ["quant", "technical", "fundamental", "macro", "crypto", "news", "researcher"];

export interface AgentProfile { id: AgentId; number: number; name: string; mandate: string; inputs: string[]; externalDataRequired: string | null }
export const AGENT_ROSTER: AgentProfile[] = [
  { id: "commander", number: 1, name: "ETI COMMANDER", mandate: "Coordinates all agents, explains disagreements and issues the final recommendation. Cannot override a Risk Manager veto.", inputs: ["all agent reports", "risk decision"], externalDataRequired: null },
  { id: "quant", number: 2, name: "QUANTITATIVE ANALYST", mandate: "Return statistics, drift significance, variance-ratio regime, tail behaviour, correlation/beta and empirical frequencies.", inputs: ["candles", "optional benchmark candles"], externalDataRequired: null },
  { id: "technical", number: 3, name: "TECHNICAL ANALYST", mandate: "Trend, momentum, price action, market structure, support/resistance and breakouts.", inputs: ["candles"], externalDataRequired: null },
  { id: "fundamental", number: 4, name: "FUNDAMENTAL ANALYST", mandate: "Company financials, tokenomics and intrinsic-value gap.", inputs: ["fundamentals.valuation", "fundamentals.tokenomics"], externalDataRequired: "Fundamentals/tokenomics must be supplied with the request; no fundamentals provider is configured." },
  { id: "macro", number: 5, name: "MACRO INTELLIGENCE", mandate: "Rates, monetary policy, dollar, liquidity, volatility regime and geopolitical risk.", inputs: ["macro indicators"], externalDataRequired: "Macro indicators must be supplied with the request; no macro data provider is configured." },
  { id: "crypto", number: 6, name: "CRYPTO INTELLIGENCE", mandate: "Order-book liquidity, on-chain flows, tokenomics risk and contract/project security indicators.", inputs: ["order book", "optional on-chain data"], externalDataRequired: "On-chain metrics must be supplied with the request; order-book analysis works without them." },
  { id: "news", number: 7, name: "NEWS INTELLIGENCE", mandate: "News sentiment, economic-calendar hazards and event monitoring.", inputs: ["news items", "calendar events"], externalDataRequired: "News items and calendar events must be supplied with the request; no live news feed is configured." },
  { id: "researcher", number: 8, name: "ELITE TRADER RESEARCHER", mandate: "Compares simplified, mechanical readings of publicly documented trading methodologies against current price data.", inputs: ["candles"], externalDataRequired: null },
  { id: "risk", number: 9, name: "RISK MANAGER", mandate: "Independently approves, reduces or rejects proposed trades. Its rejection is binding.", inputs: ["trade proposal", "market data", "account state", "security severity", "event hazards"], externalDataRequired: "Account state (equity etc.) must be supplied; without it every trade is rejected." },
  { id: "execution", number: 10, name: "EXECUTION SPECIALIST", mandate: "Builds order tickets for authorised paper/testnet brokers. Never bypasses the risk veto or the server-side risk gate.", inputs: ["approved proposal", "broker", "clientOrderId"], externalDataRequired: "Broker credentials, execution token, risk gate and KV audit log (Worker secrets/bindings)." },
  { id: "auditor", number: 11, name: "PERFORMANCE AUDITOR", mandate: "Scores stored decisions against subsequent price action and down-weights agents with poor measured accuracy.", inputs: ["stored decisions", "subsequent candles"], externalDataRequired: "Needs the ETI_EXECUTION_LOG KV binding and recorded decisions." },
  { id: "security", number: 12, name: "FRAUD AND SECURITY ANALYST", mandate: "Flags manipulation signatures, illiquidity, feed disagreement, scam indicators and unsafe integration configuration.", inputs: ["candles", "order book", "cross-provider price", "integration configuration"], externalDataRequired: null },
];

export type Stance = "bullish" | "bearish" | "neutral" | "no_data";
export type ReportStatus = "ok" | "insufficient_data" | "error";
export interface Evidence { label: string; value: number | string | boolean | null; note?: string }
export const REPORT_SCHEMA = "eti.agent.report/1" as const;
export interface AgentReport {
  schema: typeof REPORT_SCHEMA; agent: AgentId; status: ReportStatus; stance: Stance;
  /** Heuristic strength of the agent's own view, 0..1. Not a probability. */
  confidence: number; summary: string; evidence: Evidence[]; warnings: string[]; missingInputs: string[]; generatedAt: string;
}
export interface ReportInit { status?: ReportStatus; stance?: Stance; confidence?: number; summary: string; evidence?: Evidence[]; warnings?: string[]; missingInputs?: string[] }

const c01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const sig = (x: number) => Number(x.toPrecision(7));
export function makeReport(agent: AgentId, r: ReportInit, now = Date.now()): AgentReport {
  return {
    schema: REPORT_SCHEMA, agent, status: r.status ?? "ok", stance: r.stance ?? "neutral",
    confidence: Math.round(c01(r.confidence ?? 0) * 1000) / 1000,
    summary: r.summary.slice(0, 600),
    evidence: (r.evidence ?? []).slice(0, 40).map((e) => ({
      label: e.label,
      value: typeof e.value === "number" ? (Number.isFinite(e.value) ? sig(e.value) : null) : e.value,
      ...(e.note ? { note: e.note.slice(0, 300) } : {}),
    })),
    warnings: (r.warnings ?? []).slice(0, 20).map((w) => w.slice(0, 300)),
    missingInputs: (r.missingInputs ?? []).slice(0, 20),
    generatedAt: new Date(now).toISOString(),
  };
}
export const noData = (agent: AgentId, summary: string, missing: string[], now = Date.now()) =>
  makeReport(agent, { status: "insufficient_data", stance: "no_data", confidence: 0, summary, missingInputs: missing }, now);
export const errorReport = (agent: AgentId, err: string, now = Date.now()) =>
  makeReport(agent, { status: "error", stance: "no_data", confidence: 0, summary: "Agent failed: " + err, warnings: [err] }, now);

/** Returns a list of schema violations (empty = valid). The Commander only consumes reports that validate. */
export function validateReport(x: unknown): string[] {
  if (!x || typeof x !== "object") return ["not_object"];
  const r = x as Record<string, unknown>; const e: string[] = [];
  if (r.schema !== REPORT_SCHEMA) e.push("schema");
  if (!AGENT_IDS.includes(r.agent as AgentId)) e.push("agent");
  if (!["ok", "insufficient_data", "error"].includes(r.status as string)) e.push("status");
  if (!["bullish", "bearish", "neutral", "no_data"].includes(r.stance as string)) e.push("stance");
  if (typeof r.confidence !== "number" || !(r.confidence >= 0 && r.confidence <= 1)) e.push("confidence");
  if (typeof r.summary !== "string" || !r.summary) e.push("summary");
  for (const k of ["evidence", "warnings", "missingInputs"]) if (!Array.isArray(r[k])) e.push(k);
  if (typeof r.generatedAt !== "string" || Number.isNaN(Date.parse(r.generatedAt))) e.push("generatedAt");
  return e;
}

export type MessageType = "report" | "proposal" | "risk_decision" | "security_alert" | "dispute" | "execution_review" | "final_decision";
export interface AgentMessage { schema: "eti.agent.message/1"; seq: number; at: string; from: AgentId; to: AgentId | "all"; type: MessageType; payload: unknown }
export class MessageBus {
  messages: AgentMessage[] = [];
  seq = 0;
  send(from: AgentId, to: AgentId | "all", type: MessageType, payload: unknown, now = Date.now()): AgentMessage {
    const m: AgentMessage = { schema: "eti.agent.message/1", seq: ++this.seq, at: new Date(now).toISOString(), from, to, type, payload };
    this.messages.push(m);
    return m;
  }
}

export interface MarketInput {
  symbol: string; interval: string; candles: Kline[]; depth: Depth | null; provider: string; fetchedAt: number;
  crossCheck: { provider: string; price: number } | null;
  benchmark: { symbol: string; candles: Kline[] } | null;
  failures: Record<string, string>;
}
/** Caller-supplied research data. The agents never invent any of it; absent data yields insufficient_data. */
export interface SuppliedData { fundamentals?: unknown; macro?: unknown; news?: unknown; onchain?: unknown }
export interface AccountState { equityUsd?: number; availableUsd?: number; positionQuantity?: number; dailyPnlPct?: number; drawdownPct?: number; openRiskPct?: number }
export interface Integrity { killSwitch: boolean; liveFlagSet: boolean; executionTokenConfigured: boolean; auditLogConfigured: boolean }
export interface Ctx { market: MarketInput; supplied: SuppliedData; now: number; integrity: Integrity }

export interface TradeProposal {
  symbol: string; side: "buy" | "sell"; entry: number; stop: number; targets: [number, number, number];
  atr: number; stopDistance: number; basis: string;
}
