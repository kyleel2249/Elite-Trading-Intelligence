/**
 * Control agents: 9 Risk Manager (binding veto), 10 Execution Specialist, 11 Performance Auditor,
 * 12 Fraud & Security Analyst.
 */
import { INTERVAL_SECONDS } from "../market.ts";
import { makeReport } from "./types.ts";
import type { AccountState, AgentId, AgentReport, Ctx, Evidence, Integrity, Kline, MarketInput, Stance, TradeProposal } from "./types.ts";
import { atrSeries, bookStats, clamp, finite, isNum, lastFinite, logReturns, mean, stdev, wilson } from "./math.ts";
import type { EventHazard } from "./analysts.ts";

// ------------------------------------------------------ 12. FRAUD & SECURITY
export type Severity = "none" | "low" | "medium" | "high" | "critical";
export const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
export interface SecurityFlag { id: string; severity: Severity; detail: string }
export interface SecurityReport extends AgentReport { severity: Severity; flags: SecurityFlag[] }

export function securityAnalyst(ctx: Ctx): SecurityReport {
  const { candles: cs, depth, interval, crossCheck } = ctx.market, flags: SecurityFlag[] = [];
  const flag = (id: string, severity: Severity, detail: string) => flags.push({ id, severity, detail });
  const ivMs = (INTERVAL_SECONDS[interval] ?? 3600) * 1000;
  if (cs.length >= 60) {
    const L = cs.length - 2; // last CLOSED candle: the final candle may be partial
    const vols = cs.slice(L - 50, L).map((k) => k[5]), sd = stdev(vols), z = sd > 0 ? (cs[L][5] - mean(vols)) / sd : 0;
    if (z > 5) flag("volume_spike", "medium", `Last closed candle volume is ${z.toFixed(1)}σ above its 50-bar mean (possible wash trading, pump or news shock).`);
    const a = lastFinite(atrSeries(cs.slice(0, L), 14));
    if (a > 0 && (cs[L][2] - cs[L][3]) / a > 6) flag("extreme_range", "medium", `Candle range is ${((cs[L][2] - cs[L][3]) / a).toFixed(1)}× ATR (possible manipulation wick or flash move).`);
    const r = logReturns(cs.slice(-80).map((k) => k[4])), prior = r.slice(0, -1), sdr = stdev(prior);
    if (sdr > 0 && Math.abs(r[r.length - 1] - mean(prior)) / sdr > 6) flag("price_jump", "medium", "Latest return deviates more than 6σ from recent returns.");
  }
  if (cs.length && ctx.now - cs[cs.length - 1][0] > 3 * ivMs) flag("stale_feed", "high", "Latest candle is older than three intervals; data may be stale or the feed compromised.");
  if (depth) {
    const b = bookStats(depth);
    if (b.spreadBps > 50) flag("wide_spread", "medium", `Spread ${b.spreadBps.toFixed(1)} bps.`);
    const thin = Math.min(b.bidUsd1pct, b.askUsd1pct);
    if (thin < 10_000) flag("illiquid_book", "high", `Only $${Math.round(thin)} resting within 1% of mid on the thin side.`);
    else if (thin < 50_000) flag("thin_book", "medium", `Only $${Math.round(thin)} resting within 1% of mid on the thin side.`);
    if (Math.max(b.bidWallShare, b.askWallShare) > 0.4) flag("dominant_wall", "low", "A single order dominates one side of the book (possible spoofing/layering).");
  } else flag("book_unavailable", "low", "Order book unavailable; liquidity and spoofing checks skipped.");
  if (crossCheck && cs.length) {
    const dev = Math.abs(crossCheck.price - cs[cs.length - 1][4]) / cs[cs.length - 1][4];
    if (dev > 0.015) flag("provider_price_disagreement", "critical", `Providers disagree by ${(dev * 100).toFixed(2)}% (${ctx.market.provider} vs ${crossCheck.provider}).`);
    else if (dev > 0.005) flag("provider_price_disagreement", "high", `Providers disagree by ${(dev * 100).toFixed(2)}% (${ctx.market.provider} vs ${crossCheck.provider}).`);
  }
  const oc = ctx.supplied.onchain as Record<string, unknown> | undefined;
  if (oc && typeof oc === "object") {
    if (oc.hasMintAuthority === true) flag("mint_authority", "high", "Token contract retains mint authority (supply can be inflated).");
    if (oc.contractAudit === "unaudited") flag("unaudited_contract", "medium", "Contract reported as unaudited.");
    const lk = finite(oc.liquidityLockedPct); if (lk !== undefined && lk < 20) flag("liquidity_unlocked", "high", `Only ${lk}% of liquidity locked (rug-pull risk).`);
    const t10 = finite(oc.top10HolderPct); if (t10 !== undefined && t10 > 80) flag("extreme_concentration", "high", `Top-10 holders control ${t10}% of supply.`);
  }
  const ig = ctx.integrity;
  if (ig.liveFlagSet) flag("live_flag_ignored", "medium", "ETI_LIVE_TRADING_ENABLED is set, but this build has no live execution path: the flag is ignored and every order is paper/testnet only. Remove it from the environment.");
  if (Object.keys(ctx.market.failures).length) flag("provider_degraded", "low", "Some market-data requests failed: " + Object.entries(ctx.market.failures).map(([k, v]) => `${k}=${v}`).join(", "));
  const severity = flags.reduce<Severity>((m, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[m] ? f.severity : m), "none");
  const base = makeReport("security", {
    stance: "neutral", confidence: SEVERITY_RANK[severity] / 4,
    summary: flags.length ? `Security severity ${severity}: ${flags.map((f) => f.id).join(", ")}.` : "No manipulation, feed or configuration anomalies detected by the implemented checks.",
    evidence: flags.map((f) => ({ label: f.id, value: f.severity, note: f.detail })),
    warnings: ["Heuristic anomaly screen only; absence of flags is not proof of safety. Order-flow forensics, wallet clustering and exchange-internal data are not available."],
  }, ctx.now);
  return { ...base, severity, flags };
}

// ------------------------------------------------------------ 9. RISK MANAGER
export interface RiskParams {
  maxRiskPerTradePct: number; maxPositionPctEquity: number; dailyLossLimitPct: number; maxDrawdownPct: number; maxOpenRiskPct: number;
  maxSpreadBps: number; maxBookParticipationPct: number; minStopAtr: number; maxStopAtr: number; maxAtrPct: number; minRewardRisk: number;
}
export const DEFAULT_RISK_PARAMS: RiskParams = { maxRiskPerTradePct: 1, maxPositionPctEquity: 20, dailyLossLimitPct: 3, maxDrawdownPct: 10, maxOpenRiskPct: 6, maxSpreadBps: 25, maxBookParticipationPct: 10, minStopAtr: 0.75, maxStopAtr: 4, maxAtrPct: 8, minRewardRisk: 2 };
export interface RiskCheck { id: string; passed: boolean; severity: "info" | "warn" | "veto"; detail: string }
export interface RiskDecision {
  schema: "eti.risk.decision/1"; decision: "approve" | "reduce" | "reject"; approved: boolean; vetoes: string[]; warnings: string[]; checks: RiskCheck[];
  sizing: { quantity: number; notionalUsd: number; riskUsd: number; riskPctOfEquity: number } | null; limits: RiskParams; evaluatedAt: string;
}
export interface RiskInput {
  proposal: TradeProposal; market: MarketInput; account?: AccountState; integrity?: Integrity;
  security: { severity: Severity }; hazard: EventHazard | null; now: number; params?: Partial<RiskParams>;
}

/**
 * Independent of every analyst opinion: it sees only the proposal, raw market data, account state,
 * security severity and event hazards. A rejection here is binding for the Commander and the Execution route.
 */
export function riskManager(i: RiskInput): RiskDecision {
  const p: RiskParams = { ...DEFAULT_RISK_PARAMS, ...(i.params ?? {}) }, checks: RiskCheck[] = [];
  const add = (id: string, passed: boolean, severity: "warn" | "veto", detail: string) => checks.push({ id, passed, severity: passed ? "info" : severity, detail });
  const { proposal: pr, market: m, account: ac, integrity: ig } = i, cs = m.candles;
  const book = m.depth ? bookStats(m.depth) : null, equity = ac?.equityUsd;
  const ivMs = (INTERVAL_SECONDS[m.interval] ?? 3600) * 1000, age = cs.length ? i.now - cs[cs.length - 1][0] : Infinity;
  const atr = lastFinite(atrSeries(cs, 14)), atrPct = (atr / pr.entry) * 100;
  add("kill_switch", !ig?.killSwitch, "veto", ig?.killSwitch ? "Emergency kill switch is active." : "Kill switch inactive.");
  add("account_state", isNum(equity) && equity > 0, "veto", isNum(equity) && equity > 0 ? `Equity $${equity} supplied.` : "Account equity not supplied; position size cannot be bounded.");
  add("data_fresh", age <= 2.5 * ivMs, "veto", `Latest candle opened ${Math.round(age / 1000)}s ago (limit ${Math.round((2.5 * ivMs) / 1000)}s).`);
  add("order_book", !!book, "veto", book ? "Order book available." : "Order book unavailable; liquidity cannot be assessed.");
  if (book) {
    add("spread", book.spreadBps <= p.maxSpreadBps, "veto", `Spread ${book.spreadBps.toFixed(1)} bps (limit ${p.maxSpreadBps}).`);
    if (book.spreadBps > 10 && book.spreadBps <= p.maxSpreadBps) add("spread_wide", false, "warn", `Spread ${book.spreadBps.toFixed(1)} bps is wide.`);
    const dev = Math.abs(pr.entry - book.mid) / book.mid;
    add("entry_vs_mid", dev <= 0.01, "veto", `Entry deviates ${(dev * 100).toFixed(2)}% from book mid.`);
  }
  add("volatility", Number.isFinite(atrPct) && atrPct <= p.maxAtrPct, "veto", `ATR is ${atrPct.toFixed(2)}% of price (limit ${p.maxAtrPct}%).`);
  const dir = pr.side === "buy" ? 1 : -1, sd = Math.abs(pr.entry - pr.stop), side = dir * (pr.entry - pr.stop) > 0 && dir * (pr.targets[0] - pr.entry) > 0;
  add("stop_geometry", side && sd >= p.minStopAtr * atr && sd <= p.maxStopAtr * atr, "veto", `Stop distance ${(sd / atr).toFixed(2)}×ATR (allowed ${p.minStopAtr}–${p.maxStopAtr}×) and on the correct side.`);
  const rr = Math.abs(pr.targets[2] - pr.entry) / sd;
  add("reward_risk", rr >= p.minRewardRisk, "veto", `Final-target reward:risk ${rr.toFixed(2)} (min ${p.minRewardRisk}).`);
  if (ac?.dailyPnlPct === undefined || ac?.drawdownPct === undefined) add("pnl_state_unknown", false, "warn", "dailyPnlPct and/or drawdownPct not supplied; loss limits could not be fully checked.");
  if (ac?.dailyPnlPct !== undefined) add("daily_loss_limit", ac.dailyPnlPct > -p.dailyLossLimitPct, "veto", `Daily PnL ${ac.dailyPnlPct}% (limit -${p.dailyLossLimitPct}%).`);
  if (ac?.drawdownPct !== undefined) add("drawdown_limit", ac.drawdownPct < p.maxDrawdownPct, "veto", `Drawdown ${ac.drawdownPct}% (limit ${p.maxDrawdownPct}%).`);
  add("event_hazard", !i.hazard?.active, "veto", i.hazard?.active ? "High-impact event window: " + i.hazard.events.map((e) => e.name).join(", ") : "No high-impact event in window (only as good as the supplied calendar).");
  const sev = SEVERITY_RANK[i.security.severity];
  add("security_severity", sev < 3, "veto", `Fraud & Security severity: ${i.security.severity}.`);
  let scale = 1; const notes: string[] = [];
  if (sev === 2) { scale *= 0.5; notes.push("size halved: medium security severity"); }
  if (ac?.openRiskPct !== undefined) {
    const remaining = p.maxOpenRiskPct - ac.openRiskPct;
    add("open_risk_budget", remaining > 0, "veto", `Open risk ${ac.openRiskPct}% of ${p.maxOpenRiskPct}% budget.`);
    if (remaining > 0 && remaining < p.maxRiskPerTradePct * scale) { scale = remaining / p.maxRiskPerTradePct; notes.push("size cut to remaining open-risk budget"); }
  }
  let sizing: RiskDecision["sizing"] = null;
  const vetoSoFar = checks.some((c) => !c.passed && c.severity === "veto");
  if (!vetoSoFar && isNum(equity) && sd > 0 && book) {
    const desired = (equity * (p.maxRiskPerTradePct / 100) * scale) / sd;
    const avail = isNum(ac?.availableUsd) ? ac!.availableUsd! : Infinity;
    const capNotional = Math.min((equity * p.maxPositionPctEquity) / 100, avail) / pr.entry;
    const capBook = (((pr.side === "buy" ? book.askUsd1pct : book.bidUsd1pct) * p.maxBookParticipationPct) / 100) / pr.entry;
    let q = Math.min(desired, capNotional, capBook);
    if (q < desired * 0.999) notes.push("size capped by " + (q === capNotional ? "position/available-cash limit" : "order-book participation limit"));
    q = Math.floor(q * 1e6) / 1e6;
    add("position_size", q > 0, "veto", q > 0 ? `Sized ${q} units.` : "Computed size rounds to zero.");
    if (q > 0) sizing = { quantity: q, notionalUsd: q * pr.entry, riskUsd: q * sd, riskPctOfEquity: ((q * sd) / equity) * 100 };
  }
  const vetoes = checks.filter((c) => !c.passed && c.severity === "veto").map((c) => c.id);
  const warnings = [...checks.filter((c) => !c.passed && c.severity === "warn").map((c) => c.detail), ...notes];
  const decision = vetoes.length ? "reject" : notes.length ? "reduce" : "approve";
  return { schema: "eti.risk.decision/1", decision, approved: decision !== "reject", vetoes, warnings, checks, sizing: vetoes.length ? null : sizing, limits: p, evaluatedAt: new Date(i.now).toISOString() };
}

export function riskReport(r: RiskDecision | null, now: number): AgentReport {
  if (!r) return makeReport("risk", { status: "insufficient_data", stance: "no_data", summary: "No trade proposal was put to the Risk Manager (no directional consensus or ATR unavailable)." }, now);
  return makeReport("risk", { stance: "neutral", confidence: r.approved ? 0.9 : 1, summary: `Risk Manager ${r.decision.toUpperCase()}${r.vetoes.length ? " (veto: " + r.vetoes.join(", ") + ")" : ""}.`, evidence: r.checks.map((c) => ({ label: c.id, value: c.passed, note: c.detail })), warnings: r.warnings }, now);
}

// ------------------------------------------------------ 10. EXECUTION SPECIALIST
export interface ExecutionSource { actorType: "manual_user" | "strategy" | "system" | "automation"; actorId: string; sourceName: string; strategyId?: string | null; signalId?: string | null; triggerReason?: string | null }
export interface OrderTicket { broker: "alpaca" | "binance"; symbol: string; side: "buy" | "sell"; type: "limit"; quantity: number; limitPrice: number; timeInForce: "gtc"; clientOrderId: string; riskConfirmed: true; executionSource: ExecutionSource }
export interface ExecutionRequest { broker?: string; clientOrderId?: string; riskConfirmed?: boolean; executionSource?: ExecutionSource }
export interface ExecutionReview { schema: "eti.execution.review/1"; requested: boolean; eligible: boolean; mode: "paper_testnet_only"; blockers: string[]; warnings: string[]; ticket: OrderTicket | null }

/** Builds a limit-order ticket only when every gate passes. Never submits; the route forwards to the existing /api/orders handler (token, kill switch, in-process paper safeguards, KV audit). */
export function prepareTicket(a: {
  request?: ExecutionRequest; action: "BUY" | "SELL" | "NO_TRADE"; proposal: TradeProposal | null; risk: RiskDecision | null;
  account?: AccountState; integrity: Integrity; maxOrderQuantity?: number; decisionId: string;
}): ExecutionReview {
  const base = { schema: "eti.execution.review/1" as const, mode: "paper_testnet_only" as const };
  const q = a.request;
  if (!q?.broker) return { ...base, requested: false, eligible: false, blockers: [], warnings: ["No broker specified: no ticket prepared. Live execution is not available through this system."], ticket: null };
  const blockers: string[] = [], warnings: string[] = ["Exchange lot-size, tick-size and minimum-notional filters are not checked here; the broker may still reject the order."];
  if (a.action === "NO_TRADE" || !a.proposal) blockers.push("no_trade_decision");
  if (!a.risk?.approved || !a.risk.sizing) blockers.push("risk_not_approved");
  if (q.broker !== "alpaca" && q.broker !== "binance") blockers.push("unsupported_broker");
  if (q.broker === "alpaca" && a.proposal?.symbol.endsWith("USDT")) blockers.push("alpaca_symbol_mismatch");
  if (typeof q.clientOrderId !== "string" || !/^[A-Za-z0-9_-]{8,36}$/.test(q.clientOrderId)) blockers.push("client_order_id_required");
  if (q.riskConfirmed !== true) blockers.push("risk_confirmation_required");
  if (a.integrity.killSwitch) blockers.push("kill_switch_active");
  if (!a.integrity.executionTokenConfigured) blockers.push("execution_token_not_configured");
  if (!a.integrity.auditLogConfigured) blockers.push("audit_log_not_configured");
  let qty = a.risk?.sizing?.quantity ?? 0;
  if (a.proposal?.side === "sell") {
    const held = a.account?.positionQuantity ?? 0;
    if (!(held > 0)) blockers.push("spot_short_not_supported"); else qty = Math.min(qty, held);
  }
  if (a.maxOrderQuantity && qty > a.maxOrderQuantity) { qty = a.maxOrderQuantity; warnings.push("Quantity reduced to ETI_MAX_ORDER_QUANTITY."); }
  if (!(qty > 0)) blockers.push("zero_quantity");
  if (blockers.length || !a.proposal) return { ...base, requested: true, eligible: false, blockers, warnings, ticket: null };
  const src = q.executionSource ?? { actorType: "strategy" as const, actorId: "eti-commander", sourceName: "ETI Multi-Agent Commander", strategyId: null, signalId: a.decisionId, triggerReason: "Commander consensus approved by Risk Manager" };
  return { ...base, requested: true, eligible: true, blockers: [], warnings, ticket: { broker: q.broker as "alpaca" | "binance", symbol: a.proposal.symbol, side: a.proposal.side, type: "limit", quantity: qty, limitPrice: a.proposal.entry, timeInForce: "gtc", clientOrderId: q.clientOrderId as string, riskConfirmed: true, executionSource: src } };
}

export function executionReport(e: ExecutionReview, now: number): AgentReport {
  return makeReport("execution", { stance: "neutral", confidence: e.eligible ? 1 : 0, status: e.requested ? "ok" : "insufficient_data", summary: !e.requested ? "No execution requested; paper/testnet only, live unavailable." : e.eligible ? "Order ticket prepared (paper/testnet); not yet submitted." : "Execution blocked: " + e.blockers.join(", "), evidence: e.blockers.map((b) => ({ label: "blocker", value: b })), warnings: e.warnings, missingInputs: e.requested ? [] : ["broker"] }, now);
}

// ------------------------------------------------------- 11. PERFORMANCE AUDITOR
export interface DecisionRecord {
  schema: "eti.agent.decision/1"; id: string; at: string; symbol: string; interval: string; action: "BUY" | "SELL" | "NO_TRADE";
  confidence: number; entry: number | null; stop: number | null; targets: number[] | null; riskDecision: string | null;
  stances: Partial<Record<AgentId, Stance>>; disputes: number; vetoedBy: string | null; executed?: boolean;
}
export interface Outcome { id: string; status: "win" | "loss" | "open" | "unfilled" | "not_applicable"; rMultiple: number | null; maxFavorableR: number | null; maxAdverseR: number | null; candlesObserved: number }

/** Replays candles after the decision. Limit entry must trade through; if stop and 2R target fall in one candle, the stop is assumed first (conservative). Fees/slippage ignored. */
export function evaluateDecision(rec: DecisionRecord, candles: Kline[]): Outcome {
  const na: Outcome = { id: rec.id, status: "not_applicable", rMultiple: null, maxFavorableR: null, maxAdverseR: null, candlesObserved: 0 };
  if (rec.action === "NO_TRADE" || rec.entry === null || rec.stop === null || !rec.targets || rec.targets.length < 2) return na;
  const d = rec.action === "BUY" ? 1 : -1, R = Math.abs(rec.entry - rec.stop), t0 = Date.parse(rec.at);
  if (!(R > 0) || !Number.isFinite(t0)) return na;
  let filled = false, mfe = 0, mae = 0, seen = 0;
  for (const k of candles) {
    if (k[0] <= t0) continue; seen++;
    if (!filled) { if (k[3] <= rec.entry && rec.entry <= k[2]) filled = true; else continue; }
    const fav = d > 0 ? (k[2] - rec.entry) / R : (rec.entry - k[3]) / R, adv = d > 0 ? (rec.entry - k[3]) / R : (k[2] - rec.entry) / R;
    mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
    if (adv >= 1) return { id: rec.id, status: "loss", rMultiple: -1, maxFavorableR: mfe, maxAdverseR: mae, candlesObserved: seen };
    if (fav >= Math.abs(rec.targets[1] - rec.entry) / R) return { id: rec.id, status: "win", rMultiple: Math.abs(rec.targets[1] - rec.entry) / R, maxFavorableR: mfe, maxAdverseR: mae, candlesObserved: seen };
  }
  return filled ? { id: rec.id, status: "open", rMultiple: null, maxFavorableR: mfe, maxAdverseR: mae, candlesObserved: seen } : { id: rec.id, status: "unfilled", rMultiple: null, maxFavorableR: null, maxAdverseR: null, candlesObserved: seen };
}

export interface AuditSummary {
  schema: "eti.audit.summary/1"; generatedAt: string; decisions: number; trades: number; resolved: number; wins: number; losses: number; open: number; unfilled: number;
  winRate: number | null; winRateCi95: [number, number] | null; avgR: number | null;
  agentAccuracy: Partial<Record<AgentId, { n: number; correct: number; accuracy: number; flag: "underperforming" | "ok" | "insufficient_sample" }>>;
  notes: string[];
}
export function auditSummary(records: DecisionRecord[], outcomes: Outcome[], now = Date.now()): AuditSummary {
  const byId = new Map(outcomes.map((o) => [o.id, o])), acc: AuditSummary["agentAccuracy"] = {};
  let wins = 0, losses = 0, open = 0, unfilled = 0, rs = 0, trades = 0;
  for (const rec of records) {
    const o = byId.get(rec.id); if (!o || o.status === "not_applicable") continue; trades++;
    if (o.status === "open") open++; else if (o.status === "unfilled") unfilled++;
    else {
      if (o.status === "win") wins++; else losses++; rs += o.rMultiple ?? 0;
      const dirStance: Stance = rec.action === "BUY" ? "bullish" : "bearish";
      for (const [agent, st] of Object.entries(rec.stances) as [AgentId, Stance][]) {
        if (st !== "bullish" && st !== "bearish") continue;
        const a = (acc[agent] ??= { n: 0, correct: 0, accuracy: 0, flag: "insufficient_sample" });
        a.n++; if ((st === dirStance) === (o.status === "win")) a.correct++;
      }
    }
  }
  for (const a of Object.values(acc)) { if (!a) continue; a.accuracy = a.n ? a.correct / a.n : 0; a.flag = a.n < 20 ? "insufficient_sample" : a.accuracy < 0.4 ? "underperforming" : "ok"; }
  const resolved = wins + losses;
  return {
    schema: "eti.audit.summary/1", generatedAt: new Date(now).toISOString(), decisions: records.length, trades, resolved, wins, losses, open, unfilled,
    winRate: resolved ? wins / resolved : null, winRateCi95: resolved ? wilson(wins, resolved) : null, avgR: resolved ? rs / resolved : null, agentAccuracy: acc,
    notes: ["Outcomes replay candles with a stop-first rule and ignore fees, slippage and funding.", "Per-agent accuracy needs ≥20 resolved trades before it changes Commander weights.", "Small samples are statistically weak; read the confidence interval."],
  };
}
export function auditorReport(s: AuditSummary | null, now: number): AgentReport {
  if (!s || !s.resolved) return makeReport("auditor", { status: "insufficient_data", stance: "no_data", summary: "No resolved recorded decisions yet; there is nothing to audit. Record decisions with an authorised request.", missingInputs: ["recorded decisions in ETI_EXECUTION_LOG"] }, now);
  const flagged = Object.entries(s.agentAccuracy).filter(([, a]) => a?.flag === "underperforming").map(([k]) => k);
  const evidence: Evidence[] = [{ label: "resolved_trades", value: s.resolved }, { label: "win_rate", value: s.winRate }, { label: "avg_r", value: s.avgR }, ...Object.entries(s.agentAccuracy).map(([k, a]) => ({ label: "accuracy:" + k, value: a ? a.accuracy : null, note: a ? `n=${a.n}, ${a.flag}` : undefined }))];
  return makeReport("auditor", { stance: "neutral", confidence: clamp(s.resolved / 50, 0, 1), summary: `${s.resolved} resolved decision(s), win rate ${s.winRate === null ? "n/a" : (s.winRate * 100).toFixed(0) + "%"}${flagged.length ? "; underperforming: " + flagged.join(", ") : ""}.`, evidence, warnings: s.notes }, now);
}
