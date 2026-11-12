// "How has the proposed strategy performed under similar conditions?" Evidence comes only from RECORDED trades
// (replay-lab or paper-engine ClosedTrade records published for the symbol/strategy). The engine never fabricates a track record:
// below MIN_SAMPLE trades a bucket reports sample size only, with no win rate or expectancy.
import { MIN_SAMPLE, computeReport, type ClosedTrade, type PerformanceReport } from "../algo/performance.ts";
import { sessionActive, sessionLabel, type MarketKind, type SessionId } from "./calendar.ts";

export interface EvidenceFile { symbol: string; strategy: string; generatedAt: number; periodStart?: number; periodEnd?: number; source: string; trades: ClosedTrade[] }
export interface EvidenceBucket { label: string; trades: number; status: "ok" | "insufficient_sample"; winRate: number | null; winRateInterval95: { low: number; high: number } | null; expectancyR: number | null; profitFactor: number | null; maxDrawdownPct: number | null }
export interface EvidenceSummary { available: boolean; source: string | null; generatedAt: number | null; period: { start: number; end: number } | null; criteria: { session: SessionId | null; regime: string | null }; buckets: EvidenceBucket[]; verdict: "supportive" | "adverse" | "inconclusive" | "no_data"; note: string }

export function parseEvidence(raw: unknown): EvidenceFile | null {
  const o = raw as Partial<EvidenceFile> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.trades) || typeof o.symbol !== "string") return null;
  const trades = o.trades.filter((t): t is ClosedTrade => !!t && [t.pnl, t.riskAmount, t.openedAt, t.closedAt].every(v => typeof v === "number" && Number.isFinite(v)) && t.closedAt >= t.openedAt);
  return { symbol: o.symbol, strategy: String(o.strategy ?? "unknown"), generatedAt: Number(o.generatedAt) || 0, periodStart: o.periodStart, periodEnd: o.periodEnd, source: String(o.source ?? "published evidence"), trades };
}
const bucket = (label: string, t: ClosedTrade[]): EvidenceBucket => {
  const r: PerformanceReport = computeReport(t);
  return { label, trades: r.trades, status: r.status, winRate: r.winRate, winRateInterval95: r.status === "ok" ? r.winRateInterval95 : null, expectancyR: r.expectancyR, profitFactor: r.profitFactor, maxDrawdownPct: r.status === "ok" ? r.maxDrawdownPct : null };
};
export function summarizeEvidence(ev: EvidenceFile | null, market: MarketKind, session: SessionId | null, regime: string | null): EvidenceSummary {
  const criteria = { session, regime };
  if (!ev || !ev.trades.length) return { available: false, source: ev?.source ?? null, generatedAt: ev?.generatedAt ?? null, period: null, criteria, buckets: [], verdict: "no_data", note: "No recorded strategy trades are published for this symbol, so performance under similar conditions is unknown. ETI does not estimate it." };
  const inSession = (t: ClosedTrade) => !session || sessionActive(session, t.openedAt, market !== "forex");
  const inRegime = (t: ClosedTrade) => !regime || t.regime === regime;
  const buckets = [bucket("All recorded trades", ev.trades)];
  if (session) buckets.push(bucket(`Entered during ${sessionLabel(session)}`, ev.trades.filter(inSession)));
  if (regime) buckets.push(bucket(`Entered in regime ${regime}`, ev.trades.filter(inRegime)));
  const similar = session || regime ? bucket("Similar conditions (session and regime)", ev.trades.filter(t => inSession(t) && inRegime(t))) : null;
  if (similar) buckets.push(similar);
  const key = similar ?? buckets[0];
  const verdict = key.status !== "ok" ? "inconclusive" : (key.expectancyR ?? 0) < 0 && (key.winRateInterval95?.high ?? 1) < 0.5 ? "adverse" : (key.expectancyR ?? 0) > 0 && (key.winRateInterval95?.low ?? 0) >= 0.35 ? "supportive" : "inconclusive";
  const period = ev.periodStart && ev.periodEnd ? { start: ev.periodStart, end: ev.periodEnd } : null;
  return { available: true, source: ev.source, generatedAt: ev.generatedAt, period, criteria, buckets, verdict,
    note: key.status !== "ok" ? `Only ${key.trades} recorded trade(s) match these conditions (minimum ${MIN_SAMPLE}); no win rate or expectancy is reported because it would be statistical noise.` : "Recorded historical results are not a forecast. They depend on the tested period, assumed costs and fills." };
}
