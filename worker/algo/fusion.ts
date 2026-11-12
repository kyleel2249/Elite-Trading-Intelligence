// Omnisignal fusion: agreement/disagreement detection and evidence-based resolution between the two engines.
// Disagreements are never settled by majority vote. Each candidate direction is investigated against
// independent evidence families (higher timeframes, structure, volume flow, liquidity, regime).
import { volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { analyzeLiquidity, liquidityForDirection } from "./liquidity.ts";
import { EXECUTION_TF, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Timeframe, type TimeframeAnalysis } from "./timeframes.ts";
import type { EngineName, EngineSignal, EngineTarget, FusionContext } from "./engine.ts";

export type Agreement = "BOTH_BULLISH" | "BOTH_BEARISH" | "SWIFT_BULLISH_GAINZ_BEARISH" | "SWIFT_BEARISH_GAINZ_BULLISH" | "ONE_ENGINE_CONFIRMED_OTHER_NEUTRAL" | "BOTH_NEUTRAL" | "BOTH_INVALIDATED";
export interface EvidenceVote { family: string; vote: -1 | 0 | 1; detail: string }
export interface Investigation { votes: EvidenceVote[]; support: Record<"1" | "-1", number>; oppose: Record<"1" | "-1", number>; margin: Record<"1" | "-1", number> }
export interface FusionResult {
  agreement: Agreement; decision: "BUY" | "SELL" | "HOLD"; direction: 1 | -1 | 0;
  acceptedEngine: "both" | EngineName | null; rejectedEngine: { engine: EngineName; reason: string } | null;
  confidence: number; confidenceType: "heuristic_score_not_probability";
  entryZone: [number, number] | null; stopLoss: number | null; takeProfits: EngineTarget[] | null;
  investigation: Investigation | null; reasoning: string[]; swift: EngineSignal; gainz: EngineSignal;
}

const stateOf = (s: EngineSignal): 1 | -1 | 0 | "inv" => (s.status === "SIGNAL" ? s.direction : s.status === "INVALIDATED" ? "inv" : 0);

export function classifyAgreement(swift: EngineSignal, gainz: EngineSignal): Agreement {
  const a = stateOf(swift), b = stateOf(gainz);
  if (a === "inv" && b === "inv") return "BOTH_INVALIDATED";
  if (a === 1 && b === 1) return "BOTH_BULLISH";
  if (a === -1 && b === -1) return "BOTH_BEARISH";
  if (a === 1 && b === -1) return "SWIFT_BULLISH_GAINZ_BEARISH";
  if (a === -1 && b === 1) return "SWIFT_BEARISH_GAINZ_BULLISH";
  if ((a === 1 || a === -1) || (b === 1 || b === -1)) return "ONE_ENGINE_CONFIRMED_OTHER_NEUTRAL";
  return "BOTH_NEUTRAL";
}

/** Independent evidence that does not rely on either engine's own direction. */
export function investigate(ctx: FusionContext, now = ctx.now ?? Date.now()): Investigation | null {
  const execTf = EXECUTION_TF[ctx.strategy], rows = ctx.candles[execTf];
  if (!rows || rows.length < 100) return null;
  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const r = ctx.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const higher = (["4h", "1d", "1w"] as Timeframe[]).filter(t => analyses[t]);
  const hiScore = higher.length ? higher.reduce((s, t) => s + analyses[t]!.trendScore, 0) / higher.length : 0;
  const consensus = buildConsensus(analyses, ctx.strategy);
  const st = marketStructure(rows), vm = volumeMomentum(rows), regime = classifyRegime(rows), price = rows.at(-1)![4];
  const v = (x: number, t: number): -1 | 0 | 1 => (x >= t ? 1 : x <= -t ? -1 : 0);
  const votes: EvidenceVote[] = [
    { family: "higher timeframes", vote: higher.length ? v(hiScore, 20) : 0, detail: higher.length ? `4h/1d/1w mean trend score ${hiScore.toFixed(1)}` : "higher timeframes unavailable" },
    { family: "multi-timeframe consensus", vote: v(consensus.weightedScore, 20), detail: `weighted score ${consensus.weightedScore}` },
    { family: "market structure", vote: st.bias === "bull" ? 1 : st.bias === "bear" ? -1 : 0, detail: `swing bias ${st.bias}` },
    { family: "volume flow", vote: vm.volumeConfirmsPrice ? v(vm.score, 15) : 0, detail: `flow ${vm.score}, confirms price ${vm.volumeConfirmsPrice}` },
  ];
  if (ctx.depth) {
    const la = analyzeLiquidity(ctx.depth, price, now), up = liquidityForDirection(la, 1), dn = liquidityForDirection(la, -1);
    votes.push({ family: "order book / liquidity", vote: la.status === "blocked" ? 0 : up.score >= 60 && up.score > dn.score + 10 ? 1 : dn.score >= 60 && dn.score > up.score + 10 ? -1 : 0, detail: `${la.status}, long score ${up.score.toFixed(0)} vs short score ${dn.score.toFixed(0)}` });
  } else votes.push({ family: "order book / liquidity", vote: 0, detail: "order book unavailable" });
  const regimeBull = regime.regime.includes("bullish"), regimeBear = regime.regime.includes("bearish");
  votes.push({ family: "market regime", vote: regimeBull ? 1 : regimeBear ? -1 : 0, detail: regime.regime });
  const count = (d: 1 | -1, kind: "support" | "oppose") => votes.filter(x => (kind === "support" ? x.vote === d : x.vote === -d)).length;
  const support = { "1": count(1, "support"), "-1": count(-1, "support") }, oppose = { "1": count(1, "oppose"), "-1": count(-1, "oppose") };
  return { votes, support, oppose, margin: { "1": support["1"] - oppose["1"], "-1": support["-1"] - oppose["-1"] } };
}

function mergeLevels(a: EngineSignal, b: EngineSignal, dir: 1 | -1) {
  // Conservative merge: the entry is the mean of both zones, the stop is the TIGHTER valid stop, and each target is the NEARER one.
  const mid = (s: EngineSignal) => (s.entryZone![0] + s.entryZone![1]) / 2;
  const entry = (mid(a) + mid(b)) / 2;
  const stops = [a.stopLoss!, b.stopLoss!].filter(s => (entry - s) * dir > 0);
  if (!stops.length) return null;
  const stop = dir > 0 ? Math.max(...stops) : Math.min(...stops), risk = Math.abs(entry - stop);
  const targets = (["TP1", "TP2", "TP3"] as const).map((label, i) => {
    const prices = [a.takeProfits![i].price, b.takeProfits![i].price];
    const price = dir > 0 ? Math.min(...prices) : Math.max(...prices);
    return { label, price, rewardRisk: Number((Math.abs(price - entry) / risk).toFixed(2)) };
  });
  const zone: [number, number] = [Math.min(a.entryZone![0], b.entryZone![0]), Math.max(a.entryZone![1], b.entryZone![1])];
  return { entryZone: zone, stopLoss: stop, takeProfits: targets };
}

export interface FuseOptions { expectancyR?: number | null; expectancySamples?: number; disagreementMargin?: number; singleEngineMargin?: number }

export function fuseEngines(swift: EngineSignal, gainz: EngineSignal, ctx: FusionContext, o: FuseOptions = {}): FusionResult {
  const agreement = classifyAgreement(swift, gainz);
  const reasoning: string[] = [`Swift: ${swift.status}${swift.direction ? (swift.direction > 0 ? " long" : " short") : ""} (${swift.confidence}); Gainz: ${gainz.status}${gainz.direction ? (gainz.direction > 0 ? " long" : " short") : ""} (${gainz.confidence}); outcome ${agreement}`];
  const inv = investigate(ctx);
  const base = { agreement, confidenceType: "heuristic_score_not_probability" as const, investigation: inv, swift, gainz };
  const hold = (why: string, rejected: FusionResult["rejectedEngine"] = null): FusionResult => ({ ...base, decision: "HOLD", direction: 0, acceptedEngine: null, rejectedEngine: rejected, confidence: 0, entryZone: null, stopLoss: null, takeProfits: null, reasoning: [...reasoning, why] });
  if (agreement === "BOTH_NEUTRAL" || agreement === "BOTH_INVALIDATED") return hold(agreement === "BOTH_NEUTRAL" ? "Neither engine has a confirmed setup: HOLD" : "Both engines invalidated their candidates: HOLD");
  if (!inv) return hold("Independent investigation unavailable (insufficient execution-timeframe data): HOLD");
  if (o.expectancyR !== undefined && o.expectancyR !== null && o.expectancyR <= 0) return hold(`Validated expectancy is not positive (${o.expectancyR.toFixed(2)}R over ${o.expectancySamples ?? "?"} samples): HOLD`);
  const dm = o.disagreementMargin ?? 3, sm = o.singleEngineMargin ?? 2;
  const dirName = (d: 1 | -1) => (d > 0 ? "bullish" : "bearish");
  const key = (d: 1 | -1) => String(d) as "1" | "-1";
  const accept = (engine: "both" | EngineName, dir: 1 | -1, confidence: number, lv: ReturnType<typeof mergeLevels>, rejected: FusionResult["rejectedEngine"]): FusionResult => {
    if (!lv) return hold("Engine stops are not valid for the merged entry: HOLD", rejected);
    return { ...base, decision: dir > 0 ? "BUY" : "SELL", direction: dir, acceptedEngine: engine, rejectedEngine: rejected, confidence: Math.round(Math.max(0, Math.min(100, confidence))), ...lv, reasoning };
  };
  const single = (s: EngineSignal) => ({ entryZone: s.entryZone!, stopLoss: s.stopLoss!, takeProfits: s.takeProfits! });

  if (agreement === "BOTH_BULLISH" || agreement === "BOTH_BEARISH") {
    const d = swift.direction as 1 | -1;
    if (inv.oppose[key(d)] >= 3) return hold(`Both engines are ${dirName(d)} but ${inv.oppose[key(d)]} independent evidence families oppose it: HOLD`);
    // Agreement raises confidence only modestly: two engines on the same candles are correlated, so confidences are not summed.
    reasoning.push(`Engines agree ${dirName(d)}; independent evidence margin ${inv.margin[key(d)]} (not contradicted)`);
    return accept("both", d, Math.max(swift.confidence, gainz.confidence) + 0.2 * Math.min(swift.confidence, gainz.confidence) - 5 * inv.oppose[key(d)], mergeLevels(swift, gainz, d), null);
  }
  if (agreement === "SWIFT_BULLISH_GAINZ_BEARISH" || agreement === "SWIFT_BEARISH_GAINZ_BULLISH") {
    const sd = swift.direction as 1 | -1, gd = gainz.direction as 1 | -1, ms = inv.margin[key(sd)], mg = inv.margin[key(gd)];
    reasoning.push(`Disagreement: Swift ${dirName(sd)} (independent margin ${ms}) vs Gainz ${dirName(gd)} (independent margin ${mg}). Investigated higher timeframes, structure, volume, liquidity and regime.`);
    const winner = ms >= dm && ms > mg ? "swift" : mg >= dm && mg > ms ? "gainz" : null;
    if (!winner) return hold(`Independent evidence does not justify either side (needs margin >= ${dm} and a lead over the other): HOLD`);
    const w = winner === "swift" ? swift : gainz, l = winner === "swift" ? gainz : swift, wd = w.direction as 1 | -1;
    const rejected = { engine: l.engine, reason: `Independent evidence supports ${dirName(wd)} (margin ${inv.margin[key(wd)]}) over ${dirName(l.direction as 1 | -1)} (margin ${inv.margin[key(l.direction as 1 | -1)]}); ${l.engine} rejected` };
    reasoning.push(rejected.reason);
    return accept(winner, wd, w.confidence * 0.8 - 5 * inv.oppose[key(wd)], { ...single(w) }, rejected);
  }
  // One engine confirmed, the other neutral or invalidated.
  const w = stateOf(swift) === 1 || stateOf(swift) === -1 ? swift : gainz, l = w === swift ? gainz : swift, wd = w.direction as 1 | -1;
  const need = l.status === "INVALIDATED" ? dm : sm;
  if (inv.margin[key(wd)] < need || inv.oppose[key(wd)] > 1) return hold(`${w.engine} signals ${dirName(wd)} but independent evidence margin ${inv.margin[key(wd)]} (< ${need}) or opposition ${inv.oppose[key(wd)]} blocks acceptance: HOLD`, { engine: l.engine, reason: `${l.engine} was ${l.status.toLowerCase()} and independent evidence did not justify acting on ${w.engine} alone` });
  const rej = l.status === "INVALIDATED" ? { engine: l.engine, reason: `${l.engine} invalidated its own candidate; ${w.engine} accepted only because independent evidence margin ${inv.margin[key(wd)]} >= ${need}` } : null;
  reasoning.push(`${w.engine} accepted alone: other engine ${l.status.toLowerCase()}, independent margin ${inv.margin[key(wd)]}`);
  return accept(w.engine, wd, w.confidence * 0.8 - 5 * inv.oppose[key(wd)], single(w), rej);
}
