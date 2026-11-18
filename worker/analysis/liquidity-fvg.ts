// ETI Liquidity + FVG fusion intelligence.
// Uses closed candles only. Manipulation scores describe observable stop-run conditions,
// not intent or certainty. This module is advisory; the existing Risk Manager and execution
// pathway remain the only authorities allowed to approve and submit an order.
import type { Kline } from "../market.ts";
import { lastAtr } from "./atr.ts";
import { analyzeFvgPrecision, type FvgPrecisionResult } from "./fvg-precision.ts";
import { detectDisplacement, detectLiquiditySweeps, findLiquidityPools } from "./smc.ts";
import { findPivots, analyzeStructure } from "./structure.ts";
import { clamp, round } from "./types.ts";

export interface LiquidityPoolIntel {
  id: string; side: "buy_side" | "sell_side"; price: number; touches: number;
  distanceAtr: number; distancePct: number; freshness: "near" | "watch" | "distant";
  sweepRisk: number; estimatedSweepBand: { low: number; high: number };
  status: "intact" | "swept_and_reclaimed" | "breakout_unconfirmed";
}
export interface ManipulationAssessment {
  score: number; level: "low" | "moderate" | "elevated" | "high";
  label: "stop_run_risk" | "liquidity_grab_risk" | "breakout_risk" | "normal";
  likelySide: "buy_side" | "sell_side" | "both" | "none";
  likelySweepPrice: number | null;
  estimatedReach: { low: number; high: number } | null;
  evidence: string[]; caveat: string;
}
export interface LiquidityFvgResult {
  schema: "eti.liquidity-fvg/1"; symbol?: string; timeframe: string; status: "ready" | "insufficient_history";
  price: number | null; direction: "BUY" | "SELL" | "WAIT"; score: number;
  pools: LiquidityPoolIntel[]; latestSweep: { side: "buy_side" | "sell_side"; direction: "BUY" | "SELL"; level: number; time: number; reclaimed: boolean; extensionAtr: number } | null;
  manipulation: ManipulationAssessment; precision: FvgPrecisionResult | null;
  setup: { direction: "BUY" | "SELL"; entry: number; stopLoss: number | null; targets: { price: number; rewardRisk: number; source: string }[]; fvg: { lower: number; upper: number; midpoint: number }; rewardRisk: number | null } | null;
  autopilotEligible: boolean; eligibilityReasons: string[]; blocks: string[];
  safety: { advisoryOnly: true; submitsOrder: false; bypassesRiskManager: false; liveExecutionAllowed: false };
  methodology: string;
}
const CAVEAT = "This estimates observable liquidity-seeking and stop-run conditions from price data. It cannot identify intent, hidden orders, or a guaranteed manipulation price.";
const LEVEL: ManipulationAssessment["level"] = "low";
const emptyManipulation = (): ManipulationAssessment => ({ score: 0, level: LEVEL, label: "normal", likelySide: "none", likelySweepPrice: null, estimatedReach: null, evidence: ["Insufficient closed-candle evidence."], caveat: CAVEAT });
const median = (v: number[]) => { const a = [...v].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };

/** Analyze one execution timeframe plus optional higher-timeframe closed candles. */
export function analyzeLiquidityFvg(
  rows: Kline[], timeframe: string,
  opts: { symbol?: string; higherTimeframes?: Partial<Record<string, Kline[]>>; minScore?: number; minRewardRisk?: number } = {},
): LiquidityFvgResult {
  const base = {
    schema: "eti.liquidity-fvg/1" as const, ...(opts.symbol ? { symbol: opts.symbol } : {}), timeframe,
    status: "insufficient_history" as const, price: rows?.at(-1)?.[4] ?? null, direction: "WAIT" as const, score: 0,
    pools: [] as LiquidityPoolIntel[], latestSweep: null, manipulation: emptyManipulation(), precision: null,
    setup: null, autopilotEligible: false, eligibilityReasons: [] as string[], blocks: ["At least 40 closed candles are required."],
    safety: { advisoryOnly: true as const, submitsOrder: false as const, bypassesRiskManager: false as const, liveExecutionAllowed: false as const },
    methodology: "Closed-candle liquidity pools, sweep/reclaim evidence, ATR excursion envelopes, structure and institutional FVG precision are fused. Manipulation is a probabilistic risk estimate, never a claim of intent.",
  };
  if (!Array.isArray(rows) || rows.length < 40) return base;
  const price = rows.at(-1)![4], atr = lastAtr(rows);
  if (!(atr > 0) || !Number.isFinite(price)) return { ...base, price: Number.isFinite(price) ? price : null, blocks: ["ATR or latest close is invalid."] };
  const pivots = findPivots(rows), pools = findLiquidityPools(rows, pivots), sweeps = detectLiquiditySweeps(rows, pivots, 50);
  const structure = analyzeStructure(rows, pivots), displacement = detectDisplacement(rows, 80);
  const lastSweep = [...sweeps].reverse().find(s => rows.length - 1 - s.index <= 30) ?? null;
  const excursionBySide = (side: "buy_side" | "sell_side") => sweeps.filter(s => s.side === side).map(s => {
    const bar = rows[s.index], over = side === "buy_side" ? Math.max(0, bar[2] - s.level) : Math.max(0, s.level - bar[3]);
    return over / atr;
  }).filter(Number.isFinite);
  const extBuy = excursionBySide("buy_side"), extSell = excursionBySide("sell_side");
  const poolIntel: LiquidityPoolIntel[] = pools.map((p,i) => {
    const dist = Math.abs(p.price - price) / atr;
    const recentSweep = sweeps.some(s => s.side === p.side && Math.abs(s.level-p.price) <= atr*0.2 && rows.length-1-s.index <= 30);
    const distancePoints = dist <= 0.5 ? 25 : dist <= 1.25 ? 20 : dist <= 2.5 ? 12 : dist <= 5 ? 5 : 0;
    const touchPoints = Math.min(20, Math.max(0,p.touches-1)*8);
    const sweepRisk = Math.round(clamp(distancePoints + touchPoints + (recentSweep ? 25 : 0),0,100));
    const ext = median(p.side === "buy_side" ? extBuy : extSell);
    const minExt = Math.max(0.1, ext || 0.2), maxExt = Math.max(minExt + 0.15, Math.min(2, ext ? ext*1.8 : 0.65));
    const lo = p.side === "buy_side" ? p.price + atr*minExt : p.price - atr*maxExt;
    const hi = p.side === "buy_side" ? p.price + atr*maxExt : p.price - atr*minExt;
    return { id: p.side+":"+i+":"+round(p.price,8), side:p.side, price:p.price, touches:p.touches, distanceAtr:round(dist,2), distancePct:round(Math.abs(p.price-price)/price*100,3), freshness:dist<=1.25?"near":dist<=3?"watch":"distant", sweepRisk,
      estimatedSweepBand:{low:round(Math.min(lo,hi),8),high:round(Math.max(lo,hi),8)}, status:recentSweep?"swept_and_reclaimed":"intact" };
  }).sort((a,b)=>b.sweepRisk-a.sweepRisk || a.distanceAtr-b.distanceAtr).slice(0,16);
  const nearestBuy = poolIntel.filter(p=>p.side==="buy_side"&&p.price>price).sort((a,b)=>a.distanceAtr-b.distanceAtr)[0];
  const nearestSell = poolIntel.filter(p=>p.side==="sell_side"&&p.price<price).sort((a,b)=>a.distanceAtr-b.distanceAtr)[0];
  const latestSweep = lastSweep ? {
    side:lastSweep.side, direction:lastSweep.direction==="bullish"?"BUY" as const:"SELL" as const,
    level:lastSweep.level,time:lastSweep.time,reclaimed:lastSweep.reclaimed,
    extensionAtr:round((lastSweep.side==="buy_side" ? Math.max(0,rows[lastSweep.index][2]-lastSweep.level) : Math.max(0,lastSweep.level-rows[lastSweep.index][3]))/atr,3),
  } : null;
  const nearPool = poolIntel.filter(p=>p.distanceAtr<=2.5).sort((a,b)=>b.sweepRisk-a.sweepRisk)[0] ?? null;
  const evidence: string[] = [];
  let manipulationScore = 0;
  if (nearPool) { manipulationScore += Math.min(35,nearPool.sweepRisk*0.35); evidence.push(nearPool.touches+" clustered "+nearPool.side.replace("_"," ")+" touches at "+nearPool.price+" ("+nearPool.distanceAtr+" ATR away)."); }
  if (lastSweep) { manipulationScore += 30; evidence.push("Recent wick-through and reclaim of "+lastSweep.side.replace("_"," ")+" liquidity at "+lastSweep.level+"."); }
  const latest = rows.at(-1)!, body = Math.abs(latest[4]-latest[1]), range = Math.max(atr*0.01,latest[2]-latest[3]);
  const upperWick = latest[2]-Math.max(latest[1],latest[4]), lowerWick = Math.min(latest[1],latest[4])-latest[3];
  const wickRatio = Math.max(upperWick,lowerWick)/range;
  if (wickRatio>=0.55 && body/range<=0.4) { manipulationScore += 12; evidence.push("Recent candle has a rejection wick exceeding 55% of its range."); }
  const recentDisplacement = displacement.some(d=>rows.length-1-d.index<=5 && d.bodyAtr>=1.3);
  if (recentDisplacement) { manipulationScore += 8; evidence.push("Recent ATR-normalized displacement followed the liquidity event."); }
  if (nearPool?.touches>=3) { manipulationScore += 10; evidence.push("Repeated equal-level tests increase stop-cluster risk."); }
  manipulationScore = Math.round(clamp(manipulationScore,0,100));
  const likelySide = lastSweep ? lastSweep.side : nearPool ? nearPool.side : nearestBuy && nearestSell ? "both" : nearestBuy ? "buy_side" : nearestSell ? "sell_side" : "none";
  const chosenPool = lastSweep ? poolIntel.find(p=>p.side===lastSweep.side) : nearPool;
  const likelySweepPrice = lastSweep?.level ?? chosenPool?.price ?? null;
  const estimatedReach = chosenPool?.estimatedSweepBand ?? null;
  const manipulation: ManipulationAssessment = {
    score:manipulationScore,level:manipulationScore>=75?"high":manipulationScore>=50?"elevated":manipulationScore>=25?"moderate":"low",
    label:lastSweep?"liquidity_grab_risk":nearPool&&nearPool.distanceAtr<=1.25?"stop_run_risk":"normal",
    likelySide,likelySweepPrice,estimatedReach,evidence:evidence.length?evidence:["No strong stop-run evidence in the current closed-candle sample."],caveat:CAVEAT,
  };
  const precision = analyzeFvgPrecision(rows,timeframe,{symbol:opts.symbol,higherTimeframes:opts.higherTimeframes,minRewardRisk:opts.minRewardRisk});
  const candidate = precision.best;
  const reasons: string[] = [], blocks: string[] = [];
  const sweepAligned = !!candidate?.liquiditySweep && candidate.liquiditySweep.direction === (candidate.direction==="BUY"?"bullish":"bearish") && rows.length-1-(rows.findIndex(r=>r[0]===candidate.liquiditySweep!.time))<=30;
  if (candidate?.state==="confirmed") reasons.push("FVG first retest is confirmed.");
  else blocks.push("No confirmed, actionable FVG first-retest setup.");
  if (sweepAligned) reasons.push("A recent same-direction liquidity sweep/reclaim preceded the FVG.");
  else blocks.push("No recent same-direction liquidity sweep/reclaim is aligned with the FVG.");
  const opposing = candidate?.direction==="BUY" ? nearestBuy : candidate?.direction==="SELL" ? nearestSell : null;
  if (candidate && candidate.targets.length && candidate.riskReward !== null && candidate.riskReward >= (opts.minRewardRisk ?? 2)) reasons.push("Verified opposing liquidity/structure target meets minimum reward-to-risk.");
  else blocks.push("No verified target meets the configured minimum reward-to-risk.");
  const structureAligned = candidate ? structure.stance=== (candidate.direction==="BUY"?"bullish":"bearish") : false;
  if (structureAligned) reasons.push("Execution-timeframe structure agrees with the candidate.");
  else blocks.push("Execution-timeframe structure does not confirm the candidate direction.");
  if (opposing && opposing.distanceAtr<0.35) blocks.push("Price is already too close to the next opposing liquidity pool; reward room is compressed.");
  const score = Math.round(clamp((candidate?.score ?? 0)*0.7 + (sweepAligned?15:0) + (structureAligned?10:0) + (manipulationScore>=25?5:0),0,100));
  const minScore = opts.minScore ?? 75;
  const autopilotEligible = !!candidate && candidate.state==="confirmed" && sweepAligned && structureAligned && !!candidate.stopLoss && candidate.targets.length>0 && (candidate.riskReward ?? 0)>=(opts.minRewardRisk ?? 2) && score>=minScore && blocks.length===0;
  if (autopilotEligible) reasons.push("Combined Liquidity-FVG quality gate passed; existing council, strategy and Risk Manager gates remain mandatory.");
  else if (score<minScore) blocks.push("Combined evidence score is below the configured minimum of "+minScore+".");
  return {
    schema:"eti.liquidity-fvg/1",...(opts.symbol?{symbol:opts.symbol}:{}),timeframe,status:"ready",price,direction:autopilotEligible?candidate!.direction:"WAIT",score,
    pools:poolIntel,latestSweep,manipulation,precision,
    setup:autopilotEligible?{direction:candidate!.direction,entry:candidate!.entry.price,stopLoss:candidate!.stopLoss,targets:candidate!.targets,fvg:candidate!.zone,rewardRisk:candidate!.riskReward}:null,
    autopilotEligible,eligibilityReasons:reasons,blocks:[...new Set(blocks)],
    safety:{advisoryOnly:true,submitsOrder:false,bypassesRiskManager:false,liveExecutionAllowed:false},
    methodology:"Liquidity pools are equal swing highs/lows clustered within the existing SMC ATR tolerance. Sweeps require a wick through a pool or swing and a reclaim within the existing two-bar rule. Sweep-reach bands are ATR-scaled empirical envelopes from observed overshoots (or conservative defaults), not exact predictions. Manipulation score measures stop-run conditions from clustered levels, proximity, rejection wicks and recent displacement; it cannot infer intent. Autopilot eligibility requires a confirmed precision FVG, same-direction sweep/reclaim, structural alignment, verified target and score threshold. Existing multi-agent consensus, strategy agreement, Risk Manager, kill switch and execution controls remain authoritative.",
  };
}
