// ETI Institutional FVG Precision Engine.
// Closed-candle analysis only. This module produces advisory setups; it cannot submit or authorize orders.
import type { Kline } from "../market.ts";
import { lastAtr } from "./atr.ts";
import { detectFvgZones, type FvgZone } from "./fvg.ts";
import { detectDisplacement, detectLiquiditySweeps, detectOrderBlocks, findLiquidityPools } from "./smc.ts";
import { analyzeStructure, findPivots, supportResistance } from "./structure.ts";
import { premiumDiscount } from "./smc-intel.ts";
import { clamp, round } from "./types.ts";

export type PrecisionDirection = "BUY" | "SELL";
export type PrecisionZoneState = "qualified_fresh" | "touched_pending" | "confirmed" | "rejected";
export interface PrecisionTarget { price: number; rewardRisk: number; source: string }
export interface PrecisionCandidate {
  id: string; direction: PrecisionDirection; timeframe: string; zone: { lower: number; upper: number; midpoint: number };
  state: PrecisionZoneState; highlight: "green" | "yellow" | "red" | "none";
  entry: { price: number; method: "consequent_encroachment_50"; execution: "limit_pending" | "confirmation_required" };
  stopLoss: number | null; targets: PrecisionTarget[]; riskReward: number | null;
  score: number; scoreType: "evidence_quality_not_probability"; passed: string[]; failed: string[];
  bos: { type: "BOS" | "CHoCH"; time: number; level: number } | null;
  displacementAtr: number; supportResistance: { kind: "support" | "resistance"; price: number; strength: number } | null;
  orderBlock: { lower: number; upper: number; hasFvg: boolean; breaksStructure: boolean } | null;
  dealingRange: { low: number; high: number; positionPct: number; zone: "discount" | "premium" | "equilibrium" } | null;
  liquiditySweep: { direction: "bullish" | "bearish"; time: number; level: number } | null;
  mitigationPct: number; freshnessBars: number; reaction: { confirmed: boolean; time: number | null; close: number | null; ageBars: number | null; distanceAtr: number | null; reason: string };
  explanation: string[];
}
export interface FvgPrecisionResult {
  symbol?: string; timeframe: string; status: "ready" | "insufficient_history"; price: number | null;
  direction: "BUY" | "SELL" | "WAIT"; best: PrecisionCandidate | null; candidates: PrecisionCandidate[];
  summary: { bullish: number; bearish: number; green: number; confirmed: number; rejected: number };
  rules: Record<string, number | string>; canTriggerTrade: false; submitsOrder: false; liveExecutionAllowed: false;
  methodology: string;
}
export const FVG_PRECISION_RULES = {
  minCandles: 40, minGapAtr: 0.15, maxAgeBars: 200, bosLookbackBars: 35,
  displacementMinAtr: 0.8, srToleranceAtr: 0.65, entryFraction: 0.5,
  maxRetestAgeBars: 3, maxEntryDistanceAtr: 1.5,
  atrStopBuffer: 0.2, minRewardRisk: 2, maxCandidates: 20, eliteScore: 80,
} as const;

const intersects = (a: number, b: number, lo: number, hi: number) => Math.min(b, hi) >= Math.max(a, lo);
const roundPrice = (v: number, precision = 8) => round(v, precision);

/** Analyse only closed, chronological candles. Pass a distinct higher-timeframe series when available. */
export function analyzeFvgPrecision(
  rows: Kline[], timeframe: string,
  opts: { symbol?: string; higherTimeframes?: Partial<Record<string, Kline[]>>; pricePrecision?: number; minRewardRisk?: number } = {},
): FvgPrecisionResult {
  const empty = (status: FvgPrecisionResult["status"], price: number | null, candidates: PrecisionCandidate[] = []): FvgPrecisionResult => ({
    ...(opts.symbol ? { symbol: opts.symbol } : {}), timeframe, status, price, direction: "WAIT", best: null, candidates,
    summary: { bullish: 0, bearish: 0, green: 0, confirmed: 0, rejected: 0 },
    rules: { ...FVG_PRECISION_RULES }, canTriggerTrade: false, submitsOrder: false, liveExecutionAllowed: false,
    methodology: "Closed-candle FVG qualification with structure, displacement, unmitigated status, support/resistance, premium/discount, first-retest reaction, liquidity and structural targets. Evidence score is not a win probability.",
  });
  if (!Array.isArray(rows) || rows.length < FVG_PRECISION_RULES.minCandles) return empty("insufficient_history", rows?.at(-1)?.[4] ?? null);
  const price = rows.at(-1)![4], atr = lastAtr(rows), precision = Math.max(0, Math.min(12, Math.floor(opts.pricePrecision ?? 8)));
  if (!(atr > 0) || !Number.isFinite(price)) return empty("insufficient_history", price);
  const pivots = findPivots(rows), structure = analyzeStructure(rows, pivots), sr = supportResistance(rows, pivots, 0.65, 20);
  const pd = premiumDiscount(rows, timeframe), sweeps = detectLiquiditySweeps(rows, pivots, 50), displacement = detectDisplacement(rows, 80);
  const zones = detectFvgZones(rows, { timeframe, minSizeAtr: FVG_PRECISION_RULES.minGapAtr, maxAgeBars: FVG_PRECISION_RULES.maxAgeBars, window: 200 });
  const orderBlocks = detectOrderBlocks(rows, 120), liquidityPools = findLiquidityPools(rows, pivots);
  const result: PrecisionCandidate[] = [];
  const currentIndex = rows.length - 1;

  for (const z of zones) {
    const bullish = z.direction === "bullish", direction: PrecisionDirection = bullish ? "BUY" : "SELL";
    const passed: string[] = [], failed: string[] = [], explanation: string[] = [];
    const confirmIndex = rows.findIndex(r => r[0] === z.confirmTime);
    if (confirmIndex < 2) continue;
    const bos = structure.events.filter(e => e.direction === z.direction && e.index <= confirmIndex && confirmIndex - e.index <= FVG_PRECISION_RULES.bosLookbackBars).sort((a,b)=>b.index-a.index)[0] ?? null;
    if (bos) passed.push("Confirmed BOS/CHoCH preceded the FVG"); else failed.push("No recent same-direction BOS/CHoCH before FVG formation");
    const impulse = displacement.filter(d => d.direction === z.direction && Math.abs(d.index - (confirmIndex - 1)) <= 2).sort((a,b)=>Math.abs(a.index-(confirmIndex-1))-Math.abs(b.index-(confirmIndex-1)))[0];
    const displacementAtr = impulse?.bodyAtr ?? z.displacementAtr;
    if (impulse && displacementAtr >= FVG_PRECISION_RULES.displacementMinAtr) passed.push("Directional displacement confirmed"); else failed.push("No qualifying directional displacement");
    const fresh = z.status === "fresh" && z.mitigationPct === 0 && z.touches === 0;
    if (fresh) passed.push("Completely unmitigated FVG"); else failed.push("FVG has already been touched or mitigated");
    const zoneMid = (z.lower + z.upper) / 2;
    const level = sr.filter(l => l.kind === (bullish ? "support" : "resistance") && intersects(l.low, l.high, z.lower - atr * FVG_PRECISION_RULES.srToleranceAtr, z.upper + atr * FVG_PRECISION_RULES.srToleranceAtr)).sort((a,b)=>Number(b.hasFVG)-Number(a.hasFVG)||b.index-a.index)[0] ?? null;
    if (level) passed.push("Support/resistance overlaps the FVG"); else failed.push("No meaningful support/resistance overlap");
    const orderBlock = orderBlocks.filter(o => o.kind === z.direction && !o.mitigated && !o.invalidated && intersects(o.low, o.high, z.lower, z.upper)).sort((a,b)=>Number(b.hasFVG)-Number(a.hasFVG))[0] ?? null;
    if (orderBlock) passed.push("Unmitigated same-direction order block overlaps the FVG");
    const correctHalf = !!pd && (bullish ? pd.zone === "discount" : pd.zone === "premium");
    if (correctHalf) passed.push(bullish ? "FVG is in discount" : "FVG is in premium"); else failed.push(bullish ? "FVG is not in discount" : "FVG is not in premium");
    const sweep = sweeps.filter(s => s.direction === z.direction && s.index <= confirmIndex && confirmIndex - s.index <= 30).sort((a,b)=>b.index-a.index)[0] ?? null;
    if (sweep) passed.push("Directional liquidity sweep and reclaim");
    const alignedHtf = Object.entries(opts.higherTimeframes ?? {}).filter(([, r]) => r && r.length >= 40).map(([tf,r]) => {
      const s = analyzeStructure(r!, findPivots(r!));
      return { timeframe: tf, stance: s.stance };
    });
    const htfAligned = alignedHtf.length > 0 && alignedHtf.some(h => h.stance === z.direction);
    const htfOpposed = alignedHtf.some(h => h.stance !== "neutral" && h.stance !== z.direction);
    if (htfAligned) passed.push("Higher-timeframe structure agrees");
    if (htfOpposed) failed.push("At least one higher timeframe opposes the setup");
    const higherPriority = zones.filter(x => x.direction === z.direction && x.status === "fresh" && (bullish ? x.lower < z.lower : x.upper > z.upper)).length === 0;
    if (higherPriority) passed.push(bullish ? "Highest-priority lower bullish FVG" : "Highest-priority upper bearish FVG");
    else failed.push("A more favourably positioned fresh FVG exists");

    let firstTouch = -1;
    for (let i = confirmIndex + 1; i <= currentIndex; i++) {
      const c = rows[i], touched = bullish ? c[3] <= z.upper : c[2] >= z.lower;
      if (touched) { firstTouch = i; break; }
    }
    // A first retest may still validate the original fresh setup, but it no longer receives the green unmitigated highlight.
    const freshBeforeFirstRetest = fresh || (firstTouch >= 0 && z.touches === 1 && z.ageBars === currentIndex - confirmIndex);
    const hardPass = freshBeforeFirstRetest && !!bos && !!impulse && !!level && correctHalf && !htfOpposed && higherPriority;
    let reaction = { confirmed: false, time: null as number | null, close: null as number | null, ageBars: null as number | null, distanceAtr: null as number | null, reason: "Awaiting first retest and a closed reaction candle" };
    if (firstTouch >= 0) {
      const c = rows[firstTouch], closeValid = bullish ? c[4] >= z.lower : c[4] <= z.upper;
      const directionClose = bullish ? c[4] >= c[1] : c[4] <= c[1];
      const noFarClose = bullish ? c[4] >= z.lower : c[4] <= z.upper;
      const ageBars = currentIndex - firstTouch, distanceAtr = Math.abs(price - zoneMid) / atr;
      const timely = ageBars <= FVG_PRECISION_RULES.maxRetestAgeBars, actionable = distanceAtr <= FVG_PRECISION_RULES.maxEntryDistanceAtr;
      const confirmed = closeValid && directionClose && noFarClose && timely && actionable;
      const reason = !closeValid || !directionClose || !noFarClose ? "First retest failed the directional candle-close rule" : !timely ? "First-retest confirmation expired" : !actionable ? "Price moved too far from the entry zone; setup is stale" : "First retest closed directionally and remains actionable";
      reaction = { confirmed, time: c[0], close: c[4], ageBars, distanceAtr: round(distanceAtr, 3), reason };
      if (confirmed) passed.push("First-retest candle reaction confirmed"); else failed.push("First-retest candle reaction failed");
    }
    const state: PrecisionZoneState = !hardPass ? "rejected" : firstTouch < 0 ? "qualified_fresh" : reaction.confirmed ? "confirmed" : "rejected";
    const entryPrice = roundPrice(zoneMid, precision);
    const swing = bullish ? structure.lastSwingLow : structure.lastSwingHigh;
    const structuralStop = swing?.price ?? (bullish ? z.lower : z.upper);
    const boundaryStop = bullish ? z.lower : z.upper;
    const rawStop = bullish ? Math.min(structuralStop, boundaryStop) - atr * FVG_PRECISION_RULES.atrStopBuffer : Math.max(structuralStop, boundaryStop) + atr * FVG_PRECISION_RULES.atrStopBuffer;
    const stopLoss = roundPrice(rawStop, precision), risk = Math.abs(entryPrice - stopLoss);
    const targetPivots = pivots.filter(p => bullish ? p.kind === "high" && p.price > entryPrice : p.kind === "low" && p.price < entryPrice)
      .sort((a,b)=>bullish ? a.price-b.price : b.price-a.price);
    const pools = liquidityPools.filter(p => bullish ? p.side === "buy_side" && p.price > entryPrice : p.side === "sell_side" && p.price < entryPrice)
      .sort((a,b)=>bullish ? a.price-b.price : b.price-a.price);
    const targetPrices = [...new Set([...pools.slice(0,3).map(p=>({price:p.price,source:"external liquidity"})), ...targetPivots.slice(0,5).map(p=>({price:p.price,source:"confirmed swing"}))].map(x=>x.price))];
    const targets = targetPrices.map(t=>({price:roundPrice(t,precision),rewardRisk:round(Math.abs(t-entryPrice)/(risk||Infinity),2),source:pools.some(p=>p.price===t)?"liquidity pool":"confirmed swing"}))
      .filter(t=>t.rewardRisk >= (opts.minRewardRisk ?? FVG_PRECISION_RULES.minRewardRisk)).slice(0,3);
    const rr = targets[0]?.rewardRisk ?? null;
    if (rr !== null) passed.push("At least one structural target meets minimum reward/risk");
    else failed.push("No verified liquidity/structure target meets minimum reward/risk");
    const score = clamp(Math.round((fresh?15:0)+(bos?15:0)+(impulse?10:0)+(level?10:0)+(correctHalf?10:0)+(sweep?10:0)+(htfAligned?10:0)+(reaction.confirmed?10:0)+(higherPriority?5:0)+(orderBlock?5:0)),0,100);
    const tradableState = state === "confirmed" && hardPass && reaction.confirmed && targets.length > 0;
    const highlight: PrecisionCandidate["highlight"] = hardPass && fresh ? "green" : state === "rejected" ? "red" : "yellow";
    if (hardPass && fresh) explanation.push("Green: fresh, unmitigated FVG passed all pre-entry qualification filters.");
    if (firstTouch < 0 && hardPass) explanation.push("Entry remains pending; wait for the first retest and candle-close confirmation.");
    if (reaction.confirmed) explanation.push("First retest reaction is confirmed; midpoint remains the planned limit reference, subject to live price and spread.");
    if (htfOpposed) explanation.push("Higher-timeframe disagreement blocks execution.");
    if (!targets.length) explanation.push("No structural target satisfies the configured minimum reward/risk; no trade.");
    result.push({
      id:z.id,direction,timeframe,zone:{lower:z.lower,upper:z.upper,midpoint:roundPrice(zoneMid,precision)},
      state:tradableState?"confirmed":(state==="confirmed"?"rejected":state),highlight,
      entry:{price:entryPrice,method:"consequent_encroachment_50",execution:reaction.confirmed?"limit_pending":"confirmation_required"},
      stopLoss,targets,riskReward:rr,score,scoreType:"evidence_quality_not_probability",passed,failed,bos:bos?{type:bos.type,time:bos.time,level:bos.level}:null,
      displacementAtr:round(displacementAtr,3),supportResistance:level?{kind:level.kind,price:level.price,strength:level.strength}:null,orderBlock:orderBlock?{lower:orderBlock.low,upper:orderBlock.high,hasFvg:orderBlock.hasFVG,breaksStructure:orderBlock.breaksStructure}:null,
      dealingRange:pd?{low:pd.rangeLow,high:pd.rangeHigh,positionPct:pd.positionPct,zone:pd.zone}:null,
      liquiditySweep:sweep?{direction:sweep.direction,time:sweep.time,level:sweep.level}:null,
      mitigationPct:z.mitigationPct,freshnessBars:z.ageBars,reaction,
      explanation:[...explanation,...failed.slice(0,4)],
    });
  }
  // Keep only fresh qualified zones, first-touch confirmations, and rejected zones for audit; rank best first.
  const rank = (c: PrecisionCandidate) => (c.state==="confirmed"?3:c.state==="qualified_fresh"?2:1)*1000+c.score;
  result.sort((a,b)=>rank(b)-rank(a) || (a.direction==="BUY"?a.zone.lower-b.zone.lower:b.zone.upper-a.zone.upper));
  const candidates = result.slice(0,FVG_PRECISION_RULES.maxCandidates);
  const best = candidates.find(c=>c.state==="confirmed"&&c.targets.length>0) ?? candidates.find(c=>c.state==="qualified_fresh") ?? null;
  const direction = best?.state==="confirmed" ? best.direction : "WAIT";
  return { ...(opts.symbol?{symbol:opts.symbol}:{}), timeframe,status:"ready",price,direction,best,candidates,
    summary:{bullish:candidates.filter(c=>c.direction==="BUY").length,bearish:candidates.filter(c=>c.direction==="SELL").length,green:candidates.filter(c=>c.highlight==="green").length,confirmed:candidates.filter(c=>c.state==="confirmed").length,rejected:candidates.filter(c=>c.state==="rejected").length},
    rules:{...FVG_PRECISION_RULES},canTriggerTrade:false,submitsOrder:false,liveExecutionAllowed:false,
    methodology:"FVG boundaries follow the three-candle definition. Freshness is strict: any wick entering the zone removes the green state. Green means all pre-entry filters passed (fresh, prior same-direction BOS/CHoCH, displacement, S/R overlap, correct premium/discount half, no opposing HTF structure, and directional priority). A first retest is separately checked for a closed directional reaction. The 50% midpoint is the reference entry; stop uses the farther of the structural swing and far FVG edge plus an ATR buffer; targets must be verified swing/liquidity levels meeting the minimum RR. Scores describe evidence quality, not probability. This engine cannot submit or authorize orders." };
}
