// Turns system events into alerts. Pure mapping functions: no I/O, no secrets. Each alert says what happened and where to look;
// none claims profitability or gives financial advice.
import type { AlertEvent } from "./alerts.ts";
import type { CycleItem, CycleSummary } from "./paper-api.ts";
import type { ManageOutcome } from "./manage.ts";
import type { ScanRow } from "./scan.ts";

const ev = (e: AlertEvent): AlertEvent => e;

export function paperCycleAlerts(s: CycleSummary): AlertEvent[] {
  if (!s.ran) return [];
  const out: AlertEvent[] = [];
  if (s.killSwitch) out.push(ev({ type: "kill_switch", severity: "critical", title: "Kill switch is active; paper entries are blocked", detail: "No new paper positions will open until the kill switch is cleared. Open positions are still managed.", dedupeKey: "kill:paper" }));
  for (const it of s.items as CycleItem[]) {
    const base = { symbol: it.symbol }, k = `${s.at}:${it.symbol}`;
    if (it.error) { out.push(ev({ ...base, type: "market_data_failure", severity: "warning", title: `${it.action} failed for ${it.symbol}`, detail: it.error, dedupeKey: `err:${it.symbol}:${s.at.slice(0, 13)}` })); continue; }
    for (const t of it.events ?? []) {
      if (/^TP[123]$/.test(t)) out.push(ev({ ...base, type: "take_profit_hit", severity: "info", title: `${t} reached on ${it.symbol} (paper)`, detail: "A staged target filled in the paper simulation.", dedupeKey: `${t}:${k}` }));
      else if (t === "BREAKEVEN") out.push(ev({ ...base, type: "stop_activated", severity: "info", title: `Stop moved to break-even on ${it.symbol} (paper)`, detail: "After TP1 the stop tightened to cover costs.", dedupeKey: `be:${k}` }));
      else if (t === "STOP") out.push(ev({ ...base, type: "stop_loss_hit", severity: "warning", title: `Stop hit on ${it.symbol} (paper)`, detail: "The paper position was stopped out.", dedupeKey: `stop:${k}` }));
      else if (t === "CLOSED") out.push(ev({ ...base, type: "position_closed", severity: "info", title: `Paper position closed: ${it.symbol}`, detail: "See /api/paper/performance for the result.", dedupeKey: `closed:${k}` }));
      else if (t === "KILL_SWITCH") out.push(ev({ ...base, type: "kill_switch", severity: "critical", title: "Kill switch engaged", detail: `Raised while managing ${it.symbol}.`, dedupeKey: `ks:${k}` }));
    }
    if (it.action === "evaluate" && it.event === "OPENED") out.push(ev({ ...base, type: "trade_executed", severity: "info", title: `Paper ${it.decision ?? "trade"} opened on ${it.symbol}`, detail: (it.reasons ?? []).slice(0, 3).join(" | ") || "Opened by the scheduled paper cycle.", dedupeKey: `open:${k}` }));
    if (it.action === "evaluate" && it.event === "REJECTED") out.push(ev({ ...base, type: "risk_rejection", severity: "warning", title: `Risk controls rejected ${it.symbol}`, detail: (it.reasons ?? []).slice(0, 4).join(" | ") || "Rejected by the risk gateway.", dedupeKey: `rej:${k}` }));
  }
  return out;
}

const LOG_RULES: Record<string, (d: any) => Omit<AlertEvent, "dedupeKey"> | null> = {
  protective_failed: d => ({ type: "protection_failure", severity: "critical", title: "A position may be unprotected", detail: `Protective stop/take-profit orders could not be placed. ${(d?.reasons ?? [d?.error ?? ""]).join("; ")} The account was halted.` }),
  protective_adjust_failed: d => ({ type: "protection_failure", severity: "warning", title: "Stop adjustment failed", detail: `Stage ${d?.stage ?? "?"}: ${d?.error ?? ""}` }),
  protective_restored: () => ({ type: "protection_failure", severity: "warning", title: "Stop adjustment failed; original protection restored", detail: "The tighter stop was refused; the original levels were put back." }),
  protective_adjusted: d => ({ type: "stop_activated", severity: "info", title: `Stop tightened (${d?.stage ?? ""})`, detail: `Stop moved from ${d?.from_stop} to ${d?.to_stop}.` }),
  account_halted: d => ({ type: "account_halted", severity: "critical", title: "Account halted", detail: String(d?.reason ?? d?.reasons ?? "see /api/execution/logs") }),
  emergency_started: () => ({ type: "account_halted", severity: "critical", title: "Emergency flatten started", detail: "An emergency exit was triggered." }),
  position_mismatch: d => ({ type: "protection_failure", severity: "critical", title: "Position does not match the venue", detail: JSON.stringify(d ?? {}).slice(0, 300) }),
  venue_down: () => ({ type: "exchange_outage", severity: "critical", title: "Exchange unavailable", detail: "Orders cannot be confirmed until the venue recovers." }),
  venue_recovered: () => ({ type: "exchange_outage", severity: "info", title: "Exchange recovered", detail: "The venue is reachable again." }),
  order_rejected_by_venue: d => ({ type: "risk_rejection", severity: "warning", title: "Venue rejected an order", detail: String((d?.reasons ?? [d?.error ?? ""]).join?.("; ") ?? d?.error ?? "") }),
  order_failed_permanent: d => ({ type: "risk_rejection", severity: "warning", title: "Order failed permanently", detail: String(d?.error ?? "") }),
  order_outcome_uncertain: () => ({ type: "protection_failure", severity: "warning", title: "An order outcome is uncertain", detail: "The engine will confirm it with the venue; check /api/execution/orders." }),
  fill: d => ({ type: "trade_executed", severity: "info", title: `Order filled${d?.symbol ? " on " + d.symbol : ""}`, detail: `Quantity ${d?.qty ?? d?.filled_qty ?? "?"} at ${d?.price ?? d?.avg_price ?? "?"}.` }),
  invalidation_exit: d => ({ type: "thesis_invalidated", severity: "warning", title: `Position closed: thesis invalidated (${d?.symbol ?? ""})`, detail: String(d?.reason ?? "") }),
  order_rejected: d => ({ type: "risk_rejection", severity: "warning", title: "Order rejected by risk controls", detail: (d?.reasons ?? []).join?.("; ") ?? "" }),
  invalidation_exit_failed: d => ({ type: "protection_failure", severity: "critical", title: "Invalidation exit failed after protection was cancelled", detail: String(d?.error ?? d?.failed ? JSON.stringify(d?.failed) : "") }),
};
export interface ExecLog { ts: string; account_id?: string; event: string; client_order_id?: string | null; details?: any }
/** Alerts for execution-engine log entries strictly newer than `sinceMs`. Returns the alerts and the newest timestamp seen. */
export function executionLogAlerts(logs: ExecLog[], accountId: string, sinceMs: number): { alerts: AlertEvent[]; newest: number } {
  let newest = sinceMs; const alerts: AlertEvent[] = [];
  for (const l of [...logs].reverse()) {
    const t = Date.parse(l.ts); if (!Number.isFinite(t)) continue; newest = Math.max(newest, t);
    if (t <= sinceMs) continue;
    const rule = LOG_RULES[l.event]; const a = rule?.(l.details); if (!a) continue;
    alerts.push({ ...a, accountId, symbol: a.symbol ?? l.details?.symbol, dedupeKey: `log:${accountId}:${l.event}:${l.client_order_id ?? ""}:${l.ts}` });
  }
  return { alerts, newest };
}

export function manageAlerts(accountId: string, outcomes: ManageOutcome[], at: number): AlertEvent[] {
  const out: AlertEvent[] = [], hour = Math.floor(at / 3600_000);
  for (const o of outcomes) {
    if (o.invalidated && o.action === "report_only") out.push({ type: "thesis_invalidated", severity: "warning", accountId, symbol: o.symbol, title: `Thesis invalidated on ${o.symbol} (report only)`, detail: `${o.reasons.join("; ")}. Closing is not enabled, so the position stays open with its stops.`, dedupeKey: `inv-report:${accountId}:${o.symbol}:${hour}` });
    else if (o.invalidated && o.action === "close_requested") out.push({ type: "thesis_invalidated", severity: "warning", accountId, symbol: o.symbol, title: `Closing ${o.symbol}: thesis invalidated`, detail: o.reasons.join("; "), dedupeKey: `inv-close:${accountId}:${o.symbol}:${hour}` });
    else if (o.action === "close_failed") out.push({ type: "protection_failure", severity: "critical", accountId, symbol: o.symbol, title: `Closing ${o.symbol} failed`, detail: JSON.stringify(o.execution ?? {}).slice(0, 400), dedupeKey: `inv-fail:${accountId}:${o.symbol}:${hour}` });
    else if (o.evaluable && (o.agreement === "SWIFT_BULLISH_GAINZ_BEARISH" || o.agreement === "SWIFT_BEARISH_GAINZ_BULLISH")) out.push({ type: "signal_disagreement", severity: "warning", accountId, symbol: o.symbol, title: `Engines disagree on held position ${o.symbol}`, detail: `Agreement state: ${o.agreement}. Stops and targets still govern the exit; this is a heads-up, not an exit signal.`, dedupeKey: `dis:${accountId}:${o.symbol}:${o.agreement}:${hour}` });
    else if (!o.evaluable) out.push({ type: "market_data_failure", severity: "warning", accountId, symbol: o.symbol, title: `Cannot evaluate ${o.symbol}`, detail: o.reasons.join("; ") || "Market data unreliable; no action was taken.", dedupeKey: `md:${o.symbol}:${hour}` });
  }
  return out;
}

export const HIGH_CONVICTION_SCORE = 80;
/** New actionable rows since the last pass. A row alerts once per direction change, and "high conviction" needs a high evidence score. */
export function signalAlerts(prev: Record<string, { decision: string; direction: string | null }> | undefined, rows: ScanRow[], strategy: string): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const r of rows) {
    if (r.decision !== "BUY" && r.decision !== "SELL") continue;
    if (prev?.[r.symbol]?.decision === r.decision) continue;
    const high = (r.opportunityScore ?? 0) >= HIGH_CONVICTION_SCORE;
    out.push({ type: high ? "high_conviction" : "new_signal", severity: "info", symbol: r.symbol, title: `${high ? "High-conviction" : "New"} ${r.decision} signal: ${r.symbol} (${strategy})`, detail: `Evidence score ${r.confidence}/100 (uncalibrated unless stated), opportunity ${r.opportunityScore ?? "n/a"}, validator ${r.validationScore ?? "n/a"}, R:R to TP3 ${r.riskRewardToTP3 ?? "n/a"}. Analytical evidence only.`, dedupeKey: `sig:${r.symbol}:${r.decision}:${Math.floor(Date.now() / 3600_000)}` });
  }
  return out;
}
