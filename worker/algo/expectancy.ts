// Validated-expectancy store. The independent validator treats expectancy as UNPROVEN (null) until evidence exists, and
// caps conviction while it is unproven. This store is how measured evidence reaches the live signal routes.
//
// Hard rules (enforced on write AND on read):
//   * only evidence from a replay of the real engine chain or from recorded paper trades is accepted (never the parametric screen);
//   * at least MIN_SAMPLE closed trades;
//   * evidence expires after MAX_AGE_MS; an expired record means "unproven" again, never "still positive";
//   * a POSITIVE claim needs a bootstrap 95% interval whose lower bound is above zero; positive-but-indistinguishable-from-zero stays unproven;
//   * a non-positive point estimate is passed through as negative (the validator then refuses the setup). Blocking is the safe direction.
//   * when several sources exist the most conservative (lowest) expectancy wins.
import type { Strategy } from "./timeframes.ts";
import { DEFAULT_WEIGHTS } from "./timeframes.ts";
import { MIN_SAMPLE, type ClosedTrade } from "./performance.ts";
import { bootstrapMeanR } from "./replay.ts";
import { kvOf, type KV } from "./kv.ts";

export type ExpectancySource = "replay" | "paper";
export const SOURCES: ExpectancySource[] = ["replay", "paper"];
export const MAX_AGE_MS = 30 * 86_400_000, MAX_ABS_R = 10;
const STRATEGY_LIST = Object.keys(DEFAULT_WEIGHTS) as Strategy[];
export interface ExpectancyRecord { strategy: Strategy; symbol: string; source: ExpectancySource; expectancyR: number; samples: number; ciLow95?: number; ciHigh95?: number; periodStart?: number; periodEnd?: number; measuredAt: number; note?: string }
export type ExpectancyStatus = "validated" | "negative" | "unproven";
export interface ExpectancyLookup { status: ExpectancyStatus; expectancyR: number | null; samples: number | null; sources: { source: ExpectancySource; scope: string; status: ExpectancyStatus; expectancyR: number; samples: number; ageDays: number; reason: string }[]; reasons: string[] }

/** Validate and normalise a record. measuredAt is the end of the evidence period (or now); it is never taken from the client beyond that. */
export function checkRecord(x: unknown, now: number): { ok: true; record: ExpectancyRecord } | { ok: false; errors: string[] } {
  const e: string[] = [], o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>, num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (!STRATEGY_LIST.includes(o.strategy as Strategy)) e.push(`strategy must be one of ${STRATEGY_LIST.join(", ")}`);
  const symbol = o.symbol === undefined ? "*" : String(o.symbol).toUpperCase();
  if (symbol !== "*" && !/^[A-Z0-9]{5,20}$/.test(symbol)) e.push("symbol must be a valid symbol or *");
  if (!SOURCES.includes(o.source as ExpectancySource)) e.push("source must be 'replay' or 'paper': the parametric screen and manual claims cannot validate the live engines");
  const exp = num(o.expectancyR), samples = num(o.samples);
  if (exp === null || Math.abs(exp) > MAX_ABS_R) e.push(`expectancyR must be a finite number within +/-${MAX_ABS_R}`);
  if (samples === null || !Number.isInteger(samples) || samples < MIN_SAMPLE) e.push(`samples must be an integer >= ${MIN_SAMPLE} (the minimum sample the performance layer requires)`);
  const lo = o.ciLow95 === undefined ? undefined : num(o.ciLow95), hi = o.ciHigh95 === undefined ? undefined : num(o.ciHigh95);
  if (lo === null || hi === null) e.push("ciLow95/ciHigh95 must be finite numbers when provided");
  else if (exp !== null && ((lo !== undefined && lo > exp + 1e-9) || (hi !== undefined && hi < exp - 1e-9))) e.push("the confidence interval must contain the point estimate");
  const pe = o.periodEnd === undefined ? undefined : num(o.periodEnd), ps = o.periodStart === undefined ? undefined : num(o.periodStart);
  if (pe === null || ps === null) e.push("periodStart/periodEnd must be epoch milliseconds when provided");
  const measuredAt = pe !== undefined && pe !== null ? pe : now;
  if (measuredAt > now + 60_000) e.push("periodEnd is in the future");
  else if (now - measuredAt > MAX_AGE_MS) e.push(`evidence is older than ${MAX_AGE_MS / 86_400_000} days and would be stale on arrival`);
  if (ps !== undefined && ps !== null && pe !== undefined && pe !== null && ps >= pe) e.push("periodStart must be before periodEnd");
  if (e.length) return { ok: false, errors: e };
  return { ok: true, record: { strategy: o.strategy as Strategy, symbol, source: o.source as ExpectancySource, expectancyR: exp!, samples: samples!, ...(lo !== undefined ? { ciLow95: lo! } : {}), ...(hi !== undefined ? { ciHigh95: hi! } : {}), ...(ps != null ? { periodStart: ps } : {}), ...(pe != null ? { periodEnd: pe } : {}), measuredAt, ...(typeof o.note === "string" ? { note: o.note.slice(0, 200) } : {}) } };
}

export function assess(r: ExpectancyRecord, now: number): { status: ExpectancyStatus; reason: string } {
  if (now - r.measuredAt > MAX_AGE_MS) return { status: "unproven", reason: `stale: measured ${Math.floor((now - r.measuredAt) / 86_400_000)} days ago (limit ${MAX_AGE_MS / 86_400_000})` };
  if (r.expectancyR <= 0) return { status: "negative", reason: `expectancy ${r.expectancyR.toFixed(2)}R is not positive` };
  if (r.ciLow95 === undefined) return { status: "unproven", reason: "positive point estimate without a confidence interval" };
  if (r.ciLow95 <= 0) return { status: "unproven", reason: `positive (${r.expectancyR.toFixed(2)}R) but the 95% interval (${r.ciLow95.toFixed(2)}R to ${(r.ciHigh95 ?? NaN).toFixed(2)}R) includes zero` };
  return { status: "validated", reason: `${r.expectancyR.toFixed(2)}R, 95% lower bound ${r.ciLow95.toFixed(2)}R` };
}

interface Store { v: 1; records: Record<string, ExpectancyRecord> }
const keyOf = (strategy: string) => `algo:expectancy:v1:${strategy}`, slot = (r: { source: string; symbol: string }) => `${r.source}:${r.symbol}`;
export async function readStore(kv: KV, strategy: Strategy): Promise<Store> {
  const raw = await kv.get(keyOf(strategy));
  if (!raw) return { v: 1, records: {} };
  try { const p = JSON.parse(raw) as Store; return p && p.v === 1 && p.records ? p : { v: 1, records: {} }; } catch { return { v: 1, records: {} }; }
}
/** Read-modify-write on a non-transactional store: writes are rare, authenticated and sequential by design. */
export async function saveRecord(kv: KV, r: ExpectancyRecord): Promise<void> {
  const s = await readStore(kv, r.strategy);
  s.records[slot(r)] = r;
  await kv.put(keyOf(r.strategy), JSON.stringify(s));
}

/** Combine records into one lookup: per source prefer the symbol-specific record over the strategy-wide one; most conservative wins. */
export function lookupFrom(s: Store, symbol: string, now: number): ExpectancyLookup {
  const sources: ExpectancyLookup["sources"] = [];
  for (const source of SOURCES) {
    const rec = s.records[`${source}:${symbol}`] ?? s.records[`${source}:*`];
    if (!rec) continue;
    const a = assess(rec, now);
    sources.push({ source, scope: rec.symbol, status: a.status, expectancyR: rec.expectancyR, samples: rec.samples, ageDays: Math.max(0, Math.floor((now - rec.measuredAt) / 86_400_000)), reason: a.reason });
  }
  const reasons = sources.map(x => `${x.source}/${x.scope}: ${x.reason}`);
  const negative = sources.filter(x => x.status === "negative"), valid = sources.filter(x => x.status === "validated");
  if (negative.length) { const w = negative.reduce((a, b) => (b.expectancyR < a.expectancyR ? b : a)); return { status: "negative", expectancyR: w.expectancyR, samples: w.samples, sources, reasons }; }
  if (valid.length) return { status: "validated", expectancyR: Math.min(...valid.map(x => x.expectancyR)), samples: Math.min(...valid.map(x => x.samples)), sources, reasons };
  return { status: "unproven", expectancyR: null, samples: null, sources, reasons: reasons.length ? reasons : ["no replay or paper evidence recorded for this strategy"] };
}
const UNPROVEN = (why: string): ExpectancyLookup => ({ status: "unproven", expectancyR: null, samples: null, sources: [], reasons: [why] });
/** Never throws: any store problem means "unproven", which is the conservative answer. */
export async function expectancyFor(env: unknown, strategy: Strategy, symbol: string, now: number = Date.now()): Promise<ExpectancyLookup> {
  const kv = kvOf(env);
  if (!kv) return UNPROVEN("expectancy store not configured (bind ETI_EXECUTION_LOG)");
  try { return lookupFrom(await readStore(kv, strategy), symbol.toUpperCase(), now); } catch { return UNPROVEN("expectancy store unavailable"); }
}
/** Options for runOmnisignal. Unproven yields nothing, so the validator keeps treating expectancy as unmeasured. */
export const expectancyOptions = (l: ExpectancyLookup): { expectancyR?: number; expectancySamples?: number } => (l.expectancyR === null ? {} : { expectancyR: l.expectancyR, expectancySamples: l.samples ?? undefined });
/** Compact status for API responses. */
export const expectancyStatus = (l: ExpectancyLookup) => ({ status: l.status, expectancyR: l.expectancyR, samples: l.samples, sources: l.sources, reasons: l.reasons });

// ---------- building records from evidence ----------
interface ReplayLike { symbol: string; strategy: Strategy; periodStart: number; periodEnd: number; expectancyForValidator: { expectancyR: number; samples: number } | null; bootstrapExpectancyR: { low95: number; high95: number } | null; outOfSample?: { expectancyR: number | null } }
/** From a replay of the real chain. The out-of-sample expectancy, when measurable, caps the claim. */
export function recordFromReplay(r: ReplayLike): unknown {
  if (!r.expectancyForValidator) return null;
  const oos = r.outOfSample?.expectancyR ?? null, exp = oos === null ? r.expectancyForValidator.expectancyR : Math.min(r.expectancyForValidator.expectancyR, oos), b = r.bootstrapExpectancyR;
  return { strategy: r.strategy, symbol: r.symbol, source: "replay", expectancyR: exp, samples: r.expectancyForValidator.samples, ...(b ? { ciLow95: Math.min(b.low95, exp), ciHigh95: Math.max(b.high95, exp) } : {}), periodStart: r.periodStart, periodEnd: r.periodEnd,
    note: oos !== null && oos < r.expectancyForValidator.expectancyR ? "capped by out-of-sample expectancy" : undefined };
}
/** From recorded closed trades (paper). Null below the minimum sample. */
export function recordFromTrades(trades: ClosedTrade[], o: { strategy: Strategy; symbol: string; source: ExpectancySource }): unknown {
  const b = bootstrapMeanR(trades);
  if (!b) return null;
  return { strategy: o.strategy, symbol: o.symbol, source: o.source, expectancyR: b.meanR, samples: b.samples, ciLow95: b.low95, ciHigh95: b.high95, periodStart: Math.min(...trades.map(t => t.openedAt)), periodEnd: Math.max(...trades.map(t => t.closedAt)) };
}
