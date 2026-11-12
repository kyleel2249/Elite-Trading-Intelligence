// Outcome ledger: turns tradeable Precision signals into measured results, which is the only honest source of calibration
// and expectancy. Pure and deterministic: given a recorded signal and later candles it decides open / not filled / resolved.
//
// Definitions (fixed, so every recorded outcome means the same thing):
//  * A signal is a limit order at its entry price, live until it expires. It is "filled" by the first CLOSED candle after the
//    signal time whose range contains the entry. No candle touching the entry before expiry means "not_filled" (excluded).
//  * After the fill the position is walked bar by bar with the same engine as the backtest and paper trader (worker/algo/trade-walk.ts):
//    stop tested first on every bar, 40/30/30 partials, break-even after TP1, ATR trail after TP2, time stop after MAX_HOLD_BARS.
//    Processing starts on the bar AFTER the fill bar, so intrabar order inside the fill bar is never guessed.
//  * Result is realised R minus the signal's own round-trip cost in R. A win is a net result above zero.
// No candle that was not closed at the time of resolution is ever used.
import { TF_SECONDS, type Strategy, type Timeframe } from "../algo/timeframes.ts";
import { walkPosition } from "../algo/trade-walk.ts";
import type { Kline } from "../market.ts";
import type { PrecisionSignal } from "./types.ts";
import { isFiniteNumber, isRecord, round } from "./util.ts";

export const MAX_HOLD_BARS = 48;
export const MAX_OPEN = 100;
export const MAX_OUTCOMES = 5000;

export interface LedgerEntry {
  id: string; symbol: string; strategy: Strategy; timeframe: Timeframe; dir: 1 | -1;
  entry: number; stop: number; targets: [number, number, number | null];
  costInR: number; score: number; configHash: string; engineVersion: string;
  createdAt: number; expiresAt: number;
}
export type OutcomeStatus = "resolved" | "not_filled" | "void";
export interface LedgerOutcome {
  id: string; symbol: string; strategy: Strategy; score: number; configHash: string;
  status: OutcomeStatus; netR: number | null; win: boolean | null; reason: string;
  createdAt: number; closedAt: number;
}

/** Record a signal only when it is a tradeable BUY/SELL with a complete plan. */
export function entryFromSignal(s: PrecisionSignal): LedgerEntry | null {
  if (!s.decision.tradeable || (s.direction !== "BUY" && s.direction !== "SELL")) return null;
  if (s.entry === null || s.stopLoss === null || s.expiresAt === null || s.opportunityScore.value === null || s.transactionCosts === null) return null;
  const tp = (label: string) => s.takeProfits.find(t => t.label === label)?.price ?? null;
  const t1 = tp("TP1"), t2 = tp("TP2");
  const created = Date.parse(s.dataTimestamp), expires = Date.parse(s.expiresAt);
  if (t1 === null || t2 === null || !Number.isFinite(created) || !Number.isFinite(expires)) return null;
  return {
    id: s.signalId, symbol: s.ticker, strategy: s.strategy, timeframe: s.setupTimeframe, dir: s.direction === "BUY" ? 1 : -1,
    entry: s.entry, stop: s.stopLoss, targets: [t1, t2, tp("TP3")], costInR: s.transactionCosts.costInR, score: s.opportunityScore.value,
    configHash: s.opportunityScore.configHash, engineVersion: s.engine.version, createdAt: created, expiresAt: expires,
  };
}

export type Resolution = { state: "open" } | { state: "done"; outcome: LedgerOutcome };

/** Decide what the closed candles say about a recorded signal. `rows` must be ascending; a forming last candle is ignored. */
export function resolveEntry(e: LedgerEntry, rowsIn: Kline[], now: number): Resolution {
  const barMs = TF_SECONDS[e.timeframe] * 1000;
  const done = (status: OutcomeStatus, reason: string, netR: number | null, closedAt: number): Resolution => ({
    state: "done", outcome: { id: e.id, symbol: e.symbol, strategy: e.strategy, score: e.score, configHash: e.configHash, status, netR: netR === null ? null : round(netR, 3), win: netR === null ? null : netR > 0, reason, createdAt: e.createdAt, closedAt },
  });
  const rows = rowsIn.filter(r => isFiniteNumber(r[0]) && r[0] + barMs <= now); // closed candles only
  if (!rows.length) return { state: "open" };
  if (rows[0][0] > e.createdAt + barMs) return done("void", "Candle history no longer reaches back to the signal time", null, now);
  const first = rows.findIndex(r => r[0] >= e.createdAt);
  if (first < 0) return { state: "open" };

  let fill = -1;
  for (let i = first; i < rows.length && rows[i][0] <= e.expiresAt; i++) if (rows[i][3] <= e.entry && e.entry <= rows[i][2]) { fill = i; break; }
  if (fill < 0) {
    const sawAllUntilExpiry = rows[rows.length - 1][0] + barMs > e.expiresAt;
    return sawAllUntilExpiry ? done("not_filled", "Price never traded at the entry before the signal expired", null, Math.min(now, e.expiresAt)) : { state: "open" };
  }
  const endIdx = rows.length - 1, from = fill + 1;
  if (from > endIdx) return { state: "open" };
  const dist = Math.abs(e.entry - e.stop);
  if (!(dist > 0)) return done("void", "Invalid stop distance", null, now);
  const last = Math.min(fill + MAX_HOLD_BARS, endIdx);
  const t3 = e.targets[2] ?? e.entry + e.dir * dist * 1e6; // no justified TP3: the last 30% is only managed by the trail and the time stop
  const res = walkPosition(rows, from, last, e.dir, e.entry, e.stop, [e.targets[0], e.targets[1], t3], e.costInR * dist, endIdx);
  if (!res) return { state: "open" };
  if (res.reason === "end" && last !== fill + MAX_HOLD_BARS) return { state: "open" };
  return done("resolved", `${res.reason}, ${res.targetsHit} target(s) hit`, res.realizedR - e.costInR, rows[res.exitIdx][0] + barMs);
}

export const resolved = (o: LedgerOutcome[]) => o.filter(x => x.status === "resolved" && x.netR !== null && x.win !== null);

/** Mean net R with a seeded bootstrap interval, or null below the minimum sample. A positive claim needs the whole interval above zero. */
export function expectancyOf(netR: number[], minSamples: number, seed = 11): { meanR: number; low95: number; high95: number; samples: number } | null {
  if (netR.length < minSamples) return null;
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = netR.length, means: number[] = [];
  for (let i = 0; i < 2000; i++) { let sum = 0; for (let j = 0; j < n; j++) sum += netR[(rnd() * n) | 0]; means.push(sum / n); }
  means.sort((a, b) => a - b);
  return { meanR: netR.reduce((a, b) => a + b, 0) / n, low95: means[Math.floor(0.025 * 2000)], high95: means[Math.floor(0.975 * 2000) - 1], samples: n };
}

export const parseEntries = (raw: unknown): LedgerEntry[] => (Array.isArray(raw) ? raw.filter(isLedgerEntry).slice(0, MAX_OPEN) : []);
export const parseOutcomes = (raw: unknown): LedgerOutcome[] => (Array.isArray(raw) ? raw.filter(isLedgerOutcome).slice(-MAX_OUTCOMES) : []);
function isLedgerEntry(x: unknown): x is LedgerEntry {
  return isRecord(x) && typeof x.id === "string" && typeof x.symbol === "string" && typeof x.strategy === "string" && typeof x.timeframe === "string" && (x.dir === 1 || x.dir === -1)
    && [x.entry, x.stop, x.costInR, x.score, x.createdAt, x.expiresAt].every(isFiniteNumber) && Array.isArray(x.targets) && x.targets.length === 3 && typeof x.configHash === "string" && x.timeframe in TF_SECONDS;
}
function isLedgerOutcome(x: unknown): x is LedgerOutcome {
  return isRecord(x) && typeof x.id === "string" && typeof x.strategy === "string" && isFiniteNumber(x.score) && isFiniteNumber(x.createdAt) && isFiniteNumber(x.closedAt) && typeof x.configHash === "string"
    && (x.status === "resolved" || x.status === "not_filled" || x.status === "void") && (x.netR === null || isFiniteNumber(x.netR)) && (x.win === null || typeof x.win === "boolean");
}
