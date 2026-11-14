// Account-level risk input for the Precision engine, taken from ETI's internal paper account (the only account ETI itself keeps).
// It mirrors the paper engine's own entry limits so a signal is not presented as actionable while the account could not take it:
// kill switch, open position on the symbol, open-position cap, daily loss limit, consecutive-loss pause and stop-out cooldown.
// It reads state only (never writes). With no stored account the gate stays "not_evaluated"; nothing is assumed. It says nothing
// about an exchange or broker account: those are only checked by the server-side preflight when an order is actually submitted.
import { DEFAULT_PAPER_CONFIG, KVPaperStore, type PaperConfig, type PaperState } from "../algo/paper.ts";
import { paperConfigFrom } from "../algo/paper-api.ts";
import type { RiskContext } from "../algo/validation.ts";
import type { PrecisionEnv } from "./stores.ts";

export function evaluatePaperAccount(state: PaperState, cfg: PaperConfig, symbol: string, now: number): RiskContext {
  const reasons: string[] = [];
  if (state.killSwitch) reasons.push("Kill switch is engaged on the internal paper account");
  if (state.positions.some(p => p.symbol === symbol)) reasons.push(`A paper position is already open on ${symbol}`);
  if (state.positions.length >= cfg.maxOpenPositions) reasons.push(`Open-position cap reached (${state.positions.length}/${cfg.maxOpenPositions})`);
  const sameDay = state.dayKey === new Date(now).toISOString().slice(0, 10);
  if (sameDay && state.dayStartEquity > 0) {
    const pct = (state.equity - state.dayStartEquity) / state.dayStartEquity * 100;
    if (pct <= -cfg.maxDailyLossPct) reasons.push(`Daily loss limit reached (${pct.toFixed(2)}% against a ${cfg.maxDailyLossPct}% limit)`);
  }
  const tail = state.closed.slice(-cfg.maxConsecutiveLosses);
  if (tail.length === cfg.maxConsecutiveLosses && tail.every(t => t.pnl < 0) && now - tail[tail.length - 1].closedAt < cfg.lossPauseMs) {
    reasons.push(`${cfg.maxConsecutiveLosses} consecutive losses: new entries are paused until ${new Date(tail[tail.length - 1].closedAt + cfg.lossPauseMs).toISOString()}`);
  }
  const last = state.lastStopOut[symbol];
  if (last !== undefined && now - last < cfg.reentryCooldownMs) reasons.push(`Re-entry cooldown after a stop-out on ${symbol}`);
  return { withinLimits: reasons.length === 0, reasons };
}

/** null when no paper account is stored or readable (the account-risk gate then reports "not evaluated"). */
export async function paperAccountRisk(env: PrecisionEnv & Record<string, unknown>, symbol: string, now: number): Promise<RiskContext | null> {
  const kv = (env as { ETI_EXECUTION_LOG?: unknown }).ETI_EXECUTION_LOG as ConstructorParameters<typeof KVPaperStore>[0] | undefined;
  if (!kv) return null;
  let state: PaperState | null = null;
  try { state = await new KVPaperStore(kv).load(); } catch { return null; }
  if (!state || !Array.isArray(state.positions) || !Array.isArray(state.closed) || typeof state.equity !== "number") return null;
  return evaluatePaperAccount(state, { ...DEFAULT_PAPER_CONFIG, ...paperConfigFrom(env as any) }, symbol, now);
}
