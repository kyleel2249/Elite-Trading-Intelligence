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
  ETI_AGENT_AUTOPILOT_MIN_OMNI_CONFIDENCE?: string;\n  ETI_AGENT_AUTOPILOT_CONFIG?: string;
}
type App = { fetch(request: Request, env: any): Promise<Response> | Response };
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

/** Runs one bounded batch. A run is a no-op unless explicitly enabled in Worker configuration. */
export async function runAgentAutopilotCycle(env: AgentAutopilotEnv, app: App, now = Date.now()) {
  const disabled = { enabled: env.ETI_AGENT_AUTOPILOT_ENABLED === "true", mode: "internal_paper_only", liveOrdersAllowed: false };
  if (!disabled.enabled) return { ...disabled, skipped: "autopilot_disabled" };
  if (env.ETI_KILL_SWITCH === "true") return { ...disabled, skipped: "kill_switch_active" };
  if (!env.ETI_EXECUTION_TOKEN || !env.ETI_EXECUTION_LOG) return { ...disabled, skipped: "execution_token_or_audit_log_missing" };
  if (!env.ETI_PORTFOLIO_DB && !env.ETI_EXECUTION_LOG) return { ...disabled, skipped: "portfolio_storage_missing" };

  const config = readAutopilotConfig(env);
  const symbols = [...new Set(config.symbols.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{5,20}$/.test(s)))].slice(0, 30);
  const interval = config.interval;
  if (!ALLOWED_INTERVALS.has(interval)) return { ...disabled, skipped: "invalid_interval" };
  const maxPerCycle = Math.floor(config.maxPerCycle);
  const minConfidence = config.minConfidence, minAgreement = config.minAgreement;
  const maxPositions = Math.floor(config.maxPositions);
  const strategies = [...new Set(config.strategies.split(",").map(s => s.trim().toLowerCase()).filter(s => ["scalp", "intraday", "swing", "position"].includes(s)))];
  const minStrategyAgreement = Math.floor(config.minStrategyAgreement);
  const minOmniConfidence = config.minOmniConfidence;
  if (!symbols.length) return { ...disabled, skipped: "no_valid_symbols" };
  if (!strategies.length || minStrategyAgreement > strategies.length) return { ...disabled, skipped: "invalid_strategy_configuration" };

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
      if (!account) { outcomes.push({ symbol, status: "blocked", reason: "paper_account_unavailable" }); continue; }
      if (activeOrders.some((o: any) => o.symbol === symbol)) { outcomes.push({ symbol, status: "skipped", reason: "active_order_already_exists" }); continue; }

      const clientOrderId = ("eti-" + symbol + "-" + slot).slice(0, 36);
      const body = {
        symbol, interval, account: {
          equityUsd: account.equityUsd, availableUsd: account.availableUsd,
          positionQuantity: account.positionQuantity, dailyPnlPct: account.dailyPnlPct,
          drawdownPct: account.drawdownPct, openRiskPct: account.openRiskPct,
        },
      };
      const headers = { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN, "content-type": "application/json" };
      const expectedAction = account.positionQuantity > 0 ? "SELL" : "BUY";
      body.account.availableUsd = expectedAction === "SELL" ? account.equityUsd : account.availableUsd;
      if (expectedAction === "BUY" && account.unknownOpenRisk) { outcomes.push({ symbol, status: "blocked", reason: "existing_position_has_no_protective_stop" }); continue; }
      // Omnisignal runs the existing Swift + GainzAlgo engines, FVG, liquidity, flow,
      // multi-timeframe and validation stack independently for each configured strategy.
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
      if (alignedStrategies.length < minStrategyAgreement) {
        outcomes.push({ symbol, status: "no_trade", action: expectedAction, reason: "omnisignal_strategy_consensus_not_met", alignedStrategies: alignedStrategies.length, required: minStrategyAgreement, strategies: strategyResults });
        continue;
      }
      const preflight = await app.fetch(new Request("https://eti.internal/api/agents/analyze", { method: "POST", headers, body: json(body) }), env);
      const analysis: any = await preflight.json().catch(() => ({}));
      const decision = analysis.decision, confidence = Number(decision?.confidence || 0), agreement = Number(decision?.consensus?.agreement || 0);
      if (!preflight.ok || decision?.action !== expectedAction || confidence < minConfidence || agreement < minAgreement || analysis.risk?.approved !== true || ["high", "critical"].includes(analysis.security?.severity)) {
        outcomes.push({ symbol, status: "no_trade", action: decision?.action || "NO_TRADE", confidence, agreement, reason: !preflight.ok ? "analysis_unavailable" : decision?.vetoedBy || "agent_consensus_or_risk_not_met", vetoes: analysis.risk?.vetoes || [], security: analysis.security?.severity || "unknown", strategies: strategyResults });
        continue;
      }
      if (expectedAction === "BUY" && activePositions.length + pendingEntryCount + submitted >= maxPositions) { outcomes.push({ symbol, status: "skipped", reason: "max_open_positions" }); continue; }
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
