// ETI PRECISION SIGNAL ENGINE: pure, deterministic orchestration. Given candles, an order-book snapshot and optional
// fundamentals / news / expectancy / calibration inputs, it returns one fully-specified signal: BUY, SELL or NO TRADE.
// It composes the existing ETI algo primitives (timeframe analysis, consensus, levels, liquidity, independent validation)
// and adds net-of-cost reward-to-risk, a configurable 0-100 opportunity score, hard risk gates and calibration-aware confidence.
// It performs no I/O and never submits an order.
import { adaptiveBands, atrSeries, emaFilter, volatility, volumeMomentum } from "../algo/indicators.ts";
import { analyzeLiquidity, liquidityForDirection, type DepthSnapshot } from "../algo/liquidity.ts";
import { computeLevels } from "../algo/levels.ts";
import { classifyRegime } from "../algo/regime.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, HOLDING_PERIOD, TF_SECONDS, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Strategy, type Timeframe, type TimeframeAnalysis, type Consensus } from "../algo/timeframes.ts";
import { DEFAULT_THRESHOLDS, validateSignal, type RiskContext, type ValidationResult } from "../algo/validation.ts";
import type { Kline } from "../market.ts";
import { calibratedConfidence, type CalibrationModel } from "./calibration.ts";
import { DEFAULT_CONFIG, ENGINE_IP, ENGINE_NAME, ENGINE_VERSION, scoreConfigHash, type PrecisionConfig } from "./config.ts";
import { assessFundamentals, assessNews, type FundamentalContext, type NewsContext } from "./context.ts";
import { estimateCosts, netRewardRisk, USD_QUOTES } from "./costs.ts";
import { evaluateGates, summarizeGates } from "./gates.ts";
import { aggregate, scoreSetup } from "./scoring.ts";
import type { AttributionItem, Confidence, Direction, EvidenceItem, GateResult, HigherTimeframeView, MarketId, PrecisionSignal, TakeProfit } from "./types.ts";
import { MINUTE_MS, hash16, roundPrice } from "./util.ts";

export { ENGINE_NAME, ENGINE_VERSION };

export interface PrecisionInput {
  symbol: string;
  strategy: Strategy;
  candles: Partial<Record<Timeframe, Kline[]>>;
  /** Order-book snapshot. Null or undefined means none could be fetched. */
  depth?: DepthSnapshot | null;
  now?: number;
  /** When the market data was fetched (defaults to now). */
  fetchedAt?: number;
  provider?: string;
  providersAgree?: boolean;
  fundamentals?: FundamentalContext | null;
  news?: NewsContext | null;
  /** Measured expectancy in R of this strategy's recorded outcomes. Null when none is available. */
  expectancy?: { expectancyR: number; samples: number } | null;
  calibration?: CalibrationModel | null;
  /** Account-level risk verdict, when the caller can supply one. Without it the account-risk gate is reported as not evaluated. */
  risk?: RiskContext;
  config?: PrecisionConfig;
  configStatus?: "default" | "override_applied" | "override_rejected";
}

export interface Instrument { symbol: string; base: string; quote: string; pair: string; market: MarketId }
const QUOTES = ["FDUSD", "USDT", "USDC", "BUSD", "TUSD", "USD", "EUR", "GBP", "BTC", "ETH", "BNB"];

/** Parse an exchange symbol such as BTCUSDT into base/quote. Returns null when it cannot be recognised as a supported pair. */
export function parseInstrument(symbol: string): Instrument | null {
  const s = symbol.toUpperCase();
  for (const q of QUOTES) if (s.endsWith(q) && s.length - q.length >= 2) { const base = s.slice(0, -q.length); return { symbol: s, base, quote: q, pair: `${base}/${q}`, market: "crypto_spot" }; }
  return null;
}
export const SUPPORTED_MARKETS = [{ id: "crypto_spot" as MarketId, label: "Crypto spot", providers: ["binance", "bybit", "okx"], quotes: QUOTES, usdQuotes: [...USD_QUOTES] }];

const isoOrNull = (t: number | null | undefined) => (t === null || t === undefined || !Number.isFinite(t) ? null : new Date(t).toISOString());
const DISCLAIMERS = [
  "Educational analytical output, not financial advice. Trading carries a risk of loss.",
  "Entry, stop and target prices are reference levels from the last completed candle; fills, slippage and gaps can differ.",
  "The opportunity score is a research-priority ranking, not a probability. Only a validated calibration model produces a probability, and none is assumed.",
  "Past results and simulations do not guarantee future results.",
];

function higherTimeframeView(strategy: Strategy, execTf: Timeframe, analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>>, dir: 1 | -1): HigherTimeframeView {
  const tfs = TIMEFRAMES.filter(tf => TF_SECONDS[tf] >= TF_SECONDS[execTf] * 4 && analyses[tf]);
  if (!tfs.length) return { direction: "unavailable", score: null, timeframes: [], alignsWithTrade: null };
  const w = DEFAULT_WEIGHTS[strategy];
  const wsum = tfs.reduce((s, tf) => s + w[tf], 0);
  const weight = (tf: Timeframe) => (wsum > 0 ? w[tf] / wsum : 1 / tfs.length);
  const score = tfs.reduce((s, tf) => s + weight(tf) * analyses[tf]!.trendScore, 0);
  const direction = score > 20 ? "bullish" : score < -20 ? "bearish" : "neutral";
  return {
    direction, score: Number(score.toFixed(1)),
    timeframes: tfs.map(tf => ({ timeframe: tf, trend: analyses[tf]!.trend, trendScore: analyses[tf]!.trendScore })),
    alignsWithTrade: direction === "neutral" ? null : (direction === "bullish") === (dir > 0),
  };
}

const candidateDirection = (c: Consensus, exec: TimeframeAnalysis): 1 | -1 => ((c.weightedScore !== 0 ? c.weightedScore : exec.trendScore) < 0 ? -1 : 1);
const stanceOf = (vote: number): EvidenceItem["stance"] => (vote > 0 ? "supporting" : vote < 0 ? "opposing" : "neutral");

function evidenceAndAttribution(v: ValidationResult, ctx: { strategy: Strategy; execTf: Timeframe; regimeName: string; preferred: string; htf: HigherTimeframeView; fundamentalsScore: number | null; newsScore: number | null; fundamentalsDetail: string; newsDetail: string }) {
  const evidence: EvidenceItem[] = v.independentEvidence.map(f => ({ family: f.family, stance: stanceOf(f.vote), detail: f.detail }));
  const scoreStance = (s: number | null): EvidenceItem["stance"] => (s === null ? "neutral" : s >= 60 ? "supporting" : s <= 40 ? "opposing" : "neutral");
  evidence.push({ family: "higher timeframes", stance: ctx.htf.alignsWithTrade === null ? "neutral" : ctx.htf.alignsWithTrade ? "supporting" : "opposing", detail: ctx.htf.direction === "unavailable" ? "no higher-timeframe data" : `${ctx.htf.direction} (score ${ctx.htf.score})` });
  evidence.push({ family: "fundamentals", stance: scoreStance(ctx.fundamentalsScore), detail: ctx.fundamentalsDetail });
  evidence.push({ family: "news / events", stance: scoreStance(ctx.newsScore), detail: ctx.newsDetail });

  const fam = (prefix: string) => v.independentEvidence.find(f => f.family.startsWith(prefix));
  const mk = (method: string, family: string, f: { vote: number; detail: string } | undefined, fallback: string): AttributionItem => ({ method, family, stance: f ? stanceOf(f.vote) : "neutral", detail: f ? f.detail : fallback });
  const attribution: AttributionItem[] = [
    mk("EMA 20/50/200 filter and adaptive ATR bands", "trend", fam("trend"), "n/a"),
    mk("Volume-weighted momentum", "volume flow", fam("volume"), "n/a"),
    mk("Swing market structure", "market structure", fam("market structure"), "n/a"),
    mk("Order-book liquidity analysis", "liquidity", fam("order book"), "n/a"),
    mk(`Multi-timeframe consensus (${ctx.strategy} weights)`, "multi-timeframe", fam("multi-timeframe"), "n/a"),
    { method: `Regime classifier (${ctx.regimeName})`, family: "regime", stance: "neutral", detail: `Regime-preferred approach: ${ctx.preferred}` },
    { method: `Strategy profile: ${ctx.strategy}`, family: "profile", stance: "neutral", detail: `${ctx.execTf} setup timeframe; expected holding ${HOLDING_PERIOD[ctx.strategy]}` },
    { method: "ETI opportunity score and risk gates", family: "scoring", stance: "neutral", detail: "Configurable weighted score, with hard risk gates that no score can override" },
  ];
  return { evidence, attribution };
}

interface Header { cfg: PrecisionConfig; now: number; fetchedAt: number; inst: Instrument | null; symbol: string; strategy: Strategy; execTf: Timeframe; configStatus: NonNullable<PrecisionInput["configStatus"]> }

function engineHeader(h: Header): Pick<PrecisionSignal, "engine" | "asset" | "tradingPair" | "ticker" | "market" | "strategy" | "setupTimeframe" | "expectedHolding" | "dataTimestamp" | "disclaimers" | "liveExecutionAllowed" | "execution"> {
  return {
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION, configHash: scoreConfigHash(h.cfg), configStatus: h.configStatus, ownIntellectualProperty: ENGINE_IP },
    asset: { symbol: h.symbol, base: h.inst?.base ?? null, quote: h.inst?.quote ?? null, name: h.inst?.base ?? h.symbol },
    tradingPair: h.inst?.pair ?? h.symbol, ticker: h.symbol, market: h.inst?.market ?? "unsupported",
    strategy: h.strategy, setupTimeframe: h.execTf, expectedHolding: HOLDING_PERIOD[h.strategy],
    dataTimestamp: new Date(h.fetchedAt).toISOString(), disclaimers: DISCLAIMERS,
    liveExecutionAllowed: false,
    execution: { note: "Analytical output only. Orders require POST /api/orders and its in-process paper safeguards; this engine cannot place or authorise a trade.", requiresRiskPreflight: true },
  };
}

/** A complete, honest NO TRADE when the inputs are not sufficient to evaluate a candidate at all. */
function unscorable(h: Header, inp: PrecisionInput, failures: GateResult[]): PrecisionSignal {
  const hash = scoreConfigHash(h.cfg);
  const score = aggregate([], h.cfg);
  const counts: Partial<Record<Timeframe, number>> = {};
  for (const tf of TIMEFRAMES) if (inp.candles[tf]) counts[tf] = inp.candles[tf]!.length;
  return {
    ...engineHeader(h),
    signalId: "eti-ps-" + hash16(`${h.symbol}|${h.strategy}|unscorable|${h.fetchedAt}|${hash}`),
    direction: "NO TRADE", decision: { tradeable: false, reasons: failures.map(f => `${f.label}: ${f.detail}`) },
    entry: null, entryZone: null, stopLoss: null, takeProfits: [], tp3: { included: false, reason: "No trade" },
    riskReward: { grossToFinalTarget: null, netToFinalTarget: null, finalTarget: null }, transactionCosts: null,
    higherTimeframeDirection: { direction: "unavailable", score: null, timeframes: [], alignsWithTrade: null },
    technicalJustification: ["Not enough validated market data to evaluate a setup."],
    fundamentalJustification: { status: "unavailable", asOf: null, source: null, points: ["Not evaluated: no setup could be formed."] },
    relevantNews: { status: "unavailable", asOf: null, source: null, blackoutActive: false, events: [], notes: ["Not evaluated: no setup could be formed."] },
    marketLiquidity: { status: "unavailable", spreadBps: null, imbalance: null, bidDepthQuote: null, askDepthQuote: null, orderBookAgeMs: null, largeOrders: [], issues: ["Not evaluated"], caveat: "Visible resting orders can be cancelled before they fill; this is not guaranteed executable liquidity." },
    volatility: { classification: "normal", atrPercent: 0, percentile: 0, expansion: false, contraction: false, regime: "unknown", stopPercent: null },
    invalidation: [], expiresAt: null, validForBars: 0,
    dataTimestamps: { fetchedAt: new Date(h.fetchedAt).toISOString(), latestCandleOpen: null, orderBook: null },
    confidence: { type: "qualitative", level: "none", calibration: { status: "no_model", reasons: ["no setup to calibrate"] }, note: "No setup was evaluated." },
    supportingEvidence: [], strategyAttribution: [], opportunityScore: score, riskChecks: failures, riskCheckSummary: summarizeGates(failures),
    dataQuality: { provider: inp.provider ?? "unknown", timeframesLoaded: Object.keys(counts) as Timeframe[], candleCounts: counts, orderBook: inp.depth ? "available" : "unavailable", providerCrossCheck: "not_performed", notes: ["Insufficient data to evaluate."] },
  };
}

export function runPrecisionEngine(inp: PrecisionInput): PrecisionSignal {
  const cfg = inp.config ?? DEFAULT_CONFIG;
  const now = inp.now ?? Date.now();
  const strategy = inp.strategy;
  const execTf = EXECUTION_TF[strategy];
  const inst = parseInstrument(inp.symbol);
  const h: Header = { cfg, now, fetchedAt: inp.fetchedAt ?? now, inst, symbol: inp.symbol.toUpperCase(), strategy, execTf, configStatus: inp.configStatus ?? "default" };

  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const r = inp.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const rows = inp.candles[execTf], execA = analyses[execTf];
  if (!inst || !rows || !execA) {
    return unscorable(h, inp, [
      { id: "instrument_supported", label: "Instrument is on a supported market", status: inst ? "pass" : "fail", detail: inst ? "Supported crypto spot pair" : "Not recognised as a supported crypto spot pair" },
      { id: "data_complete", label: "Candle history is complete", status: "fail", detail: `The ${execTf} setup timeframe has fewer than 100 valid candles or is missing` },
    ]);
  }

  const last = rows[rows.length - 1];
  const price = last[4], lastAge = (now - last[0]) / 1000;
  const fresh = lastAge >= -60 && lastAge <= TF_SECONDS[execTf] * 3;
  const consensus = buildConsensus(analyses, strategy);
  const dir = candidateDirection(consensus, execA);
  const regime = classifyRegime(rows);
  const bookAvailable = !!inp.depth;
  const liquidity = bookAvailable ? analyzeLiquidity(inp.depth, price, now, { maxSpreadBps: cfg.gates.maxSpreadBps }) : null;

  const atr = atrSeries(rows).at(-1) as number;
  const vol = volatility(rows), ef = emaFilter(rows, [20, 50, 200], atr), bands = adaptiveBands(rows), vm = volumeMomentum(rows), st = marketStructure(rows);
  const levels = computeLevels(price, dir, atr, vol.classification, st, { stopMult: regime.profile.stopMult, maxStopPct: cfg.gates.maxStopPct });

  const costs = estimateCosts({ entry: levels.entry, direction: dir, stopDistance: levels.stopDistance, quote: inst.quote, depth: inp.depth, liquidity, cfg: cfg.costs });
  const legs = levels.targets.map(t => { const reward = Math.abs(t.price - levels.entry); return { t, reward, net: netRewardRisk(reward, levels.stopDistance, costs.roundTripPrice) }; });
  const tp3Included = levels.targets[2].rewardRisk >= cfg.tp3MinRewardRisk && legs[2].net >= cfg.gates.minNetRewardRisk;
  const fin = tp3Included ? 2 : 1;

  const expectancy = inp.expectancy ?? null;
  const usableExpectancy = expectancy && expectancy.samples >= cfg.minExpectancySamples ? expectancy : null;
  const validation = validateSignal({
    direction: dir, emaFilter: ef, bands, volume: vm, structure: st, consensus, regime, liquidity,
    rewardRiskTP1: levels.targets[0].rewardRisk, rewardRiskTP3: levels.riskRewardToTP3, stopExceedsMax: levels.exceedsMaxStop,
    data: { fresh, providersAgree: inp.providersAgree ?? true, candlesComplete: rows.length >= 100, ageSec: Math.round(lastAge), provider: inp.provider ?? "unknown" },
    risk: inp.risk ?? { withinLimits: true, reasons: [] },
    expectancyR: usableExpectancy ? usableExpectancy.expectancyR : null, expectancySamples: usableExpectancy?.samples,
    thresholds: { ...DEFAULT_THRESHOLDS, minRiskReward: cfg.gates.minNetRewardRisk, maxSpreadBps: cfg.gates.maxSpreadBps },
  });

  const htf = higherTimeframeView(strategy, execTf, analyses, dir);
  const lq = liquidity ? liquidityForDirection(liquidity, dir, cfg.gates.maxSpreadBps) : { score: 0, trapNearby: false, notes: ["Order book unavailable"] };
  const fundamentals = assessFundamentals(inp.fundamentals, dir, now, cfg.context);
  const news = assessNews(inp.news, dir, now, cfg.context, cfg.gates);

  const opportunity = scoreSetup({
    strategy, dir, validation, htf, liquidity, bookAvailable, liquidityScore: lq.score, vol, regime, stopPercent: levels.stopPercent, costInR: costs.costInR,
    netRewardRiskTP1: legs[0].net, netRewardRiskFinal: legs[fin].net, fundamentals, news, expectancy, cfg,
  });

  // Expiry: a fixed number of setup-timeframe bars, shortened so the signal never outlives the start of a news blackout.
  const barMs = TF_SECONDS[execTf] * 1000;
  let expiry = now + cfg.expiryBars * barMs;
  if (news.nextHighImpactAt !== null) expiry = Math.min(expiry, news.nextHighImpactAt - cfg.gates.newsBlackoutBeforeMin * MINUTE_MS);

  const gates = evaluateGates({
    cfg, instrumentSupported: true, consensus, validation, fresh, ageSec: Math.round(lastAge), candlesComplete: rows.length >= 100, bookAvailable, liquidity, trapNearby: lq.trapNearby,
    regime, stopPercent: levels.stopPercent, costs, tp1RewardDistance: legs[0].reward, netRewardRiskTP1: legs[0].net, netRewardRiskFinal: legs[fin].net, news, expectancy, risk: inp.risk, score: opportunity.value, validityMs: expiry - now, barMs,
  });
  const failed = gates.filter(g => g.status === "fail");
  const tradeable = failed.length === 0;
  const direction: Direction = tradeable ? (dir > 0 ? "BUY" : "SELL") : "NO TRADE";
  if (!tradeable) opportunity.interpretation = "Blocked by a failed risk check: the score is informational and does not permit a trade";

  const takeProfits: TakeProfit[] = tradeable
    ? levels.targets.map((t, i) => ({ label: t.label, price: roundPrice(t.price), rewardRisk: t.rewardRisk, netRewardRisk: legs[i].net, closeFraction: t.closeFraction, limitedByStructure: t.limitedByStructure })).filter(t => t.label !== "TP3" || tp3Included)
    : [];
  const tp3Reason = !tradeable ? "No trade" : tp3Included ? `TP3 is ${levels.targets[2].rewardRisk}R gross / ${legs[2].net}R net and is not capped by nearby structure below the minimum`
    : `TP3 omitted: it would be ${levels.targets[2].rewardRisk}R gross / ${legs[2].net}R net, below the ${cfg.tp3MinRewardRisk}R gross / ${cfg.gates.minNetRewardRisk}R net required to justify a third target${levels.targets[2].limitedByStructure ? " (capped by nearby structure)" : ""}`;

  // Confidence: a calibrated probability only from a validated model; otherwise a qualitative level that says so.
  const cal = calibratedConfidence(inp.calibration ?? null, opportunity.value ?? 0, { strategy, hash: opportunity.configHash, now, cfg: cfg.calibration });
  let confidence: Confidence;
  if (tradeable && cal.confidence) confidence = cal.confidence;
  else {
    const sc = opportunity.value ?? 0;
    let lvl: "low" | "moderate" | "high" = sc >= cfg.bands.strong ? "high" : sc >= cfg.bands.potential ? "moderate" : "low";
    if (htf.alignsWithTrade === false) lvl = lvl === "high" ? "moderate" : "low";
    confidence = {
      type: "qualitative", level: tradeable ? lvl : "none",
      calibration: { status: inp.calibration ? "rejected" : "no_model", reasons: cal.reasons },
      note: tradeable ? "Qualitative research-priority level only. No probability is claimed because no validated calibration model is available." : "No trade is signalled, so no confidence is assigned.",
    };
  }

  const ev = evidenceAndAttribution(validation, {
    strategy, execTf, regimeName: regime.regime, preferred: regime.profile.preferred, htf,
    fundamentalsScore: fundamentals.score, newsScore: news.score, fundamentalsDetail: fundamentals.status === "available" ? `supplied by ${fundamentals.source}` : fundamentals.status, newsDetail: news.status === "available" ? `supplied by ${news.source}` : news.status,
  });

  const sideWord = dir > 0 ? "bullish" : "bearish";
  const technical: string[] = [
    `Setup timeframe ${execTf}: EMA 20/50/200 alignment ${ef.alignment}, adaptive ATR bands ${bands.trend}, ADX ${regime.adx.toFixed(0)}.`,
    `Volume-weighted momentum ${vm.score} (relative volume ${vm.relativeVolume.toFixed(2)}x); volume ${vm.volumeConfirmsPrice ? "confirms" : "does not confirm"} price${vm.exhaustion ? "; exhaustion signs present" : ""}${vm.divergence !== "none" ? `; ${vm.divergence} divergence` : ""}.`,
    `Swing structure bias ${st.bias}; nearest ${dir > 0 ? "support" : "resistance"} ${(dir > 0 ? st.support : st.resistance) ?? "not identified"}.`,
    `Multi-timeframe consensus ${consensus.direction} (score ${consensus.weightedScore}; ${consensus.bullish} bullish, ${consensus.bearish} bearish, ${consensus.neutral} neutral of ${consensus.bullish + consensus.bearish + consensus.neutral} timeframes).`,
    htf.direction === "unavailable" ? "No higher-timeframe data was available." : `Higher timeframes (${htf.timeframes.map(t => t.timeframe).join(", ")}) lean ${htf.direction}${htf.alignsWithTrade === false ? ", against this trade" : htf.alignsWithTrade ? `, with this ${sideWord} trade` : ""}.`,
    `Regime ${regime.regime}: ${regime.reasons[0] ?? "no further detail"}.`,
    `Stop ${levels.stopSource === "structure" ? "is anchored beyond the nearest swing" : `is ${regime.profile.stopMult}x ATR from entry`} (${levels.stopPercent.toFixed(2)}% risk); breakeven after TP1, trailing after TP2.`,
    ...consensus.conflicts,
  ];

  const invalidation = tradeable ? [
    `Candle close beyond the stop at ${roundPrice(levels.stop)}`,
    "Adaptive bands flip against the position with volume confirmation",
    htf.direction !== "unavailable" ? `Higher timeframes (${htf.timeframes.map(t => t.timeframe).join(", ")}) turn ${dir > 0 ? "bearish" : "bullish"}` : "Higher-timeframe trend turns against the position",
    `Spread widens beyond ${cfg.gates.maxSpreadBps} bps, or the order book becomes stale or one-sided`,
    "A high-impact news event enters the blackout window, or the market regime becomes abnormal",
    "Market data becomes stale or providers disagree",
    `Signal expires at ${new Date(expiry).toISOString()}; an unfilled setup after that time is void`,
    "Stops are never widened to avoid a loss",
  ] : [];

  const bookStatus = !bookAvailable ? "unavailable" : liquidity!.status;
  return {
    ...engineHeader(h),
    signalId: "eti-ps-" + hash16(`${h.symbol}|${strategy}|${last[0]}|${direction}|${opportunity.configHash}`),
    direction,
    decision: { tradeable, reasons: failed.map(g => `${g.label}: ${g.detail}`) },
    entry: tradeable ? roundPrice(levels.entry) : null,
    entryZone: tradeable ? [roundPrice(levels.entryZone[0]), roundPrice(levels.entryZone[1])] : null,
    stopLoss: tradeable ? roundPrice(levels.stop) : null,
    takeProfits, tp3: { included: tradeable && tp3Included, reason: tp3Reason },
    riskReward: tradeable ? { grossToFinalTarget: levels.targets[fin].rewardRisk, netToFinalTarget: legs[fin].net, finalTarget: levels.targets[fin].label } : { grossToFinalTarget: null, netToFinalTarget: null, finalTarget: null },
    transactionCosts: costs,
    higherTimeframeDirection: htf,
    technicalJustification: technical,
    fundamentalJustification: { status: fundamentals.status, asOf: fundamentals.asOf, source: fundamentals.source, points: fundamentals.points },
    relevantNews: { status: news.status, asOf: news.asOf, source: news.source, blackoutActive: news.blackout, events: news.events, notes: news.notes },
    marketLiquidity: {
      status: bookStatus, spreadBps: liquidity?.spreadBps != null ? Number(liquidity.spreadBps.toFixed(2)) : null, imbalance: liquidity?.imbalance != null ? Number(liquidity.imbalance.toFixed(3)) : null,
      bidDepthQuote: liquidity && bookAvailable ? Math.round(liquidity.bidDepth) : null, askDepthQuote: liquidity && bookAvailable ? Math.round(liquidity.askDepth) : null,
      orderBookAgeMs: liquidity && Number.isFinite(liquidity.ageMs) ? Math.round(liquidity.ageMs) : null,
      largeOrders: liquidity?.largeOrders ?? [], issues: liquidity ? [...liquidity.issues, ...lq.notes] : ["Order book unavailable"],
      caveat: liquidity?.caveat ?? "Visible resting orders can be cancelled before they fill; this is not guaranteed executable liquidity.",
    },
    volatility: { classification: vol.classification, atrPercent: Number(vol.atrPercent.toFixed(3)), percentile: Number(vol.percentile.toFixed(1)), expansion: vol.expansion, contraction: vol.contraction, regime: regime.regime, stopPercent: Number(levels.stopPercent.toFixed(3)) },
    invalidation,
    expiresAt: tradeable ? new Date(expiry).toISOString() : null,
    validForBars: tradeable ? Math.max(0, Math.floor((expiry - now) / barMs)) : 0,
    dataTimestamps: { fetchedAt: new Date(h.fetchedAt).toISOString(), latestCandleOpen: isoOrNull(last[0]), orderBook: isoOrNull(inp.depth?.timestamp) },
    confidence,
    supportingEvidence: ev.evidence, strategyAttribution: ev.attribution,
    opportunityScore: opportunity,
    riskChecks: gates, riskCheckSummary: summarizeGates(gates),
    dataQuality: {
      provider: inp.provider ?? "unknown",
      timeframesLoaded: TIMEFRAMES.filter(tf => inp.candles[tf]),
      candleCounts: Object.fromEntries(TIMEFRAMES.filter(tf => inp.candles[tf]).map(tf => [tf, inp.candles[tf]!.length])) as Partial<Record<Timeframe, number>>,
      orderBook: bookAvailable ? "available" : "unavailable", providerCrossCheck: "not_performed",
      notes: ["Single validated provider per request; cross-provider reconciliation is not performed.", "The order-book snapshot is a REST snapshot timestamped at fetch time."],
    },
  };
}
