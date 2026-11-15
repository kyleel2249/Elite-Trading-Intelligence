/**
 * Automatic profit management rules. Pure functions, no I/O, integer cents only.
 *
 * Principle: money is only ever recognised from CONFIRMED, REALIZED results. A trade counts only when it is closed, its net result and
 * its fees are known, it came from ETI's own engines (not a hand-typed record), it is past the confirmation window, and its environment
 * matches the books it is posted to. Open positions, resting or partially filled orders, unknown outcomes, unknown fees and anything
 * unconfirmed are listed as excluded with the reason, never silently dropped and never counted.
 *
 * Environments follow the treasury: paper, testnet and other simulated results belong to the "simulated" books; only a live, exchange-
 * confirmed trade could belong to "actual" (ETI places no live orders, so today there is none).
 */
import * as T from "../treasury/model.ts";
import type { TradeRecord } from "../journal/analytics.ts";

export const SOURCE = "eti-journal";
/** Default confirmation window: a trade must have been closed this long before it becomes distributable. */
export const DEFAULT_CONFIRM_MS = 60 * 60_000;
export const toCents = (v: number): number => Math.round(v * 100);
export const treasuryEnvOf = (env: string | null): T.Environment | "excluded" => {
  if (env === "live") return "actual";
  if (env === "internal_paper" || env === "exchange_testnet" || env === "paper" || env === "testnet" || env === "simulated" || env === "paper_engine") return "simulated";
  return "excluded";
};

export interface Eligible { tradeId: string; symbol: string | null; closedAt: number; grossCents: number; feesCents: number; netCents: number; strategy: string | null }
export interface Excluded { tradeId: string; symbol: string | null; reason: string; detail: string }
export interface Classified { eligible: Eligible[]; excluded: Excluded[] }
const NOT_REALIZED: Record<string, string> = {
  open: "position_still_open_unrealized", filled: "filled_not_closed_unrealized", partially_filled: "partially_filled_unrealized",
  resting: "order_resting_unconfirmed", outcome_unknown: "broker_outcome_unknown",
};

export interface ClassifyOptions { environment: T.Environment; now: number; confirmMs?: number; alreadyRecognised?: Set<string>; includeManual?: boolean }
export function classifyTrades(trades: TradeRecord[], o: ClassifyOptions): Classified {
  const confirm = o.confirmMs ?? DEFAULT_CONFIRM_MS, eligible: Eligible[] = [], excluded: Excluded[] = [];
  for (const t of trades) {
    const ex = (reason: string, detail: string) => excluded.push({ tradeId: t.tradeId, symbol: t.symbol, reason, detail });
    if (o.alreadyRecognised?.has(t.tradeId)) continue;
    if (t.environment === "sports_paper") { ex("sports_tracked_separately", "Sports-betting paper results are kept apart from trading profit."); continue; }
    if (t.status !== "closed") {
      const why = NOT_REALIZED[t.status];
      if (why) ex(why, "Only closed trades are realized. Status: " + t.status + ".");
      continue; // analysed / rejected / cancelled / expired: no money moved, nothing to list
    }
    if (t.origin === "manual" && !o.includeManual) { ex("manual_record_unverified", "Hand-entered results are not confirmed by an engine or broker."); continue; }
    const env = treasuryEnvOf(t.environment);
    if (env === "excluded") { ex("environment_unknown", "The trade has no recognised environment, so it cannot be posted to either set of books."); continue; }
    if (env !== o.environment) { ex("other_environment", "Belongs to the " + env + " books."); continue; }
    if (t.net === null || !Number.isFinite(t.net)) { ex("net_result_unknown", "The closed trade carries no net result."); continue; }
    if (!t.feesKnown) { ex("fees_unconfirmed", "Fees were not reported, so the true net profit is unknown."); continue; }
    if (o.now - t.lastAt < confirm) { ex("inside_confirmation_window", "Closed " + Math.round((o.now - t.lastAt) / 60000) + " min ago; waits " + Math.round(confirm / 60000) + " min before it counts."); continue; }
    const gross = t.gross ?? (t.net + (t.fees ?? 0)), fees = Math.abs(t.fees ?? 0), net = toCents(t.net);
    eligible.push({ tradeId: t.tradeId, symbol: t.symbol, closedAt: t.lastAt, grossCents: toCents(gross), feesCents: toCents(fees), netCents: net, strategy: t.strategy });
  }
  return { eligible, excluded };
}

export interface Realized { trades: number; wins: number; losses: number; breakeven: number; grossCents: number; feesCents: number; winsCents: number; lossesCents: number; netCents: number; winRate: number | null; profitFactor: number | null }
export function summarise(rows: Eligible[]): Realized {
  let gross = 0, fees = 0, w = 0, l = 0, wn = 0, ln = 0;
  for (const r of rows) { gross += r.grossCents; fees += r.feesCents; if (r.netCents > 0) { w += r.netCents; wn++; } else if (r.netCents < 0) { l += -r.netCents; ln++; } }
  return { trades: rows.length, wins: wn, losses: ln, breakeven: rows.length - wn - ln, grossCents: gross, feesCents: fees, winsCents: w, lossesCents: l, netCents: w - l,
    winRate: rows.length ? wn / rows.length : null, profitFactor: l > 0 ? w / l : null };
}

/** Peak-to-trough fall of the realized-net curve inside the window, in cents. */
export function drawdownCents(rows: Array<{ closedAt: number; netCents: number }>, from: number): number {
  let cum = 0, peak = 0, dd = 0;
  for (const r of [...rows].filter(x => x.closedAt >= from).sort((a, b) => a.closedAt - b.closedAt)) { cum += r.netCents; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

export interface ProtectionInput { policy: T.Policy | null; balances: T.Balances; unrecoveredLoss: number; recent: Array<{ closedAt: number; netCents: number }>; now: number; windowMs: number; maxDrawdownBps: number }
export interface Check { name: string; met: boolean; detail: string }
export interface Protection { hold: boolean; reason: string | null; checks: Check[]; drawdownCents: number; drawdownBpsOfCapital: number | null }
const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** Capital-protection assessment. A drawdown beyond the limit puts distributions on hold: new profit is routed to trading capital instead. */
export function assessProtection(i: ProtectionInput): Protection {
  const checks: Check[] = [], cap = i.balances.tradingCapital, dd = drawdownCents(i.recent, i.now - i.windowMs);
  const ddBps = cap > 0 ? Math.round((dd * 10000) / cap) : null;
  const breach = ddBps !== null ? ddBps > i.maxDrawdownBps : dd > 0;
  checks.push({ name: "drawdown_limit", met: !breach, detail: `Realized drawdown ${usd(dd)} in the last ${Math.round(i.windowMs / 86_400_000)} days` + (ddBps !== null ? ` = ${(ddBps / 100).toFixed(2)}% of trading capital (limit ${(i.maxDrawdownBps / 100).toFixed(2)}%).` : "; trading capital is zero.") });
  if (i.policy) {
    checks.push({ name: "minimum_trading_capital", met: cap >= i.policy.minTradingCapitalCents, detail: `Trading capital ${usd(cap)} vs minimum ${usd(i.policy.minTradingCapitalCents)}.` });
    checks.push({ name: "emergency_reserve", met: i.balances.emergencyReserve >= i.policy.reserveTargetCents, detail: `Reserve ${usd(i.balances.emergencyReserve)} vs target ${usd(i.policy.reserveTargetCents)}.` });
    const liquid = T.liquidFunds(i.balances);
    checks.push({ name: "liquidity", met: liquid >= i.policy.liquidityMinCents, detail: `Liquid funds ${usd(liquid)} vs minimum ${usd(i.policy.liquidityMinCents)}.` });
  } else checks.push({ name: "active_policy", met: false, detail: "No approved allocation policy: nothing can be allocated automatically." });
  checks.push({ name: "unrecovered_losses", met: i.unrecoveredLoss === 0, detail: i.unrecoveredLoss ? `${usd(i.unrecoveredLoss)} of realized losses still to recover from profit.` : "No unrecovered losses." });
  return { hold: breach, reason: breach ? "drawdown_limit_breached" : null, checks, drawdownCents: dd, drawdownBpsOfCapital: ddBps };
}

export interface Recommendation { allocations: T.Allocation[]; totalCents: number; lossRecoveredCents: number; mode: "policy_waterfall" | "capital_protection_hold" | "none"; note: string }
/** Recommends how the available realized-profit pool is allocated. Never allocates more than the pool; a hold sends everything to trading capital. */
export function recommend(policy: T.Policy | null, balances: T.Balances, unrecoveredLoss: number, availableCents: number, protection: Protection): Recommendation {
  const pool = Math.max(0, Math.min(availableCents, balances.realizedProfits));
  if (!policy) return { allocations: [], totalCents: 0, lossRecoveredCents: 0, mode: "none", note: "No active allocation policy. A second person must approve one before allocation." };
  if (pool <= 0) return { allocations: [], totalCents: 0, lossRecoveredCents: 0, mode: "none", note: "No confirmed realized profit is available to allocate." };
  if (protection.hold) return { allocations: [{ account: "1100", cents: pool, reason: "capital_protection_hold" }], totalCents: pool, lossRecoveredCents: 0, mode: "capital_protection_hold", note: "Distributions are on hold (drawdown limit breached): everything is routed back to trading capital." };
  const p = T.planAllocation(policy, balances, unrecoveredLoss, pool);
  return { allocations: p.allocations, totalCents: p.totalCents, lossRecoveredCents: p.lossRecoveredCents, mode: "policy_waterfall", note: "Per the active policy waterfall." };
}

// ---- expense forecast ----
export interface ForecastMonth { month: string; lowCents: number; baseCents: number; highCents: number }
export interface Forecast { method: string; historyMonths: number; monthlyAverageCents: number; trendCentsPerMonth: number; months: ForecastMonth[]; liquidFundsCents: number; runwayMonths: number | null; outstandingLiabilitiesCents: number; budgetCents: number | null; note: string }
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const addMonth = (k: string, n: number) => { const [y, m] = k.split("-").map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
/** Forecast company expenses from paid history (cents by calendar month): trailing average with a damped linear trend and a spread band. */
export function forecastExpenses(paid: Array<{ paidAt: number; cents: number }>, now: number, horizon: number, liquid: number, liabilities: number, budgetCents: number | null): Forecast {
  const cur = monthKey(now), by = new Map<string, number>();
  for (const p of paid) { const k = monthKey(p.paidAt); if (k < cur) by.set(k, (by.get(k) ?? 0) + p.cents); }
  const keys = [...by.keys()].sort().slice(-6);
  // fill months with no spend inside the observed range so quiet months pull the average down honestly
  const series: number[] = []; if (keys.length) for (let k = keys[0]; k <= keys[keys.length - 1]; k = addMonth(k, 1)) series.push(by.get(k) ?? 0);
  const n = series.length, avg = n ? series.reduce((s, v) => s + v, 0) / n : 0;
  let slope = 0; if (n >= 3) { const xm = (n - 1) / 2; let num = 0, den = 0; series.forEach((y, x) => { num += (x - xm) * (y - avg); den += (x - xm) ** 2; }); slope = den ? num / den : 0; slope = Math.max(-avg * 0.25, Math.min(avg * 0.25, slope)); }
  const sd = n >= 2 ? Math.sqrt(series.reduce((s, v) => s + (v - avg) ** 2, 0) / (n - 1)) : 0;
  const months: ForecastMonth[] = []; let base0 = n ? avg : (budgetCents ?? 0);
  for (let i = 1; i <= horizon; i++) {
    const damp = n >= 3 ? slope * (1 + (n - 1) / 2) * (1 - 0.5 ** i) : 0, base = Math.max(0, Math.round(base0 + damp));
    months.push({ month: addMonth(cur, i), lowCents: Math.max(0, Math.round(base - sd)), baseCents: base, highCents: Math.round(base + sd) });
  }
  const monthly = months.length ? months[0].baseCents : 0;
  return { method: n >= 3 ? "trailing average with damped linear trend" : n >= 1 ? "trailing average (too little history for a trend)" : budgetCents ? "approved budget (no paid-expense history)" : "none (no history and no approved budget)", historyMonths: n,
    monthlyAverageCents: Math.round(avg), trendCentsPerMonth: Math.round(slope), months, liquidFundsCents: liquid, runwayMonths: monthly > 0 ? Math.round((liquid / monthly) * 10) / 10 : null,
    outstandingLiabilitiesCents: liabilities, budgetCents,
    note: n < 3 ? "Fewer than three months of paid expenses: treat this forecast as indicative." : "Estimate from past paid expenses. It is not a commitment and excludes one-off items." };
}

export const csvEscape = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const fmtUsd = usd;
