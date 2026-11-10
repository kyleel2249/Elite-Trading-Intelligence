// Risk gates. Every gate is evaluated on every signal. A single failed gate forces NO TRADE no matter how high the
// opportunity score is: the score ranks candidates, the gates decide whether a candidate may be signalled at all.
// "not_evaluated" means the engine lacks the evidence to judge; it is reported, never treated as a pass.
import type { LiquidityAnalysis } from "../algo/liquidity.ts";
import type { RegimeResult } from "../algo/regime.ts";
import type { Consensus } from "../algo/timeframes.ts";
import type { RiskContext, ValidationResult } from "../algo/validation.ts";
import type { PrecisionConfig } from "./config.ts";
import type { NewsAssessment } from "./context.ts";
import type { CostEstimate, GateResult } from "./types.ts";

export interface GateInput {
  cfg: PrecisionConfig;
  instrumentSupported: boolean;
  consensus: Consensus;
  validation: ValidationResult;
  fresh: boolean;
  ageSec: number;
  candlesComplete: boolean;
  bookAvailable: boolean;
  liquidity: LiquidityAnalysis | null;
  trapNearby: boolean;
  regime: RegimeResult;
  stopPercent: number;
  costs: CostEstimate;
  /** Distance from entry to TP1 in price units. */
  tp1RewardDistance: number;
  netRewardRiskTP1: number;
  netRewardRiskFinal: number;
  news: NewsAssessment;
  expectancy: { expectancyR: number; samples: number } | null;
  risk: RiskContext | undefined;
  score: number | null;
  /** Time the signal remains valid for, and the length of one setup-timeframe bar, both in ms. */
  validityMs: number;
  barMs: number;
}

/** Hard failures the algo validator raises that a dedicated gate below already reports, so they are not listed twice. */
const COVERED_BY_OWN_GATE = [
  /^Market data is stale/, /^Candle data incomplete/, /^Regime '/, /^Reward\/risk to TP3/, /^Structurally justified stop/,
  /^Validated expectancy is not positive/, /^Nearby liquidity trap/, /^Liquidity: /,
];

export function evaluateGates(g: GateInput): GateResult[] {
  const c = g.cfg.gates;
  const out: GateResult[] = [];
  const add = (id: string, label: string, status: GateResult["status"], detail: string) => out.push({ id, label, status, detail });
  const pf = (id: string, label: string, ok: boolean, passText: string, failText: string) => add(id, label, ok ? "pass" : "fail", ok ? passText : failText);

  pf("instrument_supported", "Instrument is on a supported market", g.instrumentSupported, "Instrument is a supported crypto spot pair", "Instrument is not on a market ETI has a data adapter for");
  pf("data_fresh", "Market data is fresh", g.fresh, `Latest setup-timeframe candle is ${g.ageSec}s old, inside the freshness limit`, `Market data is stale or from the future (${g.ageSec}s)`);
  pf("data_complete", "Candle history is complete", g.candlesComplete, "Enough validated candles on the setup timeframe", "Insufficient validated candle history");
  pf("directional_consensus", "Multi-timeframe evidence is directional", g.consensus.direction !== "neutral" && Math.abs(g.consensus.weightedScore) >= c.minConsensusScore,
    `Consensus ${g.consensus.direction} (score ${g.consensus.weightedScore})`, `Evidence is mixed or insufficient (consensus ${g.consensus.direction}, score ${g.consensus.weightedScore}, minimum ${c.minConsensusScore})`);
  pf("regime_allows_entries", "Market regime permits new entries", g.regime.profile.allowNewEntries, `Regime ${g.regime.regime}`, `Regime '${g.regime.regime}' suspends new entries`);

  if (!g.bookAvailable) add("order_book_available", "Order book is available", c.requireOrderBook ? "fail" : "not_evaluated", c.requireOrderBook ? "No usable order book: liquidity cannot be verified, so no trade is signalled" : "No order book; liquidity not verified (order-book requirement disabled by configuration)");
  else add("order_book_available", "Order book is available", "pass", "Order-book snapshot received");

  if (!g.bookAvailable || !g.liquidity) add("order_book_healthy", "Order book is healthy", "not_evaluated", "No order book to assess");
  else if (g.liquidity.status === "blocked") add("order_book_healthy", "Order book is healthy", "fail", g.liquidity.issues.join("; ") || "Order book failed validation");
  else add("order_book_healthy", "Order book is healthy", "pass", g.liquidity.status === "degraded" ? `Degraded but usable: ${g.liquidity.issues.join("; ")}` : "Fresh, uncrossed and deep enough");

  if (g.costs.spreadBps === null) add("spread_limit", "Spread is within limit", "not_evaluated", "Spread unknown");
  else pf("spread_limit", "Spread is within limit", g.costs.spreadBps <= c.maxSpreadBps, `Spread ${g.costs.spreadBps} bps (limit ${c.maxSpreadBps})`, `Spread ${g.costs.spreadBps} bps exceeds the ${c.maxSpreadBps} bps limit`);

  if (!g.bookAvailable) add("liquidity_trap", "No nearby liquidity trap", "not_evaluated", "No order book to assess");
  else pf("liquidity_trap", "No nearby liquidity trap", !g.trapNearby, "No large opposing resting order close to entry", "Large opposing resting order close to entry (possible trap or absorption)");

  pf("stop_distance", "Stop distance is acceptable", g.stopPercent <= c.maxStopPct, `Stop is ${g.stopPercent.toFixed(2)}% from entry (limit ${c.maxStopPct}%)`, `Stop distance ${g.stopPercent.toFixed(2)}% exceeds the ${c.maxStopPct}% maximum`);
  pf("net_reward_risk", "Reward-to-risk holds after costs", g.netRewardRiskTP1 >= c.minNetRewardRiskTP1 && g.netRewardRiskFinal >= c.minNetRewardRisk,
    `Net reward-to-risk ${g.netRewardRiskTP1} at TP1 and ${g.netRewardRiskFinal} at the final target`,
    `Net reward-to-risk after costs is ${g.netRewardRiskTP1} at TP1 (minimum ${c.minNetRewardRiskTP1}) and ${g.netRewardRiskFinal} at the final target (minimum ${c.minNetRewardRisk})`);
  const share = g.tp1RewardDistance > 0 ? g.costs.roundTripPrice / g.tp1RewardDistance : Infinity;
  pf("cost_share", "Costs do not consume the reward", share <= c.maxCostShareOfTP1Reward, `Round-trip costs are ${(share * 100).toFixed(0)}% of the TP1 reward`, `Round-trip costs are ${Number.isFinite(share) ? (share * 100).toFixed(0) : "all"}% of the TP1 reward (limit ${(c.maxCostShareOfTP1Reward * 100).toFixed(0)}%)`);

  if (g.news.status !== "available") add("news_blackout", "No high-impact news blackout", "not_evaluated", g.news.notes[0] ?? "No news data");
  else pf("news_blackout", "No high-impact news blackout", !g.news.blackout, "No high-impact event inside the blackout window", g.news.blackoutReason ?? "High-impact event inside the blackout window");

  if (!g.expectancy) add("expectancy", "Strategy expectancy is not negative", "not_evaluated", "No measured expectancy for this strategy");
  else if (g.expectancy.samples < g.cfg.minExpectancySamples) add("expectancy", "Strategy expectancy is not negative", "not_evaluated", `Only ${g.expectancy.samples} outcomes (minimum ${g.cfg.minExpectancySamples})`);
  else pf("expectancy", "Strategy expectancy is not negative", g.expectancy.expectancyR > 0, `Measured expectancy ${g.expectancy.expectancyR.toFixed(2)}R over ${g.expectancy.samples} outcomes`, `Measured expectancy is not positive (${g.expectancy.expectancyR.toFixed(2)}R over ${g.expectancy.samples} outcomes)`);

  // While a blackout is already active the news gate reports the cause; a second "expires in 0 min" failure would only repeat it.
  if (g.news.blackout) add("signal_validity", "Signal stays valid for at least one full bar", "not_evaluated", "Covered by the active news blackout");
  else pf("signal_validity", "Signal stays valid for at least one full bar", g.validityMs >= g.barMs,
    `Valid for ${Math.floor(g.validityMs / g.barMs)} setup-timeframe bar(s)`, `The signal would expire in ${Math.max(0, Math.round(g.validityMs / 60000))} min, before one full setup-timeframe bar completes (an upcoming news blackout shortens its life)`);

  const residual = g.validation.hardFailures.filter(f => !COVERED_BY_OWN_GATE.some(re => re.test(f)));
  pf("engine_validation", "Independent validation found no hard failure", residual.length === 0, `Independent evidence: ${g.validation.supportingFamilies} supporting, ${g.validation.opposingFamilies} opposing`, residual.join("; "));

  if (g.score === null) add("score_floor", "Opportunity score meets the minimum", "fail", "No opportunity score could be computed");
  else pf("score_floor", "Opportunity score meets the minimum", g.score >= c.minScoreToSignal, `Score ${g.score} (minimum ${c.minScoreToSignal})`, `Score ${g.score} is below the minimum ${c.minScoreToSignal}`);

  if (!g.risk) add("account_risk", "Account-level risk limits", "not_evaluated", "Equity, exposure, daily-loss and drawdown limits are not evaluated by this analytical engine. Any order must still pass the execution risk preflight.");
  else pf("account_risk", "Account-level risk limits", g.risk.withinLimits, "Supplied account risk context is within limits", g.risk.reasons.join("; ") || "Account-level risk limits not satisfied");
  return out;
}

export const summarizeGates = (r: GateResult[]) => ({ passed: r.filter(x => x.status === "pass").length, failed: r.filter(x => x.status === "fail").length, notEvaluated: r.filter(x => x.status === "not_evaluated").length });
