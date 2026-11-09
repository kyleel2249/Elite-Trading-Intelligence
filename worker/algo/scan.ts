// Opportunity scanner + leaderboard (analytical, read-only). Ranks symbols by evidence quality, never by predicted profit.
// Each symbol costs about 10 subrequests, so a request is capped to stay inside Workers free-plan limits.
import type { MarketEnv } from "../market.ts";
import type { Strategy } from "./timeframes.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { activeOptions } from "./params.ts";
import { costBpsFrom, runOmnisignal, type FinalDecision, type OmnisignalResult } from "./omnisignal.ts";

export const MAX_SCAN_SYMBOLS = 4;
export interface ScanRow { rank: number | null; symbol: string; decision: FinalDecision | "ERROR"; direction: "LONG" | "SHORT" | null; opportunityScore: number | null; validationScore: number | null; confidence: number; riskRewardToTP3: number | null; agreement: string | null; liquidity: string | null; entryZone: [number, number] | null; stopLoss: number | null; reason: string }
const TIER: Record<string, number> = { BUY: 0, SELL: 0, HOLD: 1, REJECTED: 2, DATA_UNRELIABLE: 3, ERROR: 4 };

/** Opportunity score (0-100): 60% validator score, 25% capped reward/risk to TP3 (3R = full marks), 15% liquidity. It ranks evidence quality only. */
export function opportunityScore(r: Pick<OmnisignalResult, "validation" | "riskRewardToTP3" | "liquidity">): number | null {
  if (!r.validation) return null;
  const rr = Math.min(Math.max(r.riskRewardToTP3 ?? 0, 0), 3) / 3 * 100, liq = r.liquidity?.status === "ok" ? 100 : r.liquidity ? 40 : 0;
  return Math.round((r.validation.score * 0.6 + rr * 0.25 + liq * 0.15) * 10) / 10;
}
export function rowOf(symbol: string, r: OmnisignalResult): ScanRow {
  const act = r.decision === "BUY" || r.decision === "SELL";
  return { rank: null, symbol, decision: r.decision, direction: act ? (r.decision === "BUY" ? "LONG" : "SHORT") : null, opportunityScore: act ? opportunityScore(r) : null, validationScore: r.validation ? Math.round(r.validation.score * 10) / 10 : null,
    confidence: r.confidence, riskRewardToTP3: act ? r.riskRewardToTP3 : null, agreement: r.fusion.agreement, liquidity: r.liquidity?.status ?? null, entryZone: act ? r.entryZone : null, stopLoss: act ? r.stopLoss : null, reason: (r.reasons[0] ?? "") };
}
export function rankRows(rows: ScanRow[]): ScanRow[] {
  const sorted = [...rows].sort((a, b) => TIER[a.decision] - TIER[b.decision] || (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1) || (b.validationScore ?? -1) - (a.validationScore ?? -1) || a.symbol.localeCompare(b.symbol));
  let n = 0; return sorted.map(r => ({ ...r, rank: r.decision === "BUY" || r.decision === "SELL" ? ++n : null }));
}
export function parseSymbols(raw: string | null): { symbols: string[]; ignored: string[] } {
  const all = [...new Set((raw ?? "").toUpperCase().split(",").map(s => s.trim()).filter(Boolean))], good = all.filter(s => /^[A-Z0-9]{5,20}$/.test(s));
  return { symbols: good.slice(0, MAX_SCAN_SYMBOLS), ignored: [...all.filter(s => !good.includes(s)), ...good.slice(MAX_SCAN_SYMBOLS)] };
}
export async function scan(env: MarketEnv, symbols: string[], strategy: Strategy, now: number = Date.now()): Promise<ScanRow[]> {
  const rows: ScanRow[] = [], { version: _v, name: _n, ...opts } = await activeOptions((env as any).ETI_EXECUTION_LOG, () => now);
  for (const symbol of symbols) { // sequential on purpose: bounded subrequest burst, and one failing symbol never aborts the scan
    try {
      const inp = await loadSignalInputs(env, symbol, strategy, null, now);
      if ("error" in inp) { rows.push({ ...rowOf(symbol, { decision: "DATA_UNRELIABLE", validation: null, liquidity: null, riskRewardToTP3: null, confidence: 0, fusion: { agreement: null }, entryZone: null, stopLoss: null, reasons: [`Market data unavailable (${inp.error})`] } as unknown as OmnisignalResult) }); continue; }
      rows.push(rowOf(symbol, runOmnisignal({ symbol, strategy, candles: inp.candles, depth: inp.depth, now }, { ...opts, roundTripCostBps: costBpsFrom(env as any) })));
    } catch (e) { rows.push({ ...rowOf(symbol, { decision: "DATA_UNRELIABLE", validation: null, liquidity: null, riskRewardToTP3: null, confidence: 0, fusion: { agreement: null }, entryZone: null, stopLoss: null, reasons: [] } as unknown as OmnisignalResult), decision: "ERROR", reason: e instanceof Error ? e.message : "unknown error" }); }
  }
  return rankRows(rows);
}
