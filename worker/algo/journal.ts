// Signal journal: a persistent, queryable record of what ETI decided and what happened next, including HOLD and REJECTED.
// Analytical only: it records decisions and hypothetical outcomes; it never places or modifies an order.
//
// Storage (KV, key `algo:journal:<reversed bucket>:<symbol>:<strategy>`): newest-first listing, one entry per symbol, strategy and
// execution candle (the first look in a candle is kept). A compact summary lives in KV metadata so listing needs no per-entry reads.
// Recording from the public signal routes is OPT-IN (ETI_JOURNAL_ENABLED=true) because KV writes are limited.
import type { Kline } from "../market.ts";
import type { FinalDecision, OmnisignalResult } from "./omnisignal.ts";
import { EXECUTION_TF, TF_SECONDS, type Strategy } from "./timeframes.ts";
import { MIN_SAMPLE } from "./performance.ts";
import { walkPosition } from "./trade-walk.ts";
import { kvOf, type KV } from "./kv.ts";

export const JOURNAL_TTL_S = 90 * 86_400, MAX_HOLD_BARS = 100;
export type OutcomeStatus = "not_applicable" | "pending" | "no_fill_expired" | "no_fill_invalidated" | "no_fill_missed_move" | "win" | "loss" | "breakeven" | "unresolvable";
export interface Resolution { status: OutcomeStatus; filled?: boolean; r?: number; targetsHit?: number; resolvedAt?: number; granularity?: string; note?: string }
export interface JournalEntry {
  id: string; ts: number; bucket: number; symbol: string; strategy: Strategy; decision: FinalDecision; classification: string; direction: "LONG" | "SHORT" | null;
  price: number | null; entryZone: [number, number] | null; stopLoss: number | null; takeProfits: number[] | null; riskRewardToTP3: number | null; confidence: number; validationScore: number | null;
  regime: string | null; agreement: string | null; engines: { swift: string; gainz: string }; hardFailures: string[]; reasons: string[];
  expectancy: { status: string; expectancyR: number | null; samples: number | null } | null; expiresAt: string | null; resolution: Resolution;
}
interface Summary { id: string; s: string; st: string; d: string; cl: string; cf: number; ts: number; o: OutcomeStatus; r?: number; x?: string }   // x = regime
const isActionable = (d: FinalDecision) => d === "BUY" || d === "SELL";
const REV = 9e12;
export const keyOf = (bucket: number, symbol: string, strategy: string) => `algo:journal:${String(REV - bucket).padStart(14, "0")}:${symbol}:${strategy}`;
export const idOf = (symbol: string, strategy: string, bucket: number) => `${symbol}:${strategy}:${bucket}`;
export function keyFromId(id: string): string | null { const m = /^([A-Z0-9]{5,20}):(scalp|intraday|swing|position):(\d{10,14})$/.exec(id); return m ? keyOf(Number(m[3]), m[1], m[2]) : null; }
const summaryOf = (e: JournalEntry): Summary => ({ id: e.id, s: e.symbol, st: e.strategy, d: e.decision, cl: e.classification, cf: e.confidence, ts: e.ts, o: e.resolution.status, ...(e.resolution.r !== undefined ? { r: Math.round(e.resolution.r * 100) / 100 } : {}), ...(e.regime ? { x: e.regime.slice(0, 24) } : {}) });

export function entryFromResult(r: OmnisignalResult, strategy: Strategy, now: number, expectancy: JournalEntry["expectancy"] = null): JournalEntry {
  const ms = TF_SECONDS[EXECUTION_TF[strategy]] * 1000, bucket = Math.floor(now / ms) * ms, act = isActionable(r.decision);
  const price = act && r.entryZone ? Math.round((r.entryZone[0] + r.entryZone[1]) / 2 * 1e8) / 1e8 : null;   // the plan's entry level
  return { id: idOf(r.symbol, strategy, bucket), ts: Date.parse(r.generatedAt) || now, bucket, symbol: r.symbol, strategy, decision: r.decision, classification: r.validation?.classification ?? (r.decision === "DATA_UNRELIABLE" ? "REJECTED" : "HOLD"),
    direction: act ? (r.decision === "BUY" ? "LONG" : "SHORT") : null, price, entryZone: act ? r.entryZone : null, stopLoss: act ? r.stopLoss : null, takeProfits: act && r.takeProfits ? r.takeProfits.map(t => t.price) : null,
    riskRewardToTP3: act ? r.riskRewardToTP3 : null, confidence: r.confidence, validationScore: r.validation ? Math.round(r.validation.score * 10) / 10 : null, regime: (r.fusion.swift as { regime?: string }).regime ?? null,
    agreement: r.fusion.agreement, engines: { swift: r.fusion.swift.status, gainz: r.fusion.gainz.status }, hardFailures: (r.validation?.hardFailures ?? []).slice(0, 8), reasons: r.reasons.slice(0, 8), expectancy, expiresAt: act ? r.expiresAt : null,
    resolution: { status: act ? "pending" : "not_applicable" } };
}

export async function recordEntry(kv: KV, e: JournalEntry): Promise<"recorded" | "duplicate"> {
  const key = keyOf(e.bucket, e.symbol, e.strategy);
  if (await kv.get(key) !== null) return "duplicate";
  await kv.put(key, JSON.stringify(e), { expirationTtl: JOURNAL_TTL_S, metadata: summaryOf(e) });
  return "recorded";
}
/** Best-effort recording from a signal route. Opt-in; never throws; never affects the response. */
export async function journalFromRoute(env: unknown, r: OmnisignalResult, strategy: Strategy, now: number, expectancy: JournalEntry["expectancy"] = null): Promise<"disabled" | "not_configured" | "recorded" | "duplicate" | "error"> {
  if ((env as { ETI_JOURNAL_ENABLED?: string } | null)?.ETI_JOURNAL_ENABLED !== "true") return "disabled";
  const kv = kvOf(env); if (!kv) return "not_configured";
  try { return await recordEntry(kv, entryFromResult(r, strategy, now, expectancy)); } catch { return "error"; }
}
export async function getEntry(kv: KV, id: string): Promise<JournalEntry | null> {
  const k = keyFromId(id); if (!k) return null;
  const raw = await kv.get(k); if (!raw) return null;
  try { return JSON.parse(raw) as JournalEntry; } catch { return null; }
}
export async function updateResolution(kv: KV, e: JournalEntry, res: Resolution): Promise<void> {
  const next = { ...e, resolution: res };
  await kv.put(keyOf(e.bucket, e.symbol, e.strategy), JSON.stringify(next), { expirationTtl: JOURNAL_TTL_S, metadata: summaryOf(next) });
}

export interface ListFilter { symbol?: string; strategy?: string; decision?: string; outcome?: string; limit?: number; cursor?: string }
export interface ListedEntry { id: string; symbol: string; strategy: string; decision: string; classification: string; confidence: number; ts: number; outcome: OutcomeStatus; r: number | null; regime: string | null }
export async function listEntries(kv: KV, f: ListFilter = {}): Promise<{ entries: ListedEntry[]; cursor: string | null; scanned: number; truncated: boolean } | null> {
  if (!kv.list) return null;
  const limit = Math.max(1, Math.min(f.limit ?? 50, 100)), page = await kv.list({ prefix: "algo:journal:", limit: 250, cursor: f.cursor });
  const out: ListedEntry[] = [];
  for (const k of page.keys) {
    const m = k.metadata as Summary | undefined; if (!m) continue;
    if ((f.symbol && m.s !== f.symbol) || (f.strategy && m.st !== f.strategy) || (f.decision && m.d !== f.decision) || (f.outcome && m.o !== f.outcome)) continue;
    out.push({ id: m.id, symbol: m.s, strategy: m.st, decision: m.d, classification: m.cl, confidence: m.cf, ts: m.ts, outcome: m.o, r: m.r ?? null, regime: m.x ?? null });
    if (out.length >= limit) break;
  }
  const more = page.list_complete === false && !!page.cursor;
  return { entries: out, cursor: more ? page.cursor! : null, scanned: page.keys.length, truncated: out.length >= limit && more };
}

export interface JournalStats {
  scanned: number; truncated: boolean; byDecision: Record<string, number>; byClassification: Record<string, number>; byOutcome: Record<string, number>;
  actionable: { total: number; resolved: number; filled: number; wins: number; losses: number; breakeven: number; noFill: number; missedMoves: number; expired: number };
  /** Rates are withheld below the same minimum sample the performance layer uses. */
  rates: { status: "ok" | "insufficient_sample"; fillRate: number | null; winRateOfFilled: number | null; avgR: number | null; falsePositiveRate: number | null; minSample: number };
  byClassificationOutcome: Record<string, { filled: number; wins: number; losses: number }>;
  note: string;
}
export async function statsFor(kv: KV, sinceMs: number | null = null): Promise<JournalStats | null> {
  if (!kv.list) return null;
  const page = await kv.list({ prefix: "algo:journal:", limit: 1000 }), inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  const byDecision: Record<string, number> = {}, byClassification: Record<string, number> = {}, byOutcome: Record<string, number> = {}, byCO: JournalStats["byClassificationOutcome"] = {};
  const a = { total: 0, resolved: 0, filled: 0, wins: 0, losses: 0, breakeven: 0, noFill: 0, missedMoves: 0, expired: 0 }; let rSum = 0, rN = 0, scanned = 0;
  for (const k of page.keys) {
    const m = k.metadata as Summary | undefined; if (!m || (sinceMs !== null && m.ts < sinceMs)) continue;
    scanned++; inc(byDecision, m.d); inc(byClassification, m.cl); inc(byOutcome, m.o);
    if (m.d !== "BUY" && m.d !== "SELL") continue;
    a.total++;
    if (m.o === "pending" || m.o === "unresolvable") continue;
    a.resolved++;
    const cell = (byCO[m.cl] ??= { filled: 0, wins: 0, losses: 0 });
    if (m.o === "win" || m.o === "loss" || m.o === "breakeven") { a.filled++; cell.filled++; rSum += m.r ?? 0; rN++; if (m.o === "win") { a.wins++; cell.wins++; } else if (m.o === "loss") { a.losses++; cell.losses++; } else a.breakeven++; }
    else { a.noFill++; if (m.o === "no_fill_missed_move") a.missedMoves++; if (m.o === "no_fill_expired") a.expired++; }
  }
  const ok = a.resolved >= MIN_SAMPLE;
  return { scanned, truncated: page.list_complete === false, byDecision, byClassification, byOutcome, actionable: a, byClassificationOutcome: byCO,
    rates: { status: ok ? "ok" : "insufficient_sample", minSample: MIN_SAMPLE, fillRate: ok ? a.filled / a.resolved : null, winRateOfFilled: ok && a.filled ? a.wins / a.filled : null, avgR: ok && rN ? rSum / rN : null, falsePositiveRate: ok && a.filled ? a.losses / a.filled : null },
    note: "Hypothetical signal outcomes: gross of fees, fills assumed at the worst price inside the entry zone, stop tested first on every bar. They are not trades, not paper results and not live results." };
}

/**
 * Resolve a pending actionable entry against closed bars (ascending). Pure.
 * Fill: a bar trades inside the entry zone (worst price in the zone assumed). A bar touching both zone and stop is a fill then a stop.
 * Never filled: expired after expiresAt, invalidated if the stop level trades first, or a missed move if TP1 trades without the zone.
 */
export function evaluateOutcome(e: JournalEntry, bars: Kline[], barMs: number, now: number): Resolution {
  if (!e.direction || !e.entryZone || e.stopLoss === null || !e.takeProfits || e.takeProfits.length < 3) return { status: "not_applicable" };
  const dir: 1 | -1 = e.direction === "LONG" ? 1 : -1, [lo, hi] = e.entryZone, stop = e.stopLoss, tps = e.takeProfits as [number, number, number], gran = `${Math.round(barMs / 60000)}m bars`;
  const expiry = e.expiresAt ? Date.parse(e.expiresAt) : e.ts + 8 * barMs, closed = bars.filter(b => b[0] + barMs <= now);
  const start = closed.findIndex(b => b[0] >= e.ts);
  if (start < 0) return now >= expiry + barMs ? { status: "unresolvable", filled: false, granularity: gran, note: "no closed bars after the signal were available", resolvedAt: now } : { status: "pending" };
  if (closed[start][0] > e.ts + 2 * barMs) return { status: "unresolvable", filled: false, granularity: gran, note: "bar history does not reach back to the signal", resolvedAt: now };
  const fill = dir > 0 ? hi : lo, valid = dir > 0 ? tps[0] > fill && stop < fill : tps[0] < fill && stop > fill;
  if (!valid) return { status: "unresolvable", filled: false, granularity: gran, note: "entry, stop and targets are inconsistent", resolvedAt: now };
  for (let j = start; j < closed.length; j++) {
    const [t, , h, l] = closed[j];
    if (t >= expiry) break;
    if (l <= hi && h >= lo) {   // traded inside the zone: filled
      const last = Math.min(closed.length - 1, j + MAX_HOLD_BARS), w = walkPosition(closed, j, last, dir, fill, stop, tps, 0, closed.length - 1);
      if (!w) return { status: "unresolvable", filled: true, granularity: gran, note: "degenerate risk distance", resolvedAt: now };
      if (w.reason === "end" && last === closed.length - 1 && j + MAX_HOLD_BARS > closed.length - 1) return { status: "pending", filled: true, granularity: gran };
      return { status: w.realizedR > 0.05 ? "win" : w.realizedR < -0.05 ? "loss" : "breakeven", filled: true, r: Math.round(w.realizedR * 1000) / 1000, targetsHit: w.targetsHit, resolvedAt: now, granularity: gran, note: `exit: ${w.reason}` };
    }
    if (dir > 0 ? l <= stop : h >= stop) return { status: "no_fill_invalidated", filled: false, resolvedAt: now, granularity: gran, note: "stop level traded before the entry zone" };
    if (dir > 0 ? h >= tps[0] : l <= tps[0]) return { status: "no_fill_missed_move", filled: false, resolvedAt: now, granularity: gran, note: "TP1 traded without the entry zone being touched" };
  }
  return now >= expiry ? { status: "no_fill_expired", filled: false, resolvedAt: now, granularity: gran } : { status: "pending" };
}
