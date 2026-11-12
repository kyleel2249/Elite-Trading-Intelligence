/**
 * Opportunity prediction accountability. A prediction is recorded at the moment it is made (price, horizon, confidence,
 * invalidation) and is later resolved ONLY from candles after that moment, stop-first when both levels trade in one bar.
 * Nothing is back-filled: accuracy statistics are computed from this ledger and nothing else.
 */
import type { Kline } from "../market.ts";
import { INTERVAL_SECONDS } from "../market.ts";
import type { Fused } from "./fusion.ts";
import { round } from "./indicators.ts";

export interface Prediction {
  id: string; symbol: string; assetClass: string; interval: string; createdAt: number; priceAtCall: number; direction: "long"; horizonBars: number; horizonEndsAt: number;
  targetPrice: number; invalidationPrice: number; classification: string; stage: string; confidence: { earlyScore: number; overall: number; evidenceCoverage: number };
  reasons: string[]; status: "open" | "hit" | "invalidated" | "expired"; resolvedAt: number | null; resolvedPrice: number | null; returnPct: number | null; leadTimeBars: number | null; maxFavourablePct: number; maxAdversePct: number;
}
const CALLABLE = new Set(["DEVELOPING_OPPORTUNITY", "CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY", "EARLY_ACCUMULATION"]);
export function createPrediction(f: Fused, horizonBars = 48): Prediction | null {
  if (!f.plan || !CALLABLE.has(f.classification)) return null;
  const sec = INTERVAL_SECONDS[f.interval] ?? 3600, created = Date.parse(f.asOf);
  return { id: "pred:" + f.symbol + ":" + f.interval + ":" + created, symbol: f.symbol, assetClass: f.assetClass, interval: f.interval, createdAt: created, priceAtCall: f.price, direction: "long", horizonBars, horizonEndsAt: created + horizonBars * sec * 1000,
    targetPrice: f.plan.targets[0].price, invalidationPrice: f.plan.stop, classification: f.classification, stage: f.stage, confidence: { earlyScore: f.scores.early, overall: f.scores.overall, evidenceCoverage: f.confidence.evidenceCoverage }, reasons: f.reasons.slice(0, 4),
    status: "open", resolvedAt: null, resolvedPrice: null, returnPct: null, leadTimeBars: null, maxFavourablePct: 0, maxAdversePct: 0 };
}
export function resolvePrediction(p: Prediction, rows: Kline[], now: number): Prediction {
  if (p.status !== "open") return p;
  const after = rows.filter(r => r[0] > p.createdAt); let fav = 0, adv = 0;
  for (let i = 0; i < after.length && i < p.horizonBars; i++) {
    const b = after[i]; fav = Math.max(fav, b[2] / p.priceAtCall - 1); adv = Math.min(adv, b[3] / p.priceAtCall - 1);
    const stopHit = b[3] <= p.invalidationPrice, targetHit = b[2] >= p.targetPrice;
    if (stopHit) return { ...p, status: "invalidated", resolvedAt: b[0], resolvedPrice: p.invalidationPrice, returnPct: round((p.invalidationPrice / p.priceAtCall - 1) * 100, 2), maxFavourablePct: round(fav * 100, 2), maxAdversePct: round(adv * 100, 2) };
    if (targetHit) return { ...p, status: "hit", resolvedAt: b[0], resolvedPrice: p.targetPrice, returnPct: round((p.targetPrice / p.priceAtCall - 1) * 100, 2), leadTimeBars: i + 1, maxFavourablePct: round(fav * 100, 2), maxAdversePct: round(adv * 100, 2) };
  }
  if (after.length >= p.horizonBars || now >= p.horizonEndsAt) { const b = after[Math.min(after.length, p.horizonBars) - 1] ?? null; if (b) return { ...p, status: "expired", resolvedAt: b[0], resolvedPrice: b[4], returnPct: round((b[4] / p.priceAtCall - 1) * 100, 2), maxFavourablePct: round(fav * 100, 2), maxAdversePct: round(adv * 100, 2) }; }
  return { ...p, maxFavourablePct: round(fav * 100, 2), maxAdversePct: round(adv * 100, 2) };
}
export interface Accuracy { total: number; open: number; resolved: number; hits: number; invalidated: number; expired: number; hitRate: number | null; falsePositiveRate: number | null; avgReturnPct: number | null; avgLeadTimeBars: number | null; byClassification: Record<string, { n: number; hitRate: number | null }>; note: string }
export function accuracyOf(preds: Prediction[]): Accuracy {
  const res = preds.filter(p => p.status !== "open"), hits = res.filter(p => p.status === "hit"), bad = res.filter(p => p.status === "invalidated" || (p.status === "expired" && (p.returnPct ?? 0) <= 0));
  const by: Accuracy["byClassification"] = {}; for (const c of new Set(res.map(p => p.classification))) { const g = res.filter(p => p.classification === c); by[c] = { n: g.length, hitRate: g.length >= 5 ? round(100 * g.filter(p => p.status === "hit").length / g.length, 1) : null }; }
  const rate = (n: number) => res.length >= 10 ? round(100 * n / res.length, 1) : null;
  return { total: preds.length, open: preds.length - res.length, resolved: res.length, hits: hits.length, invalidated: res.filter(p => p.status === "invalidated").length, expired: res.filter(p => p.status === "expired").length, hitRate: rate(hits.length), falsePositiveRate: rate(bad.length),
    avgReturnPct: res.length >= 10 ? round(res.reduce((a, p) => a + (p.returnPct ?? 0), 0) / res.length, 2) : null, avgLeadTimeBars: hits.length >= 5 ? round(hits.reduce((a, p) => a + (p.leadTimeBars ?? 0), 0) / hits.length, 1) : null, byClassification: by,
    note: res.length < 10 ? "fewer than 10 resolved predictions: rates withheld rather than estimated" : "target = TP1 (1.5R) before invalidation within the horizon; excludes fees and slippage" };
}
/** False-negative check: a discovery that was NOT escalated but later rose by `up` before falling by `down`. */
export interface DiscoveryOutcome { symbol: string; classification: string; priceAtDiscovery: number; discoveredAt: number; outcome: "missed_move" | "correctly_ignored" | "pending" }
export function outcomeOfDiscovery(d: { symbol: string; classification: string; price: number; discoveredAt: number; horizonBars: number; interval: string }, rows: Kline[], up = 0.15, down = 0.08): DiscoveryOutcome {
  const base: Omit<DiscoveryOutcome, "outcome"> = { symbol: d.symbol, classification: d.classification, priceAtDiscovery: d.price, discoveredAt: d.discoveredAt }, after = rows.filter(r => r[0] > d.discoveredAt).slice(0, d.horizonBars);
  for (const b of after) { if (b[3] <= d.price * (1 - down)) return { ...base, outcome: "correctly_ignored" }; if (b[2] >= d.price * (1 + up)) return { ...base, outcome: "missed_move" }; }
  return { ...base, outcome: after.length >= d.horizonBars ? "correctly_ignored" : "pending" };
}
export function falseNegativeRate(outs: DiscoveryOutcome[]): { n: number; missed: number; rate: number | null } {
  const done = outs.filter(o => o.outcome !== "pending" && ["REJECTED", "WATCHLIST"].includes(o.classification)), missed = done.filter(o => o.outcome === "missed_move").length;
  return { n: done.length, missed, rate: done.length >= 20 ? round(100 * missed / done.length, 1) : null };
}
