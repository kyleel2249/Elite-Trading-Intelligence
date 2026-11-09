/** Paper/testnet position tracking, exposure limits and strategy performance feedback. Never touches live accounts. */
import type { Kline } from "../market.ts";
import { round } from "./indicators.ts";

export interface PaperPosition {
  id: string; symbol: string; assetClass: "crypto" | "equity"; broker: "alpaca" | "binance"; mode: "paper" | "testnet"; qty: number; entry: number; stop: number; targets: number[]; openedAt: number; interval: string;
  strategyIds: string[]; classification: string; clientOrderId: string; brokerOrderId: string | null; status: "open" | "closed"; tp1Touched: boolean; exitPrice: number | null; exitAt: number | null; exitReason: "stop" | "tp2" | "time" | null; rMultiple: number | null; protection: "virtual_monitored";
}
/** Advances a position over candles after its open. Stop-first on same-bar conflicts; exit at TP2 or stop; TP1 touch is recorded. */
export function monitorPosition(p: PaperPosition, rows: Kline[], now: number, maxBars = 96): PaperPosition {
  if (p.status !== "open") return p; const risk = p.entry - p.stop; if (!(risk > 0)) return p;
  const after = rows.filter(r => r[0] > p.openedAt); let tp1 = p.tp1Touched;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (b[3] <= p.stop) return close(p, p.stop, b[0], "stop", tp1);
    if (b[2] >= p.targets[0]) tp1 = true;
    if (b[2] >= p.targets[1]) return close(p, p.targets[1], b[0], "tp2", tp1);
    if (i + 1 >= maxBars) return close(p, b[4], b[0], "time", tp1);
  }
  return { ...p, tp1Touched: tp1 };
}
const close = (p: PaperPosition, price: number, at: number, reason: "stop" | "tp2" | "time", tp1: boolean): PaperPosition => ({ ...p, status: "closed", exitPrice: price, exitAt: at, exitReason: reason, tp1Touched: tp1, rMultiple: round((price - p.entry) / (p.entry - p.stop), 2) });
export interface ExposureLimits { maxPositions: number; maxNotionalPctPerPosition: number; maxTotalNotionalPct: number; maxPerClassPct: number }
export const DEFAULT_LIMITS: ExposureLimits = { maxPositions: 5, maxNotionalPctPerPosition: 20, maxTotalNotionalPct: 60, maxPerClassPct: 40 };
export function exposureOf(open: PaperPosition[], equity: number) {
  const n = open.reduce((a, p) => a + p.qty * p.entry, 0), by: Record<string, number> = {}; open.forEach(p => { by[p.assetClass] = (by[p.assetClass] || 0) + p.qty * p.entry; });
  return { positions: open.length, notional: round(n, 2), pctOfEquity: equity > 0 ? round(n / equity * 100, 1) : null, byClassPct: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, equity > 0 ? round(v / equity * 100, 1) : null])) };
}
export function checkExposure(open: PaperPosition[], add: { symbol: string; assetClass: string; notional: number }, equity: number, lim: ExposureLimits = DEFAULT_LIMITS): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [], total = open.reduce((a, p) => a + p.qty * p.entry, 0), cls = open.filter(p => p.assetClass === add.assetClass).reduce((a, p) => a + p.qty * p.entry, 0);
  if (open.length >= lim.maxPositions) reasons.push("max " + lim.maxPositions + " open positions reached");
  if (open.some(p => p.symbol === add.symbol)) reasons.push("already holding " + add.symbol);
  if (add.notional > equity * lim.maxNotionalPctPerPosition / 100 + 1e-9) reasons.push("position notional exceeds " + lim.maxNotionalPctPerPosition + "% of equity");
  if (total + add.notional > equity * lim.maxTotalNotionalPct / 100 + 1e-9) reasons.push("total exposure would exceed " + lim.maxTotalNotionalPct + "% of equity");
  if (cls + add.notional > equity * lim.maxPerClassPct / 100 + 1e-9) reasons.push(add.assetClass + " exposure would exceed " + lim.maxPerClassPct + "% of equity");
  return { ok: reasons.length === 0, reasons };
}
export interface StrategyPerf { strategyId: string; n: number; wins: number; sumR: number }
export function recordOutcome(perf: Record<string, StrategyPerf>, p: PaperPosition): Record<string, StrategyPerf> {
  if (p.status !== "closed" || p.rMultiple === null) return perf; const next = { ...perf };
  for (const id of p.strategyIds.length ? p.strategyIds : ["unattributed"]) { const c = next[id] ?? { strategyId: id, n: 0, wins: 0, sumR: 0 }; next[id] = { ...c, n: c.n + 1, wins: c.wins + (p.rMultiple > 0 ? 1 : 0), sumR: round(c.sumR + p.rMultiple, 2) }; }
  return next;
}
