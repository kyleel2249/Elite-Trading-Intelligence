/** Derivatives positioning context. It can only penalise crowded or unwinding setups; it never creates a signal. */
export interface DerivativesSnapshot {
  fundingRate?: number | null;
  openInterest?: number | null;
  previousOpenInterest?: number | null;
  timestamp?: number | null;
  source?: string;
}
export interface DerivativesAnalysis {
  status: "available" | "partial" | "stale" | "unavailable";
  fundingRate: number | null;
  fundingPercent: number | null;
  fundingBias: "longs_pay" | "shorts_pay" | "neutral" | "unknown";
  crowding: "longs_crowded" | "shorts_crowded" | "neutral" | "unknown";
  openInterest: number | null;
  openInterestChangePct: number | null;
  ageMs: number | null;
  scoreAdjustment: number;
  notes: string[];
  source: string | null;
}
export interface DerivativesOptions {
  maxAgeMs?: number;
  crowdedFundingRate?: number;
  extremeFundingRate?: number;
  unwindChangePct?: number;
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A missing/stale derivatives feed is advisory only. Extreme same-side funding and rapid OI contraction can reduce, never increase, signal confidence. */
export function analyzeDerivativesContext(
  snapshot: DerivativesSnapshot | null | undefined,
  direction: 1 | -1 | 0,
  now = Date.now(),
  options: DerivativesOptions = {},
): DerivativesAnalysis {
  const maxAgeMs = options.maxAgeMs ?? 180_000;
  const crowdedRate = options.crowdedFundingRate ?? 0.0005;
  const extremeRate = options.extremeFundingRate ?? 0.001;
  const unwindPct = options.unwindChangePct ?? -5;
  const empty = (status: DerivativesAnalysis["status"], notes: string[]): DerivativesAnalysis => ({
    status, fundingRate: null, fundingPercent: null, fundingBias: "unknown", crowding: "unknown",
    openInterest: null, openInterestChangePct: null, ageMs: null, scoreAdjustment: 0, notes, source: snapshot?.source ?? null,
  });
  if (!snapshot) return empty("unavailable", ["Derivatives context unavailable; no funding or open-interest assumption was made"]);

  let ageMs: number | null = null;
  if (finite(snapshot.timestamp) && snapshot.timestamp > 0) {
    const ts = snapshot.timestamp < 1e12 ? snapshot.timestamp * 1000 : snapshot.timestamp;
    ageMs = now - ts;
    if (ageMs > maxAgeMs || ageMs < -30_000) return { ...empty("stale", ["Derivatives snapshot is stale or timestamped in the future; it was excluded from scoring"]), ageMs };
  }

  const funding = finite(snapshot.fundingRate) ? snapshot.fundingRate : null;
  const oi = finite(snapshot.openInterest) && snapshot.openInterest > 0 ? snapshot.openInterest : null;
  const previousOi = finite(snapshot.previousOpenInterest) && snapshot.previousOpenInterest > 0 ? snapshot.previousOpenInterest : null;
  const oiChange = oi !== null && previousOi !== null ? (oi - previousOi) / previousOi * 100 : null;
  const fundingBias = funding === null ? "unknown" : funding > 0 ? "longs_pay" : funding < 0 ? "shorts_pay" : "neutral";
  const crowding = funding === null ? "unknown" : funding >= crowdedRate ? "longs_crowded" : funding <= -crowdedRate ? "shorts_crowded" : "neutral";
  const notes: string[] = [];
  let adjustment = 0;
  if (funding !== null) {
    notes.push(`Funding ${(funding * 100).toFixed(4)}% (${fundingBias === "longs_pay" ? "longs pay shorts" : fundingBias === "shorts_pay" ? "shorts pay longs" : "neutral"})`);
    const crowdedAgainst = (direction === 1 && crowding === "longs_crowded") || (direction === -1 && crowding === "shorts_crowded");
    if (crowdedAgainst) {
      const penalty = Math.abs(funding) >= extremeRate ? 8 : 5;
      adjustment -= penalty;
      notes.push(`Crowded ${direction === 1 ? "long" : "short"} positioning: signal confidence reduced by ${penalty} points`);
    }
  }
  if (oi !== null) notes.push(`Open interest ${oi.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
  if (oiChange !== null) {
    notes.push(`Open interest change ${oiChange >= 0 ? "+" : ""}${oiChange.toFixed(2)}% versus previous snapshot`);
    if (oiChange <= unwindPct) {
      adjustment -= 2;
      notes.push("Open interest is contracting sharply; participation may be unwinding");
    }
  }
  if (funding === null && oi === null) return { ...empty("unavailable", ["No usable funding-rate or open-interest fields were supplied"]), ageMs };
  const status = funding !== null && oi !== null ? "available" : "partial";
  return {
    status, fundingRate: funding, fundingPercent: funding === null ? null : funding * 100, fundingBias, crowding,
    openInterest: oi, openInterestChangePct: oiChange, ageMs, scoreAdjustment: clamp(adjustment, -10, 0), notes,
    source: snapshot.source ?? null,
  };
}
