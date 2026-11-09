/** Agent planning for margin-free perpetual futures: turns a Commander analysis into BUY / SELL / SHORT / COVER with costs, leverage and liquidation checks. Pure; never submits. */
import type { AnalysisResult } from "./orchestrator.ts";
import type { ExecutionSource } from "./controls.ts";
import { classifyIntent, futuresHardChecks } from "../futures.ts";
import type { FuturesCaps, FuturesState, Intent } from "../futures.ts";

export const COST_ASSUMPTIONS = { takerFeeRate: 0.0005, slippageBps: 5, holdHours: 24 };
export interface FuturesCosts { feesUsd: number; slippageUsd: number; fundingUsd: number; totalUsd: number; perUnit: number; assumptions: typeof COST_ASSUMPTIONS }
export interface FuturesTicket {
  symbol: string; side: "buy" | "sell"; quantity: number; limitPrice: number; leverage: number; reduceOnly: boolean; stopPrice?: number;
  clientOrderId: string; riskConfirmed: true; executionSource: ExecutionSource; intent: Intent;
}
export interface FuturesPlan {
  schema: "eti.futures.plan/1"; venue: "binance_futures_testnet"; action: Intent | "NO_TRADE"; reduceOnly: boolean; eligible: boolean; blockers: string[]; warnings: string[];
  costs: FuturesCosts | null; liquidation: { estimated: number | null; exchangeReported: number | null; stop: number | null } | null; ticket: FuturesTicket | null;
}

/** Round-trip taker fees + slippage, plus funding over the assumed hold when it is a COST (receipts are not counted). Fees/funding rates are assumptions, not account-specific. */
export function estimateCosts(a: { side: "buy" | "sell"; quantity: number; price: number; fundingRate: number; holdHours?: number; takerFeeRate?: number; slippageBps?: number }): FuturesCosts {
  const n = a.quantity * a.price, hold = a.holdHours ?? COST_ASSUMPTIONS.holdHours, fee = a.takerFeeRate ?? COST_ASSUMPTIONS.takerFeeRate, bps = a.slippageBps ?? COST_ASSUMPTIONS.slippageBps;
  const feesUsd = 2 * n * fee, slippageUsd = 2 * n * (bps / 1e4), fundingUsd = n * (a.side === "buy" ? a.fundingRate : -a.fundingRate) * (hold / 8);
  const totalUsd = feesUsd + slippageUsd + Math.max(0, fundingUsd);
  return { feesUsd, slippageUsd, fundingUsd, totalUsd, perUnit: a.quantity > 0 ? totalUsd / a.quantity : 0, assumptions: { takerFeeRate: fee, slippageBps: bps, holdHours: hold } };
}

export function planFutures(a: {
  analysis: AnalysisResult; state: FuturesState | null; caps: FuturesCaps | null; marketFresh: boolean; flags: { enabled: boolean; killSwitch: boolean };
  request?: { clientOrderId?: string; riskConfirmed?: boolean; executionSource?: ExecutionSource };
}): FuturesPlan {
  const blockers: string[] = [], warnings: string[] = [], st = a.state, dir = a.analysis.deliberation.direction;
  const out = (action: FuturesPlan["action"], reduceOnly: boolean, extra: Partial<FuturesPlan> = {}): FuturesPlan =>
    ({ schema: "eti.futures.plan/1", venue: "binance_futures_testnet", action, reduceOnly, eligible: false, blockers, warnings, costs: null, liquidation: null, ticket: null, ...extra });
  if (dir === "none") { blockers.push("no_directional_consensus"); return out("NO_TRADE", false); }
  if (!a.flags.enabled) blockers.push("futures_disabled");
  if (a.flags.killSwitch) blockers.push("kill_switch_active");
  if (!a.caps) blockers.push("futures_caps_not_configured");
  if (!st) { blockers.push("futures_state_unavailable"); return out(dir === "long" ? "BUY" : "SHORT", false); }
  if (!a.marketFresh) blockers.push("market_data_stale");
  const rq = a.request;
  if (typeof rq?.clientOrderId !== "string" || !/^[A-Za-z0-9_-]{8,36}$/.test(rq.clientOrderId)) blockers.push("client_order_id_required");
  if (rq?.riskConfirmed !== true) blockers.push("risk_confirmation_required");
  const side = dir === "long" ? "buy" as const : "sell" as const, intent = classifyIntent(side, st.positionAmt), reduce = intent === "SELL" || intent === "COVER";
  const source: ExecutionSource = rq?.executionSource ?? { actorType: "strategy", actorId: "eti-commander", sourceName: "ETI Multi-Agent Commander (futures)", strategyId: null, signalId: a.analysis.id, triggerReason: "Commander consensus" };
  const cp = a.caps ?? { maxLeverage: 1, maxNotionalUsd: 0 };
  const ids = { clientOrderId: rq?.clientOrderId ?? "", riskConfirmed: true as const, executionSource: source };

  if (reduce) {
    // Risk-reducing exit: entry sizing vetoes do not apply, but the exchange-state and mark-price checks do.
    const qty = Math.abs(st.positionAmt), limit = side === "buy" ? st.markPrice * 1.001 : st.markPrice * 0.999;
    const h = futuresHardChecks({ side, quantity: qty, limitPrice: limit, reduceOnly: true, leverage: st.leverage || 1 }, st, cp);
    if (!h.ok) blockers.push(...h.reasons);
    warnings.push("Exit uses a marketable limit within 0.1% of mark; it may not fill in a fast market.");
    const eligible = blockers.length === 0;
    return out(intent, true, { eligible, ticket: eligible ? { symbol: a.analysis.symbol, side, quantity: qty, limitPrice: limit, leverage: st.leverage || 1, reduceOnly: true, intent, ...ids } : null });
  }

  const risk = a.analysis.risk, prop = a.analysis.decision.proposal;
  if (!a.analysis.decision.executionEligible || !prop || !risk?.sizing) blockers.push("risk_not_approved", ...(risk?.vetoes ?? []).map((v) => "risk_veto:" + v));
  else if (prop.side !== side) blockers.push("proposal_side_mismatch");
  if (blockers.some((x) => x === "risk_not_approved" || x === "proposal_side_mismatch") || !prop || !risk?.sizing) return out(intent, false);
  const qty = risk.sizing.quantity, limit = prop.entry, notional = qty * limit;
  const leverage = st.positionAmt !== 0 ? st.leverage : Math.min(cp.maxLeverage, Math.max(1, Math.ceil(notional / (0.5 * Math.max(st.availableBalance, 1e-9)))));
  const costs = estimateCosts({ side, quantity: qty, price: limit, fundingRate: st.fundingRate });
  const netRR = (Math.abs(prop.targets[2] - prop.entry) - costs.perUnit) / (prop.stopDistance + costs.perUnit);
  if (netRR < 2) blockers.push("net_reward_risk_below_2_after_costs");
  const h = futuresHardChecks({ side, quantity: qty, limitPrice: limit, reduceOnly: false, leverage, stopPrice: prop.stop }, st, cp);
  if (!h.ok) blockers.push(...h.reasons); else warnings.push(...h.warnings);
  warnings.push(`Costs assume ${COST_ASSUMPTIONS.takerFeeRate * 100}% taker fee/side, ${COST_ASSUMPTIONS.slippageBps} bps slippage/side and a ${COST_ASSUMPTIONS.holdHours}h hold; net reward:risk ${netRR.toFixed(2)}.`, "No protective stop is placed automatically; monitor the position.");
  const eligible = blockers.length === 0;
  return out(intent, false, { eligible, costs, liquidation: { estimated: h.ok ? h.estLiquidation : null, exchangeReported: st.liquidationPrice > 0 ? st.liquidationPrice : null, stop: prop.stop }, ticket: eligible ? { symbol: a.analysis.symbol, side, quantity: qty, limitPrice: limit, leverage, reduceOnly: false, stopPrice: prop.stop, intent, ...ids } : null });
}
