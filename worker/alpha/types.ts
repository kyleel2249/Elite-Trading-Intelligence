/** Shared types for the ETI Global Alpha Intelligence layer. */
export type AssetClass = "crypto" | "equity";
export type Stage =
  | "PRE_ACCUMULATION" | "EARLY_ACCUMULATION" | "BREAKOUT_FORMATION" | "BREAKOUT_CONFIRMATION"
  | "TREND_EXPANSION" | "MOMENTUM_EXHAUSTION" | "DISTRIBUTION" | "REVERSAL_RISK" | "NONE";
export type Classification =
  | "WATCHLIST" | "EARLY_ACCUMULATION" | "DEVELOPING_OPPORTUNITY" | "CONFIRMED_OPPORTUNITY"
  | "HIGH_CONVICTION_OPPORTUNITY" | "REJECTED" | "INVALIDATED";

export interface Factor {
  id: string; label: string; weight: number;
  /** 0..1, or null when the data this factor needs is not connected (never guessed). */
  score: number | null; evidence: string[];
}
/** Optional evidence supplied by other engines (investor, on-chain, catalysts, valuation). */
export interface ExternalEvidence { score: number; evidence: string[]; sources: string[] }
export interface ExternalInputs { institutional?: ExternalEvidence; onchain?: ExternalEvidence; catalyst?: ExternalEvidence; valuation?: ExternalEvidence }
