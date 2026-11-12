/**
 * Intelligent investor-following evaluation.
 *
 * A disclosure is evidence, never an order. The 12-step trail below runs for every candidate; any hard failure
 * rejects it. Stale disclosures are labelled STALE_DISCLOSURE and are never followed without reassessing the market.
 * A wealthy or popular investor is not a reason: only a verified source, a followable method and current market
 * conditions can produce a follow classification, and every classification still needs independent validation.
 */
import type { Kline } from "../market.ts";
import type { Disclosure, WatchEntity } from "./sec.ts";
import { atrAt, emaSeries, round } from "./indicators.ts";
import { liquidityScore, dollarVolume24h } from "./earlyalpha.ts";
import type { AssetClass } from "./types.ts";

export type CopyClass = "INVESTOR_FOLLOWING_OPPORTUNITY" | "INVESTOR_STRATEGY_MATCH" | "INSTITUTIONAL_ACCUMULATION_SIGNAL" | "CONTRARIAN_OPPORTUNITY" | "STALE_DISCLOSURE" | "REJECTED_OPPORTUNITY";
export interface CopyCheck { id: string; label: string; pass: boolean | null; hard: boolean; detail: string }
export interface CopyEvaluation { id: string; disclosureId: string; investor: string; entity: string; asset: string; ticker: string | null; classification: CopyClass; score: number; summary: string; checks: CopyCheck[]; needsIndependentValidation: true; evaluatedAt: string }
export interface CopyMarket { rows: Kline[]; interval: string; assetClass: AssetClass; rrToTp2: number | null; stageBias: "bullish" | "risk" | "none"; labLongVotes: number; labCompatibleNames: string[] }

const ADD_TYPES = new Set(["confirmed_purchase", "new_position", "position_increase"]);
export function evaluateDisclosure(d: Disclosure, ent: WatchEntity | undefined, market: CopyMarket | null, consensusInvestors: number, now: number): CopyEvaluation {
  const checks: CopyCheck[] = [], add = (id: string, label: string, pass: boolean | null, hard: boolean, detail: string) => checks.push({ id, label, pass, hard, detail });
  const isAdd = ADD_TYPES.has(d.type);
  add("documented_action", "1. Documented investment action", isAdd, true, isAdd ? d.type.replace(/_/g, " ") + " reported by " + d.investor : "a " + d.type.replace(/_/g, " ") + " is not a long entry signal");
  add("source_verified", "2. Source verified", d.attribution.status === "verified" && d.source.startsWith("https://www.sec.gov/"), true, d.attribution.basis + "; " + d.source);
  add("transaction_date", "3. Transaction date established", d.eventDate !== null, false, d.eventDate ? (d.form.startsWith("13F") ? "quarter-end snapshot " + d.eventDate + " (exact trade date unknown)" : "transaction date " + d.eventDate) : "no event date");
  add("delay", "4. Information delay assessed", d.delay.staleness !== "stale", false, d.delay.note + "; age " + d.delay.ageDays + " days, " + d.delay.staleness);
  add("methodology", "5. Investor methodology followable", !!ent && ent.followability !== "not_followable", true, ent ? ent.style + " (" + ent.followability + "): " + ent.followNote : "entity not in the watch registry");
  const rows = market?.rows ?? [], have = rows.length >= 60;
  add("market_data", "6. Current market data available", have, true, have ? rows.length + " candles from the connected provider" : "no current market candles for this asset (connect a provider that covers it)");
  let ext = 0, moved = 0, dd = 0, below200 = false, ema20 = 0, price = 0, atr = 1;
  if (have) {
    price = rows[rows.length - 1][4]; atr = atrAt(rows, 14) || 1; ema20 = emaSeries(rows.map(r => r[4]), 20).at(-1)!; ext = (price - ema20) / atr;
    const ref = d.eventDate ? rows.find(r => r[0] >= Date.parse(d.eventDate!)) : undefined; moved = ref ? price / ref[4] - 1 : NaN;
    const hi = Math.max(...rows.slice(-120).map(r => r[2])); dd = 1 - price / hi; below200 = price < emaSeries(rows.map(r => r[4]), 200).at(-1)!;
  }
  const limit = ent?.horizon === "long_term" ? 0.3 : 0.2;
  add("still_valid", "7. Opportunity still valid", have ? (Number.isFinite(moved) ? moved <= limit : null) : null, false, have ? (Number.isFinite(moved) ? "price is " + round(moved * 100, 1) + "% from the disclosed date (limit " + limit * 100 + "%)" : "price at the disclosure date is outside the candle window; cannot confirm") : "no data");
  add("entry_conditions", "8. Present-day entry conditions", have ? ext <= 3 && market!.stageBias !== "risk" : null, false, have ? "price is " + round(ext, 1) + " ATR above EMA20; stage bias " + market!.stageBias : "no data");
  const usd = have ? dollarVolume24h(rows, market!.interval) : 0, liq = have ? liquidityScore(usd, market!.assetClass) : 0;
  add("valuation_liquidity", "9. Valuation and liquidity", have ? liq >= 0.3 : null, true, have ? "24h traded value " + Math.round(usd).toLocaleString("en-US") + " (liquidity score " + liq + "); valuation not evaluated: no fundamentals provider connected" : "no data");
  add("risk_reward", "10. Risk/reward", market?.rrToTp2 != null ? market.rrToTp2 >= 1.5 : null, false, market?.rrToTp2 != null ? "reward/risk to TP2 " + round(market.rrToTp2, 2) : "no plan");
  add("eti_comparison", "11. Compared with ETI strategies", market ? market.labLongVotes > 0 : null, false, market ? market.labLongVotes + " compatible ETI strategies currently vote long (" + (market.labCompatibleNames.join(", ") || "none") + ")" : "no data");
  add("independent_validation", "12. Independent validation", null, false, "deferred: the independent validator must approve before anything is executable");

  const hardFail = checks.find(c => c.hard && c.pass === false);
  let cls: CopyClass, summary: string;
  const contrarianStyle = !!ent && /contrarian|deep value|distressed/i.test(ent.style);
  if (!isAdd) { cls = "REJECTED_OPPORTUNITY"; summary = "disclosed " + d.type.replace(/_/g, " ") + " is distribution evidence, not a long entry"; }
  else if (d.delay.staleness === "stale") { cls = "STALE_DISCLOSURE"; summary = "disclosure is " + d.delay.ageDays + " days old; reassess the market from scratch before any action"; }
  else if (hardFail) { cls = "REJECTED_OPPORTUNITY"; summary = "failed hard check: " + hardFail.label.replace(/^\d+\. /, "") + " (" + hardFail.detail + ")"; }
  else if (consensusInvestors >= 2) { cls = "INSTITUTIONAL_ACCUMULATION_SIGNAL"; summary = consensusInvestors + " tracked investors added this asset in their latest disclosures"; }
  else if (contrarianStyle && below200 && dd >= 0.2) { cls = "CONTRARIAN_OPPORTUNITY"; summary = "value-style investor added while price is " + round(dd * 100, 0) + "% below its 120-bar high and under the 200-bar EMA"; }
  else if (market && market.labLongVotes > 0 && ext <= 3) { cls = "INVESTOR_STRATEGY_MATCH"; summary = "investor added and ETI's compatible strategies agree now (" + market.labCompatibleNames.join(", ") + ")"; }
  else if (checks.filter(c => ["still_valid", "entry_conditions", "risk_reward"].includes(c.id)).every(c => c.pass === true)) { cls = "INVESTOR_FOLLOWING_OPPORTUNITY"; summary = "documented add, entry still valid and reward/risk acceptable"; }
  else { cls = "REJECTED_OPPORTUNITY"; summary = "current conditions do not support following: " + checks.filter(c => c.pass === false || (["still_valid", "entry_conditions", "risk_reward"].includes(c.id) && c.pass === null)).map(c => c.label.replace(/^\d+\. /, "")).join(", "); }
  const base: Record<CopyClass, number> = { INSTITUTIONAL_ACCUMULATION_SIGNAL: 75, INVESTOR_FOLLOWING_OPPORTUNITY: 70, INVESTOR_STRATEGY_MATCH: 65, CONTRARIAN_OPPORTUNITY: 55, STALE_DISCLOSURE: 0, REJECTED_OPPORTUNITY: 0 };
  const score = base[cls] ? Math.max(0, base[cls] - (d.delay.staleness === "aging" ? 10 : 0) - (ent?.followability === "limited" ? 8 : 0)) : 0;
  return { id: "copy:" + d.id, disclosureId: d.id, investor: d.investor, entity: d.entity, asset: d.asset, ticker: d.ticker, classification: cls, score, summary, checks, needsIndependentValidation: true, evaluatedAt: new Date(now).toISOString() };
}

/** Counts distinct investors who ADDED the same asset (same CUSIP or ticker) across the given disclosures. */
export function consensusFor(target: Disclosure, all: Disclosure[]): number {
  return new Set(all.filter(d => ADD_TYPES.has(d.type) && d.attribution.status === "verified" && (d.assetKey === target.assetKey || (!!d.ticker && d.ticker === target.ticker)) && d.delay.staleness !== "stale").map(d => d.investor)).size;
}
