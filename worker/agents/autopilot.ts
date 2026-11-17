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
}
type App = { fetch(request: Request, env: any): Promise<Response> | Response };
const ALLOWED_INTERVALS = new Set(["5m", "15m", "30m", "1h", "4h", "1d"]);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const json = (x: unknown) => JSON.stringify(x);
const envNum = (v: string | undefined, fallback: number, lo: number, hi: number) => clamp(num(v, fallback), lo, hi);

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
    openRiskPct: unknownStop ? 100 : (openRiskUsd / equity) * 100,
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

  const symbols = [...new Set(String(env.ETI_AGENT_AUTOPILOT_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{5,20}$/.test(s)))].slice(0, 30);
  const interval = String(env.ETI_AGENT_AUTOPILOT_INTERVAL || "15m");
  if (!ALLOWED_INTERVALS.has(interval)) return { ...disabled, skipped: "invalid_interval" };
  const maxPerCycle = Math.floor(envNum(env.ETI_AGENT_AUTOPILOT_MAX_PER_CYCLE, 2, 1, 10));
  const minConfidence = envNum(env.ETI_AGENT_AUTOPILOT_MIN_CONFIDENCE, 0.65, 0.5, 0.95);
  const minAgreement = envNum(env.ETI_AGENT_AUTOPILOT_MIN_AGREEMENT, 0.65, 0.5, 0.95);
  const maxPositions = Math.floor(envNum(env.ETI_AGENT_AUTOPILOT_MAX_POSITIONS, 3, 1, 10));
  if (!symbols.length) return { ...disabled, skipped: "no_valid_symbols" };

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
  for (const symbol of symbols) {
    if (outcomes.length >= maxPerCycle) break;
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
      const preflight = await app.fetch(new Request("https://eti.internal/api/agents/analyze", { method: "POST", headers, body: json(body) }), env);
      const analysis: any = await preflight.json().catch(() => ({}));
      const decision = analysis.decision, confidence = Number(decision?.confidence || 0), agreement = Number(decision?.consensus?.agreement || 0);
      const expectedAction = account.positionQuantity > 0 ? "SELL" : "BUY";
      if (!preflight.ok || decision?.action !== expectedAction || confidence < minConfidence || agreement < minAgreement || analysis.risk?.approved !== true || ["high", "critical"].includes(analysis.security?.severity)) {
        outcomes.push({ symbol, status: "no_trade", action: decision?.action || "NO_TRADE", confidence, agreement, reason: !preflight.ok ? "analysis_unavailable" : decision?.vetoedBy || "autopilot_entry_thresholds_or_risk_not_met", vetoes: analysis.risk?.vetoes || [], security: analysis.security?.severity || "unknown" });
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
        outcomes.push({ symbol, status: "paper_order_submitted", action: result.decision?.action, confidence, agreement, broker: "eti_paper", simulated: true, order: result.broker?.order ?? result.broker?.fill ?? null });
      } else {
        outcomes.push({ symbol, status: response.status === 409 ? "risk_veto_or_no_trade" : "blocked", httpStatus: response.status, error: result.error || result.reason || "agent_execution_rejected", reasons: result.reasons || result.risk?.vetoes || [] });
      }
    } catch (e) {
      outcomes.push({ symbol, status: "error", error: e instanceof Error ? e.message : "unknown_error" });
    } finally {
      await env.ETI_EXECUTION_LOG.put(claim, "complete", { expirationTtl: 60 * 60 * 24 * 3 }).catch(() => undefined);
    }
  }
  const summary = { ...disabled, at: new Date(now).toISOString(), interval, symbols, submitted, evaluated: outcomes.length, outcomes, policy: { minConfidence, minAgreement, maxPositions, maxPerCycle, noPyramiding: true, riskManagerVetoBinding: true } };
  await env.ETI_EXECUTION_LOG.put("agent-autopilot:last", json(summary), { expirationTtl: 60 * 60 * 24 * 30 });
  return summary;
}
