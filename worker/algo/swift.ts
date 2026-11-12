// Swift-inspired engine: volume-weighted momentum, dual EMA, ATR intelligence, adaptive trailing bands,
// EMA trend filter and eight-timeframe consensus. Independent implementation from public concepts.
import { adaptiveBands, atrSeries, dualEma, emaFilter, volatility, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { computeLevels } from "./levels.ts";
import { EXECUTION_TF, HOLDING_PERIOD, TF_SECONDS, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Timeframe, type TimeframeAnalysis } from "./timeframes.ts";
import type { EngineInput, EngineSignal } from "./engine.ts";

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function swiftEngine(inp: EngineInput): EngineSignal {
  const now = inp.now ?? Date.now(), execTf = EXECUTION_TF[inp.strategy];
  const base = { engine: "swift" as const, symbol: inp.symbol, confidenceType: "heuristic_score_not_probability" as const, expectedHolding: HOLDING_PERIOD[inp.strategy], generatedAt: new Date(now).toISOString() };
  const neutral = (why: string[], extra: Partial<EngineSignal> = {}): EngineSignal => ({ ...base, status: "NEUTRAL", direction: 0, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, regime: "unknown", evidence: why, invalidation: [], expiresAt: null, details: {}, ...extra });

  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const r = inp.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const rows = inp.candles[execTf];
  if (!rows || !analyses[execTf]) return neutral([`Execution timeframe ${execTf} has fewer than 100 valid candles`]);
  const age = (now - rows.at(-1)![0]) / 1000;
  if (age < -60 || age > TF_SECONDS[execTf] * 3) return neutral([`Execution candles are stale (${Math.round(age)}s old)`]);

  const consensus = buildConsensus(analyses, inp.strategy);
  const regime = classifyRegime(rows);
  if (!regime.profile.allowNewEntries) return neutral([`Regime ${regime.regime} suspends new entries`], { regime: regime.regime });
  if (consensus.direction === "neutral") return neutral(["Eight-timeframe consensus is neutral", ...consensus.conflicts], { regime: regime.regime, details: { consensus } });

  const dir: 1 | -1 = consensus.direction === "bull" ? 1 : -1;
  const a = atrSeries(rows).at(-1)!, vol = volatility(rows), vm = volumeMomentum(rows), bands = adaptiveBands(rows), de = dualEma(rows, 12, 26, a), ef = emaFilter(rows, [20, 50, 200], a), st = marketStructure(rows);

  // Independent confirmations. A single component, including a crossover, never produces a signal on its own.
  const checks = [
    { name: "adaptive bands", ok: bands.trend === (dir > 0 ? "bull" : "bear"), against: bands.trend === (dir > 0 ? "bear" : "bull") && bands.reversalConfirmed },
    { name: "volume-weighted momentum", ok: vm.score * dir >= 15 && vm.volumeConfirmsPrice, against: vm.score * dir <= -25 },
    { name: "dual EMA", ok: de.slope * dir > 0 && de.state === (dir > 0 ? "bull" : "bear"), against: de.crossConfirmed && de.crossover === (dir > 0 ? "bearish" : "bullish") },
    { name: "EMA trend filter", ok: ef.alignment === (dir > 0 ? "bull" : "bear"), against: ef.alignment === (dir > 0 ? "bear" : "bull") },
  ];
  const confirmed = checks.filter(c => c.ok).length, opposing = checks.filter(c => c.against);
  const evidence = [`Consensus ${consensus.bullish}B/${consensus.bearish}S/${consensus.neutral}N, score ${consensus.weightedScore}`, ...checks.map(c => `${c.name}: ${c.ok ? "confirms" : c.against ? "OPPOSES" : "neutral"}`),
    `Volume momentum ${vm.score}, relative volume ${vm.relativeVolume.toFixed(2)}`, `ATR ${vol.atrPercent.toFixed(2)}% (${vol.classification})`, `Regime ${regime.regime}`];
  if (vm.exhaustion) evidence.push("Momentum exhaustion detected: volume fading after extended move");
  if (de.exhaustionRisk) evidence.push("EMA separation is stretched and decelerating");
  const details = { consensus, bands, volumeMomentum: vm, dualEma: de, emaFilter: ef, volatility: vol, structure: { bias: st.bias, support: st.support, resistance: st.resistance } };

  // Invalidation: the multi-timeframe lean is contradicted by confirmed independent evidence on the execution timeframe.
  if (opposing.length >= 2 || (bands.choppy && confirmed < 2)) {
    return { ...base, status: "INVALIDATED", direction: dir, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, regime: regime.regime, evidence: [...evidence, `Invalidated: ${opposing.map(o => o.name).join(", ") || "choppy bands without confirmation"}`], invalidation: [], expiresAt: null, details };
  }
  if (confirmed < Math.max(2, Math.min(regime.profile.minConfirmations - 1, 3))) return neutral([...evidence, `Only ${confirmed}/4 independent confirmations; HOLD is a valid outcome`], { regime: regime.regime, details });

  const levels = computeLevels(rows.at(-1)![4], dir, a, vol.classification, st, { stopMult: regime.profile.stopMult, maxStopPct: inp.maxStopPct ?? 5 });
  if (levels.exceedsMaxStop) return neutral([...evidence, "Structural stop exceeds the maximum permitted stop distance"], { regime: regime.regime, details });
  const expires = now + TF_SECONDS[execTf] * 8 * 1000;
  const confidence = Math.round(clamp(0.45 * consensus.confidence + 0.35 * (confirmed / 4) * 100 + 0.2 * Math.min(100, Math.abs(vm.score) * 1.5) - opposing.length * 10 - (vm.exhaustion ? 10 : 0)));
  return { ...base, status: "SIGNAL", direction: dir, entryZone: levels.entryZone, stopLoss: levels.stop, takeProfits: levels.targets.map(t => ({ label: t.label, price: t.price, rewardRisk: t.rewardRisk })), confidence, regime: regime.regime, evidence,
    invalidation: [`Close beyond stop ${levels.stop.toFixed(4)}`, "Adaptive band flips against the position with volume confirmation", `Signal expires ${new Date(expires).toISOString()}`, "Stops are never widened to avoid a loss"], expiresAt: new Date(expires).toISOString(), details: { ...details, levels } };
}
