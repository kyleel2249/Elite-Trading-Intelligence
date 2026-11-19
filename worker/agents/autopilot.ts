/**
 * Scheduled ETI multi-agent autopilot.
 *
 * This controller is deliberately limited to ETI INTERNAL PAPER. It never calls
 * /api/orders/live and never routes to Bitget, Alpaca or Binance. The same
 * Commander, Risk Manager, Execution Specialist and order-gateway safeguards
 * used by the interactive agent route remain in the path.
 */
import { ensureInit } from "../portfolio/engine.ts";
import { openStore } from "../portfolio/store.ts";
import type { ExecutionEnv } from "../execution.ts";

export interface AgentAutopilotEnv extends ExecutionEnv {
  ETI_PORTFOLIO_DB?: any;
  ETI_AGENT_AUTOPILOT_ENABLED?: string;
  ETI_AGENT_AUTOPILOT_SYMBOLS?: string;
  ETI_AGENT_AUTOPILOT_INTERVAL?: string;
  ETI_AGENT_AUTOPILOT_MAX_PER_CYCLE?: string;
  ETI_AGENT_AUTOPILOT_MIN_CONFIDENCE?: string;
  ETI_AGENT_AUTOPILOT_MIN_AGREEMENT?: string;
  ETI_AGENT_AUTOPILOT_MAX_POSITIONS?: string;
  ETI_AGENT_AUTOPILOT_STRATEGIES?: string;
  ETI_AGENT_AUTOPILOT_MIN_STRATEGY_AGREEMENT?: string;
  ETI_AGENT_AUTOPILOT_MIN_OMNI_CONFIDENCE?: string;
  ETI_AGENT_AUTOPILOT_CONFIG?: string;
}
type App = { fetch(request: Request, env: any): Promise<Response> | Response };
export const AGENT_AUTOPILOT_CRON = "*/5 * * * *";
const ALLOWED_INTERVALS = new Set(["5m", "15m", "30m", "1h", "4h", "1d"]);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const json = (x: unknown) => JSON.stringify(x);
const envNum = (v: string | undefined, fallback: number, lo: number, hi: number) => clamp(num(v, fallback), lo, hi);

export interface AutopilotConfig {
  symbols: string; interval: string; maxPerCycle: number; minConfidence: number; minAgreement: number;
  maxPositions: number; strategies: string; minStrategyAgreement: number; minOmniConfidence: number;
}
export function readAutopilotConfig(env: AgentAutopilotEnv): AutopilotConfig {
  let raw: any = {};
  try { raw = JSON.parse(env.ETI_AGENT_AUTOPILOT_CONFIG || "{}"); } catch { raw = {}; }
  const value = (legacy: string | undefined, key: keyof AutopilotConfig, fallback: unknown) => legacy !== undefined ? legacy : raw[key] ?? fallback;
  return {
    symbols: String(value(env.ETI_AGENT_AUTOPILOT_SYMBOLS, "symbols", "BTCUSDT,ETHUSDT,SOLUSDT")),
    interval: String(value(env.ETI_AGENT_AUTOPILOT_INTERVAL, "interval", "15m")),
    maxPerCycle: envNum(String(value(env.ETI_AGENT_AUTOPILOT_MAX_PER_CYCLE, "maxPerCycle", 2)), 2, 1, 10),
    minConfidence: envNum(String(value(env.ETI_AGENT_AUTOPILOT_MIN_CONFIDENCE, "minConfidence", 0.65)), 0.65, 0.5, 0.95),
    minAgreement: envNum(String(value(env.ETI_AGENT_AUTOPILOT_MIN_AGREEMENT, "minAgreement", 0.65)), 0.65, 0.5, 0.95),
    maxPositions: envNum(String(value(env.ETI_AGENT_AUTOPILOT_MAX_POSITIONS, "maxPositions", 3)), 3, 1, 10),
    strategies: String(value(env.ETI_AGENT_AUTOPILOT_STRATEGIES, "strategies", "scalp,intraday,swing,position")),
    minStrategyAgreement: envNum(String(value(env.ETI_AGENT_AUTOPILOT_MIN_STRATEGY_AGREEMENT, "minStrategyAgreement", 3)), 3, 1, 4),
    minOmniConfidence: envNum(String(value(env.ETI_AGENT_AUTOPILOT_MIN_OMNI_CONFIDENCE, "minOmniConfidence", 60)), 60, 40, 95),
  };
}

function accountFromLedger(ledger: any, symbol: string, now: number) {
  const cash = Number(ledger.cash), start = Number(ledger.startingBalance);
  if (!Number.isFinite(cash) || !Number.isFinite(start) || start <= 0) return null;
  const positions = Object.values(ledger.positions ?? {}) as any[];
  const equity = cash + positions.reduce((s, p) => s + Number(p.qty || 0) * Number(ledger.marks?.[p.symbol] || p.avgEntry || 0), 0);
  if (!(equity > 0) || !Number.isFinite(equity)) return null;
  const today = new Date(now); const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const points = (ledger.curve ?? []).filter((p: any) => Number(p.t) >= midnight && Number(p.equity) > 0);
  const dayStart = points.length ? Number(points[0].equity) : start;
  const peak = Math.max(start, ...(ledger.curve ?? []).map((p: any) => Number(p.equity) || 0));
  let openRiskUsd = 0, unknownStop = false;
  for (const p of positions) {
    const stop = Number(p.levels?.stop);
    if (!(stop > 0) || !(p.avgEntry > stop)) unknownStop = true;
    else openRiskUsd += Math.max(0, (p.avgEntry - stop) * p.qty);
  }
  return {
    equityUsd: equity, availableUsd: Math.max(0, cash),
    positionQuantity: Number(ledger.positions?.[symbol]?.qty || 0),
    dailyPnlPct: ((equity - dayStart) / dayStart) * 100,
    drawdownPct: ((peak - equity) / peak) * 100,
    openRiskPct: (openRiskUsd / equity) * 100,
    unknownOpenRisk: unknownStop,
    openPositions: positions.length,
  };
}

/** Persist early scheduler/preflight outcomes so the dashboard never keeps showing an old successful cycle. */
async function skippedResult(env: AgentAutopilotEnv, disabled: { enabled: boolean; mode: string; liveOrdersAllowed: boolean }, reason: string, now: number) {
  const summary = { ...disabled, at: new Date(now).toISOString(), submitted: 0, evaluated: 0, outcomes: [], skipped: reason };
  if (env.ETI_EXECUTION_LOG) await env.ETI_EXECUTION_LOG.put("agent-autopilot:last", json(summary), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => undefined);
  return summary;
}

/** Schedule the paper-only agent cycle independently of other handlers sharing the same cron expression. */
export function scheduleAgentAutopilot(cron: string | undefined, env: AgentAutopilotEnv, app: App, ctx: { waitUntil(promise: Promise<unknown>): void }): boolean {
  if (cron !== AGENT_AUTOPILOT_CRON) return false;
  ctx.waitUntil((async () => {
    const startedAt = new Date().toISOString();
    const writeHeartbeat = async (value: Record<string, unknown>) => {
      if (env.ETI_EXECUTION_LOG) await env.ETI_EXECUTION_LOG.put("agent-autopilot:heartbeat", json(value), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => undefined);
    };
    // Persist dispatch before doing expensive analysis. This separates a missing Cron Trigger
    // from a slow or failed cycle, even when the final cycle summary has not been written yet.
    await writeHeartbeat({ status: "started", cron, at: startedAt, enabled: env.ETI_AGENT_AUTOPILOT_ENABLED === "true", mode: "internal_paper_only", liveOrdersAllowed: false });
    try {
      const result = await runAgentAutopilotCycle(env, app);
      const completedAt = new Date().toISOString();
      await writeHeartbeat({
        status: "completed", cron, at: startedAt, completedAt,
        enabled: (result as any).enabled === true, mode: "internal_paper_only", liveOrdersAllowed: false,
        submitted: Number((result as any).submitted || 0), evaluated: Number((result as any).evaluated || 0),
        skipped: (result as any).skipped || null,
      });
      if ((result as any).submitted) console.log("agent autopilot paper orders", (result as any).submitted, "evaluated", (result as any).evaluated);
      else console.log("agent autopilot cycle completed without orders", (result as any).skipped || (result as any).evaluated || 0);
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown_error";
      const completedAt = new Date().toISOString();
      const failure = { enabled: env.ETI_AGENT_AUTOPILOT_ENABLED === "true", mode: "internal_paper_only", liveOrdersAllowed: false, at: startedAt, completedAt, submitted: 0, evaluated: 0, outcomes: [], skipped: "cycle_error", error: message };
      await writeHeartbeat({ status: "failed", cron, at: startedAt, completedAt, enabled: failure.enabled, mode: failure.mode, liveOrdersAllowed: false, error: message });
      if (env.ETI_EXECUTION_LOG) await env.ETI_EXECUTION_LOG.put("agent-autopilot:last", json(failure), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => undefined);
      console.error("agent autopilot cycle failed", failure.error);
    }
  })());
  return true;
}

/** Runs one bounded batch. A run is a no-op unless explicitly enabled in Worker configuration. */
export async function runAgentAutopilotCycle(env: AgentAutopilotEnv, app: App, now = Date.now()) {
  const disabled = { enabled: env.ETI_AGENT_AUTOPILOT_ENABLED === "true", mode: "internal_paper_only", liveOrdersAllowed: false };
  if (!disabled.enabled) return skippedResult(env, disabled, "autopilot_disabled", now);
  if (env.ETI_KILL_SWITCH === "true") return skippedResult(env, disabled, "kill_switch_active", now);
  if (!env.ETI_EXECUTION_TOKEN || !env.ETI_EXECUTION_LOG) return skippedResult(env, disabled, "execution_token_or_audit_log_missing", now);
  if (!env.ETI_PORTFOLIO_DB && !env.ETI_EXECUTION_LOG) return skippedResult(env, disabled, "portfolio_storage_missing", now);

  const config = readAutopilotConfig(env);
  const symbols = [...new Set(config.symbols.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{5,20}$/.test(s)))].slice(0, 30);
  const interval = config.interval;
  if (!ALLOWED_INTERVALS.has(interval)) return skippedResult(env, disabled, "invalid_interval", now);
  const maxPerCycle = Math.floor(config.maxPerCycle);
  const minConfidence = config.minConfidence, minAgreement = config.minAgreement;
  const maxPositions = Math.floor(config.maxPositions);
  const strategies = [...new Set(config.strategies.split(",").map(s => s.trim().toLowerCase()).filter(s => ["scalp", "intraday", "swing", "position"].includes(s)))];
  const minStrategyAgreement = Math.floor(config.minStrategyAgreement);
  const minOmniConfidence = config.minOmniConfidence;
  if (!symbols.length) return skippedResult(env, disabled, "no_valid_symbols", now);
  if (!strategies.length || minStrategyAgreement > strategies.length) return skippedResult(env, disabled, "invalid_strategy_configuration", now);

  const store = openStore(env as any, "internal_paper");
  if (!store) return { ...disabled, skipped: "portfolio_storage_missing" };
  await ensureInit(env as any, now);
  const { ledger } = await store.ledgerFast(now);
  const accountBySymbol = (symbol: string) => accountFromLedger(ledger, symbol, now);
  const activePositions = Object.values(ledger.positions ?? {}).filter((p: any) => Number(p.qty) > 0);
  const activeOrders = Object.values(ledger.orders ?? {}).filter((o: any) => ["pending", "open", "partially_filled"].includes(o.status));
  const pendingEntryCount = activeOrders.filter((o: any) => o.side === "buy").length;
  const slot = Math.floor(now / 300_000);
  const outcomes: any[] = [];
  let submitted = 0;
  const startIndex = (slot * maxPerCycle) % symbols.length;
  const scheduledSymbols = symbols.map((_, i) => symbols[(startIndex + i) % symbols.length]).slice(0, maxPerCycle);
  for (const symbol of scheduledSymbols) {
    const claim = "agent-autopilot:slot:" + symbol + ":" + interval + ":" + slot;
    if (await env.ETI_EXECUTION_LOG.get(claim)) { outcomes.push({ symbol, status: "skipped", reason: "already_processed_this_slot" }); continue; }
    // Claim before analysis; a duplicate cron delivery must not submit a second order.
    await env.ETI_EXECUTION_LOG.put(claim, "running", { expirationTtl: 60 * 60 * 24 * 3 });
    try {
      const account = accountBySymbol(symbol);
      const clientOrderId = ("eti-" + symbol + "-" + slot).slice(0, 36);
      const body: Record<string, unknown> = { symbol, interval };
      if (account) body.account = {
        equityUsd: account.equityUsd, availableUsd: account.availableUsd,
        positionQuantity: account.positionQuantity, dailyPnlPct: account.dailyPnlPct,
        drawdownPct: account.drawdownPct, openRiskPct: account.openRiskPct,
      };
      const headers = { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN, "content-type": "application/json" };
      const expectedAction = account && account.positionQuantity > 0 ? "SELL" : "BUY";
      const accountPayload = body.account as Record<string, number> | undefined;
      if (accountPayload && expectedAction === "SELL" && account) accountPayload.availableUsd = account.equityUsd;
      // Run the complete twelve-agent council first for every scheduled symbol.
      // Authenticated opt-in recording keeps every automatic decision (including NO_TRADE)
      // in the durable D1 archive before any strategy gate can short-circuit the cycle.
      const preflightBody = { ...body, record: true };
      const preflight = await app.fetch(new Request("https://eti.internal/api/agents/analyze", { method: "POST", headers, body: json(preflightBody) }), env);
      const analysis: any = await preflight.json().catch(() => ({}));
      // Liquidity-FVG is an additional fail-closed strategy gate. It cannot replace the council,
      // strategy consensus, risk checks, kill switch, or the internal-paper execution route.
      let liquidityFvg: any = null, liquidityFvgHttpStatus = 0;
      try {
        const lfUrl = "https://eti.internal/api/analysis/liquidity-fvg?symbol=" + encodeURIComponent(symbol) + "&timeframe=" + encodeURIComponent(interval);
        const lfResponse = await app.fetch(new Request(lfUrl), env);
        liquidityFvgHttpStatus = lfResponse.status;
        liquidityFvg = await lfResponse.json().catch(() => null);
      } catch { liquidityFvg = null; }
      const liquidityFvgApproved = liquidityFvgHttpStatus >= 200 && liquidityFvgHttpStatus < 300
        && liquidityFvg?.autopilotEligible === true && liquidityFvg?.direction === expectedAction
        && liquidityFvg?.safety?.submitsOrder === false && liquidityFvg?.safety?.bypassesRiskManager === false;
      const decision = analysis.decision, confidence = Number(decision?.confidence || 0), agreement = Number(decision?.consensus?.agreement || 0);
      const councilApproved = preflight.ok && decision?.action === expectedAction
        && confidence >= minConfidence && agreement >= minAgreement
        && analysis.risk?.approved === true && !["high", "critical"].includes(analysis.security?.severity);

      // Cross-check all four ETI strategy profiles after the council has run. These are
      // independent gates: a strategy consensus cannot override a council or Risk veto.
      const strategyResults: any[] = [];
      for (const strategy of strategies) {
        try {
          const u = "https://eti.internal/api/omnisignal?symbol=" + encodeURIComponent(symbol) + "&strategy=" + encodeURIComponent(strategy) + "&engines=swift,gainz&venue=bybit&market=spot";
          const response = await app.fetch(new Request(u), env);
          const result: any = await response.json().catch(() => ({}));
          strategyResults.push({ strategy, httpStatus: response.status, decision: result.decision || "DATA_UNRELIABLE", tradeable: result.tradeable === true, confidence: Number(result.confidence || 0), hardFailures: result.validation?.hardFailures || [], error: result.error || null });
        } catch (e) {
          strategyResults.push({ strategy, httpStatus: 0, decision: "DATA_UNRELIABLE", tradeable: false, confidence: 0, hardFailures: ["provider_request_failed"], error: e instanceof Error ? e.message : "unknown_error" });
        }
      }
      const alignedStrategies = strategyResults.filter(x => x.httpStatus >= 200 && x.httpStatus < 300 && x.tradeable && x.decision === expectedAction && x.confidence >= minOmniConfidence && x.hardFailures.length === 0);
      const councilSummary = {
        action: decision?.action || "NO_TRADE", confidence, agreement,
        riskApproved: analysis.risk?.approved === true, security: analysis.security?.severity || "unknown",
        auditPersistence: analysis.auditPersistence || "unknown",
        liquidityFvg: { eligible: liquidityFvgApproved, direction: liquidityFvg?.direction || "WAIT", score: Number(liquidityFvg?.score || 0), manipulationRisk: liquidityFvg?.manipulation?.level || "unavailable", blocks: liquidityFvg?.blocks || ["Liquidity-FVG analysis unavailable"], httpStatus: liquidityFvgHttpStatus },
      };
      if (!councilApproved) {
        outcomes.push({
          symbol, status: "no_trade", action: councilSummary.action,
          reason: !preflight.ok ? "agent_analysis_unavailable" : decision?.vetoedBy || "agent_council_or_risk_gate_not_met",
          ...(!preflight.ok ? { analysisFailure: {
            httpStatus: preflight.status,
            error: typeof analysis.error === "string" ? analysis.error : "analysis_request_failed",
            detail: analysis.detail ?? analysis.message ?? null,
            dataQuality: analysis.dataQuality ?? null,
          } } : {}),
          council: councilSummary, vetoes: analysis.risk?.vetoes || [], strategies: strategyResults,
        });
        continue;
      }
      if (!liquidityFvgApproved) {
        outcomes.push({ symbol, status: "no_trade", action: "WAIT", reason: "liquidity_fvg_gate_not_met", council: councilSummary, liquidityFvg: liquidityFvg ? { direction: liquidityFvg.direction, score: liquidityFvg.score, manipulation: liquidityFvg.manipulation, blocks: liquidityFvg.blocks } : null, strategies: strategyResults });
        continue;
      }
      if (alignedStrategies.length < minStrategyAgreement) {
        outcomes.push({ symbol, status: "no_trade", action: expectedAction, reason: "omnisignal_strategy_consensus_not_met", council: councilSummary, alignedStrategies: alignedStrategies.length, required: minStrategyAgreement, strategies: strategyResults });
        continue;
      }
      if (!account) { outcomes.push({ symbol, status: "blocked", reason: "paper_account_unavailable", council: councilSummary, strategies: strategyResults }); continue; }
      if (activeOrders.some((o: any) => o.symbol === symbol)) { outcomes.push({ symbol, status: "skipped", reason: "active_order_already_exists", council: councilSummary, strategies: strategyResults }); continue; }
      if (expectedAction === "BUY" && account.unknownOpenRisk) { outcomes.push({ symbol, status: "blocked", reason: "existing_position_has_no_protective_stop", council: councilSummary, strategies: strategyResults }); continue; }
      if (expectedAction === "BUY" && activePositions.length + pendingEntryCount + submitted >= maxPositions) { outcomes.push({ symbol, status: "skipped", reason: "max_open_positions", council: councilSummary, strategies: strategyResults }); continue; }
      const executeBody = { ...body, execution: {
        broker: "eti_paper", clientOrderId, riskConfirmed: true,
        executionSource: { actorType: "automation", actorId: "eti-multi-agent-autopilot", sourceName: "ETI Multi-Agent Autopilot", strategyId: "commander-consensus", signalId: clientOrderId, triggerReason: "Scheduled multi-agent consensus; internal paper only" },
      } };
      const response = await app.fetch(new Request("https://eti.internal/api/agents/execute", { method: "POST", headers, body: json(executeBody) }), env);
      const result: any = await response.json().catch(() => ({}));
      if (response.status >= 200 && response.status < 300 && result.ok) {
        submitted++;
        outcomes.push({ symbol, status: "paper_order_submitted", action: result.decision?.action, confidence, agreement, alignedStrategies: alignedStrategies.length, strategies: strategyResults, broker: "eti_paper", simulated: true, order: result.broker?.order ?? result.broker?.fill ?? null });
      } else {
        outcomes.push({ symbol, status: response.status === 409 ? "risk_veto_or_no_trade" : "blocked", httpStatus: response.status, error: result.error || result.reason || "agent_execution_rejected", reasons: result.reasons || result.risk?.vetoes || [] });
      }
    } catch (e) {
      outcomes.push({ symbol, status: "error", error: e instanceof Error ? e.message : "unknown_error" });
    } finally {
      await env.ETI_EXECUTION_LOG.put(claim, "complete", { expirationTtl: 60 * 60 * 24 * 3 }).catch(() => undefined);
    }
  }
  const summary = { ...disabled, at: new Date(now).toISOString(), interval, symbols, submitted, evaluated: outcomes.length, outcomes, policy: { minConfidence, minAgreement, minOmniConfidence, strategies, minStrategyAgreement, maxPositions, maxPerCycle, noPyramiding: true, riskManagerVetoBinding: true } };
  await env.ETI_EXECUTION_LOG.put("agent-autopilot:last", json(summary), { expirationTtl: 60 * 60 * 24 * 30 });
  return summary;
}
