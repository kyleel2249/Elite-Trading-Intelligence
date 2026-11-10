// Transaction-cost estimation. Costs are charged against both the reward and the risk of a trade, so a setup that looks
// attractive gross can be correctly rejected net. Assumptions are always labelled; nothing here is a quote from the exchange.
import type { DepthSnapshot, LiquidityAnalysis } from "../algo/liquidity.ts";
import type { CostConfig } from "./config.ts";
import type { CostEstimate } from "./types.ts";
import { round } from "./util.ts";

/** Quote currencies whose price is ~1 USD, so a USD reference notional can be walked against the book. */
export const USD_QUOTES = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USD"]);

/**
 * Volume-weighted fill price for a quote-currency notional, consuming levels from best to worst.
 * Returns null when the visible book cannot absorb the notional (never extrapolates beyond what is visible).
 */
export function walkBook(levels: [number, number][], notionalQuote: number): { vwap: number; best: number; slippageBps: number } | null {
  const valid = levels.filter(l => Number.isFinite(l[0]) && Number.isFinite(l[1]) && l[0] > 0 && l[1] > 0);
  if (!valid.length || !(notionalQuote > 0)) return null;
  let remaining = notionalQuote, base = 0, quote = 0;
  for (const [price, qty] of valid) {
    const take = Math.min(remaining, price * qty);
    base += take / price; quote += take; remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-6 || base <= 0) return null;
  const vwap = quote / base, best = valid[0][0];
  return { vwap, best, slippageBps: Math.abs(vwap - best) / best * 1e4 };
}

export interface CostInput {
  entry: number;
  direction: 1 | -1;
  stopDistance: number;
  quote: string | null;
  depth: DepthSnapshot | null | undefined;
  liquidity: LiquidityAnalysis | null;
  cfg: CostConfig;
}

export function estimateCosts(i: CostInput): CostEstimate {
  const { cfg } = i;
  const bookUsable = !!i.depth && !!i.liquidity && i.liquidity.status !== "blocked";
  const spreadBps = bookUsable ? i.liquidity!.spreadBps : null;

  // Entering a long consumes asks and exiting sells into bids; a short is the mirror image.
  let entrySlip = cfg.assumedSlippageBps, exitSlip = cfg.assumedSlippageBps;
  let slippageSource: CostEstimate["slippageSource"] = "assumed";
  let notional: number | null = null;
  if (bookUsable && i.quote && USD_QUOTES.has(i.quote)) {
    const bids = [...i.depth!.bids].sort((a, b) => b[0] - a[0]);
    const asks = [...i.depth!.asks].sort((a, b) => a[0] - b[0]);
    const inWalk = walkBook(i.direction > 0 ? asks : bids, cfg.referenceNotionalQuote);
    const outWalk = walkBook(i.direction > 0 ? bids : asks, cfg.referenceNotionalQuote);
    if (inWalk && outWalk) { entrySlip = inWalk.slippageBps; exitSlip = outWalk.slippageBps; slippageSource = "order_book_walk"; notional = cfg.referenceNotionalQuote; }
  }

  // Entering at the touch on one side and leaving at the touch on the other crosses the spread once per round trip.
  const spreadCost = spreadBps ?? 0;
  const roundTripBps = 2 * cfg.takerFeeBps + spreadCost + entrySlip + exitSlip;
  const roundTripPrice = i.entry * roundTripBps / 1e4;
  const costInR = i.stopDistance > 0 ? roundTripPrice / i.stopDistance : Infinity;
  return {
    feeBpsPerSide: cfg.takerFeeBps, feeSource: "configured",
    spreadBps: spreadBps === null ? null : round(spreadBps, 2), spreadSource: spreadBps === null ? "unavailable" : "order_book",
    slippageBpsPerSide: { entry: round(entrySlip, 2), exit: round(exitSlip, 2) }, slippageSource, referenceNotionalQuote: notional,
    roundTripBps: round(roundTripBps, 2), roundTripPrice: Number(roundTripPrice.toPrecision(6)), costInR: Number.isFinite(costInR) ? round(costInR, 3) : 999,
    excludes: ["funding or borrow costs for shorts on margin or derivatives", "exchange fee discounts and rebates", "price gaps and outages", "market impact beyond the visible order book", "taxes"],
    note: slippageSource === "order_book_walk"
      ? `Slippage is estimated by walking the visible order book for a ${cfg.referenceNotionalQuote} quote-currency order; size your own order against the live book. Fees are a configured assumption (${cfg.takerFeeBps} bps per side), not your account's actual tier.`
      : `Slippage is an assumed ${cfg.assumedSlippageBps} bps per side because the visible order book could not be used. Fees are a configured assumption (${cfg.takerFeeBps} bps per side).`,
  };
}

/**
 * Reward-to-risk after costs. The round-trip cost is subtracted from the reward and added to the risk:
 * a winner nets less than the gross move and a loser loses more than the stop distance.
 */
export function netRewardRisk(rewardDistance: number, stopDistance: number, roundTripPrice: number): number {
  const denom = stopDistance + roundTripPrice;
  if (!(denom > 0)) return 0;
  return round((rewardDistance - roundTripPrice) / denom, 2);
}
