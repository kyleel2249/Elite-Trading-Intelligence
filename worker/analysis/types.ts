// Shared contracts for the ETI analysis engines. Every engine is independent and publishes an EngineReport
// to the central intelligence layer. Reports are evidence, never orders: nothing here can submit a trade.
export type Stance = "bullish" | "bearish" | "neutral" | "conflicted" | "unavailable";
export type Domain = "technical" | "multi_timeframe" | "fundamental" | "sentiment";
export type AssetClass = "crypto" | "fx" | "stock" | "unknown";

export interface SourceRef { name: string; url?: string; publishedAt?: string; retrievedAt: string }
export interface Finding {
  id: string;
  kind: string;
  stance: Stance;
  /** 0-100 evidence strength of this finding on its own. */
  strength: number;
  description: string;
  time?: number;
  data?: Record<string, unknown>;
}
export interface EngineReport {
  engine: string;
  domain: Domain;
  subject: string;
  stance: Stance;
  /** -100 (strongly bearish) .. +100 (strongly bullish). Evidence score, not a forecast. */
  score: number;
  /** 0-100 evidence quality (data sufficiency, agreement, freshness). NOT a probability of profit. */
  confidence: number;
  confidenceType: "evidence_quality_not_probability";
  status: "ok" | "partial" | "unavailable";
  /** Share of the inputs this engine wants that were actually available, 0..1. */
  completeness: number;
  findings: Finding[];
  warnings: string[];
  missing: string[];
  sources: SourceRef[];
  asOf: string;
  methodology: string;
  /** Engine-specific structured output (e.g. crypto legitimacy verdict, FX differentials). */
  extras?: Record<string, unknown>;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const round = (v: number, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);
export const stanceOf = (score: number, threshold = 20): Stance => (score >= threshold ? "bullish" : score <= -threshold ? "bearish" : "neutral");

export function unavailableReport(engine: string, domain: Domain, subject: string, why: string, missing: string[] = [], now = Date.now()): EngineReport {
  return { engine, domain, subject, stance: "unavailable", score: 0, confidence: 0, confidenceType: "evidence_quality_not_probability", status: "unavailable", completeness: 0,
    findings: [], warnings: [why], missing, sources: [], asOf: new Date(now).toISOString(), methodology: "n/a" };
}

export function inferAssetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase().replace(/[-_/]/g, "");
  if (/(USDT|USDC|BUSD|FDUSD|BTC|ETH)$/.test(s) && s.length > 5) return "crypto";
  const fx = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD"];
  if (s.length === 6 && fx.includes(s.slice(0, 3)) && fx.includes(s.slice(3))) return "fx";
  if (/^[A-Z]{1,5}$/.test(s)) return "stock";
  return "unknown";
}
