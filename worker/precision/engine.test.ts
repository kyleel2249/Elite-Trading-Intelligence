import test from "node:test";
import assert from "node:assert/strict";
import { fitCalibration } from "./calibration.ts";
import { DEFAULT_CONFIG, ENGINE_NAME, resolveConfig, scoreConfigHash } from "./config.ts";
import { parseInstrument, runPrecisionEngine, SUPPORTED_MARKETS } from "./engine.ts";
import { HOUR_MS, MINUTE_MS } from "./util.ts";
import { FIXTURES, NOW, candlesFor, depthAround, fullContext, informativeSamples, inputFor, lastClose } from "./testkit.ts";

const run = (f: keyof typeof FIXTURES, over = {}) => runPrecisionEngine(inputFor(f, over));
const fails = (s: ReturnType<typeof run>) => s.riskChecks.filter(g => g.status === "fail").map(g => g.id);

test("a long signal carries every required field with a coherent trade plan", () => {
  const s = run("buy");
  assert.equal(s.engine.name, "ETI PRECISION SIGNAL ENGINE");
  assert.equal(ENGINE_NAME, "ETI PRECISION SIGNAL ENGINE");
  assert.equal(s.direction, "BUY");
  assert.equal(s.decision.tradeable, true);
  assert.deepEqual(s.decision.reasons, []);
  // asset / pair / market
  assert.equal(s.asset.symbol, "BTCUSDT"); assert.equal(s.asset.base, "BTC"); assert.equal(s.asset.quote, "USDT");
  assert.equal(s.tradingPair, "BTC/USDT"); assert.equal(s.ticker, "BTCUSDT"); assert.equal(s.market, "crypto_spot");
  // levels
  assert.ok(s.entry !== null && s.stopLoss !== null && s.entryZone !== null);
  assert.ok(s.stopLoss! < s.entry!, "a long's stop is below entry");
  assert.ok(s.entryZone![0] <= s.entryZone![1]);
  assert.ok(s.takeProfits.length >= 2);
  let prev = s.entry!;
  for (const tp of s.takeProfits) { assert.ok(tp.price > prev, `${tp.label} is beyond the previous level`); prev = tp.price; assert.ok(tp.netRewardRisk < tp.rewardRisk, "net is below gross"); assert.ok(tp.closeFraction > 0); }
  assert.deepEqual(s.takeProfits.map(t => t.label), s.tp3.included ? ["TP1", "TP2", "TP3"] : ["TP1", "TP2"]);
  assert.ok(s.tp3.reason.length > 0);
  // risk-to-reward and costs
  assert.ok(s.riskReward.grossToFinalTarget! > s.riskReward.netToFinalTarget!);
  assert.equal(s.riskReward.finalTarget, s.tp3.included ? "TP3" : "TP2");
  assert.ok(s.transactionCosts!.roundTripBps > 0);
  // timeframes
  assert.equal(s.setupTimeframe, "15m"); assert.equal(s.strategy, "intraday");
  assert.equal(s.higherTimeframeDirection.direction, "bullish");
  assert.equal(s.higherTimeframeDirection.alignsWithTrade, true);
  assert.ok(s.higherTimeframeDirection.timeframes.length > 0);
  // justification / context / market state
  assert.ok(s.technicalJustification.length >= 5 && s.technicalJustification.every(x => x.length > 0));
  assert.equal(s.fundamentalJustification.status, "unavailable");
  assert.equal(s.relevantNews.status, "unavailable");
  assert.ok(["ok", "degraded"].includes(s.marketLiquidity.status));
  assert.ok(s.marketLiquidity.spreadBps !== null && s.marketLiquidity.caveat.length > 0);
  assert.ok(s.volatility.atrPercent > 0 && s.volatility.stopPercent! > 0);
  // lifecycle and provenance
  assert.ok(s.invalidation.length >= 5);
  assert.ok(s.invalidation.some(x => x.includes(String(s.stopLoss))), "invalidation names the stop price");
  assert.equal(s.expiresAt, new Date(NOW + 8 * 15 * MINUTE_MS).toISOString());
  assert.equal(s.validForBars, 8);
  assert.equal(s.dataTimestamp, new Date(NOW).toISOString());
  assert.ok(s.dataTimestamps.latestCandleOpen && s.dataTimestamps.orderBook);
  assert.ok(s.supportingEvidence.length >= 6);
  assert.ok(s.strategyAttribution.length >= 6 && s.strategyAttribution.every(a => a.method && a.family));
  assert.ok(s.signalId.startsWith("eti-ps-"));
  assert.ok(s.disclaimers.some(d => /not financial advice/.test(d)));
  // score and checks
  assert.ok(s.opportunityScore.value! >= 70 && s.opportunityScore.components.length === 10);
  assert.equal(s.riskCheckSummary.failed, 0);
  assert.equal(s.liveExecutionAllowed, false);
  assert.equal(s.execution.requiresRiskPreflight, true);
});

test("a short signal mirrors the long: stop above, targets below, and higher timeframes bearish", () => {
  const s = run("sell");
  assert.equal(s.direction, "SELL");
  assert.ok(s.stopLoss! > s.entry!);
  let prev = s.entry!;
  for (const tp of s.takeProfits) { assert.ok(tp.price < prev, tp.label); prev = tp.price; }
  assert.equal(s.higherTimeframeDirection.direction, "bearish");
  assert.equal(s.higherTimeframeDirection.alignsWithTrade, true);
  assert.ok(s.entryZone![0] <= s.entry! && s.entry! <= s.entryZone![1]);
});

test("NO TRADE is a complete answer: it names its reasons and publishes no levels", () => {
  const thin = run("thinReward");
  assert.equal(thin.direction, "NO TRADE");
  assert.deepEqual(fails(thin), ["net_reward_risk"]);
  assert.match(thin.decision.reasons[0], /after costs/);
  const wide = run("wideStop");
  assert.equal(wide.direction, "NO TRADE");
  assert.ok(fails(wide).includes("stop_distance"));
  for (const s of [thin, wide]) {
    assert.equal(s.entry, null); assert.equal(s.stopLoss, null); assert.equal(s.entryZone, null);
    assert.deepEqual(s.takeProfits, []); assert.equal(s.expiresAt, null); assert.deepEqual(s.invalidation, []);
    assert.equal(s.riskReward.netToFinalTarget, null);
    assert.equal(s.confidence.type, "qualitative"); assert.equal((s.confidence as any).level, "none");
    assert.ok(s.technicalJustification.length > 0, "the analysis is still explained");
    assert.match(s.opportunityScore.interpretation, /Blocked by a failed risk check/);
  }
});

test("INVARIANT: a failed risk check always means NO TRADE, whatever the score", () => {
  const cases = [run("buy"), run("sell"), run("thinReward"), run("wideStop"), run("buy", { depth: null }), run("buy", { now: NOW + 4 * HOUR_MS })];
  for (const s of cases) {
    const failed = fails(s).length > 0;
    assert.equal(s.direction === "NO TRADE", failed, `${s.direction} with failed [${fails(s)}]`);
    assert.equal(s.decision.tradeable, !failed);
    assert.equal(s.entry === null, failed);
    assert.equal(s.decision.reasons.length, failed ? fails(s).length : 0);
  }
});

test("a strong score cannot override a failed gate: the score is identical, only the gate changes the decision", () => {
  const ctx = fullContext(1);
  const blackout = { ...ctx.news, events: [{ title: "FOMC decision", time: new Date(NOW + 20 * MINUTE_MS).toISOString(), impact: "high", sentiment: null, scheduled: true, source: null, url: null }] };
  // Weight the news component at 0 so a blackout cannot lower the score: any change in decision is due to the gate alone.
  const cfg = resolveConfig({ weights: { newsRisk: 0 } }).config;
  const go = (news: unknown) => runPrecisionEngine({ ...inputFor("buy", { fundamentals: ctx.fundamentals, news: news as any, expectancy: ctx.expectancy }), config: cfg });
  const clear = go(ctx.news), blocked = go(blackout);
  assert.equal(clear.direction, "BUY");
  assert.equal(clear.opportunityScore.capped, false);
  assert.ok(clear.opportunityScore.value! >= 75, `score ${clear.opportunityScore.value}`);
  assert.equal(blocked.opportunityScore.value, clear.opportunityScore.value, "the score is unchanged");
  assert.equal(blocked.direction, "NO TRADE", "but the failed gate still blocks the trade");
  assert.deepEqual(fails(blocked), ["news_blackout"]);
  assert.equal(blocked.relevantNews.blackoutActive, true);
  assert.match(blocked.decision.reasons.join(" "), /FOMC decision/);
  assert.match(blocked.opportunityScore.interpretation, /does not permit a trade/);

  // Lowering the score floor to its minimum does not unblock it either: gates are independent of the score.
  const lax = resolveConfig({ weights: { newsRisk: 0 }, gates: { minScoreToSignal: 50 } }).config;
  assert.equal(runPrecisionEngine({ ...inputFor("buy", { fundamentals: ctx.fundamentals, news: blackout as any, expectancy: ctx.expectancy }), config: lax }).direction, "NO TRADE");

  // Negative measured expectancy blocks otherwise excellent inputs.
  const negExp = run("buy", { fundamentals: ctx.fundamentals, news: ctx.news, expectancy: { expectancyR: -0.2, samples: 200 } });
  assert.equal(negExp.direction, "NO TRADE");
  assert.ok(fails(negExp).includes("expectancy"));
  // ...while too few samples is reported as not evaluated, never as a pass or a fail.
  const fewSamples = run("buy", { fundamentals: ctx.fundamentals, news: ctx.news, expectancy: { expectancyR: -0.2, samples: 10 } });
  assert.equal(fewSamples.riskChecks.find(g => g.id === "expectancy")!.status, "not_evaluated");
  assert.ok(fewSamples.opportunityScore.unavailableComponents.includes("strategyExpectancy"));
});

test("missing context is reported, scored as unavailable, and caps the score; full context lifts the cap", () => {
  const bare = run("buy");
  assert.deepEqual([...bare.opportunityScore.unavailableComponents].sort(), ["fundamentalAlignment", "newsRisk", "strategyExpectancy"]);
  assert.ok(bare.opportunityScore.value! <= DEFAULT_CONFIG.incompleteDataCap);
  assert.ok(bare.opportunityScore.coverage < 1);
  const ctx = fullContext(1);
  const full = run("buy", { fundamentals: ctx.fundamentals, news: ctx.news, expectancy: ctx.expectancy });
  assert.deepEqual(full.opportunityScore.unavailableComponents, []);
  assert.equal(full.opportunityScore.coverage, 1);
  assert.ok(full.opportunityScore.value! > bare.opportunityScore.value!);
  assert.equal(full.fundamentalJustification.status, "available");
  assert.equal(full.relevantNews.status, "available");
  assert.ok(full.fundamentalJustification.points.some(p => /supports this trade/.test(p)));
});

test("fundamentals that oppose the trade lower the score; they are not treated as neutral", () => {
  const ok = fullContext(1), against = fullContext(-1);
  const a = run("buy", { fundamentals: ok.fundamentals, news: ok.news, expectancy: ok.expectancy });
  const b = run("buy", { fundamentals: against.fundamentals, news: ok.news, expectancy: ok.expectancy });
  assert.ok(b.opportunityScore.value! < a.opportunityScore.value!);
  assert.ok(b.fundamentalJustification.points.some(p => /opposes this trade/.test(p)));
});

test("no order book means no trade, and liquidity is reported as unavailable rather than assumed", () => {
  const s = run("buy", { depth: null });
  assert.equal(s.direction, "NO TRADE");
  assert.ok(fails(s).includes("order_book_available"));
  assert.equal(s.marketLiquidity.status, "unavailable");
  assert.equal(s.marketLiquidity.spreadBps, null);
  assert.equal(s.dataQuality.orderBook, "unavailable");
  assert.ok(s.opportunityScore.unavailableComponents.includes("liquidity"));
  const lenient = runPrecisionEngine({ ...inputFor("buy", { depth: null }), config: resolveConfig({ gates: { requireOrderBook: false } }).config });
  assert.equal(lenient.riskChecks.find(g => g.id === "order_book_available")!.status, "not_evaluated", "an unverified liquidity check is never reported as passed");
});

test("a wide spread, a stale or crossed book, and a liquidity wall each block the trade", () => {
  const px = lastClose(inputFor("buy").candles!);
  assert.ok(fails(run("buy", { depth: depthAround(px, NOW, { halfSpreadBps: 25 }) })).includes("spread_limit"));
  assert.ok(fails(run("buy", { depth: depthAround(px, NOW - 60_000) })).includes("order_book_healthy"), "a 60s-old book is stale");
  const crossed = depthAround(px); crossed.bids[0] = [px * 1.01, 5]; // best bid above best ask
  assert.ok(fails(run("buy", { depth: crossed })).includes("order_book_healthy"));
  const wall = depthAround(px); wall.asks[1] = [wall.asks[1][0], wall.asks[1][1] * 400];
  const w = run("buy", { depth: wall });
  assert.ok(fails(w).includes("liquidity_trap"), fails(w).join(","));
});

test("stale data, too little history and an unsupported instrument are refused with specific reasons", () => {
  const stale = run("buy", { now: NOW + 2 * HOUR_MS });
  assert.equal(stale.direction, "NO TRADE");
  assert.ok(fails(stale).includes("data_fresh"));
  const short = runPrecisionEngine({ ...inputFor("buy"), candles: candlesFor(1, 2, 1, 100, NOW, 40) });
  assert.equal(short.direction, "NO TRADE");
  assert.ok(short.decision.reasons.join(" ").includes("fewer than 100 valid candles"));
  assert.equal(short.opportunityScore.value, null);
  assert.equal(short.confidence.type, "qualitative");
  const odd = run("buy", { symbol: "AAPL" });
  assert.equal(odd.market, "unsupported");
  assert.equal(odd.direction, "NO TRADE");
  assert.ok(fails(odd).includes("instrument_supported"));
  assert.equal(odd.asset.base, null);
});

test("account-level risk is reported as not evaluated unless a verdict is supplied, and a failing verdict blocks", () => {
  const none = run("buy");
  assert.equal(none.riskChecks.find(g => g.id === "account_risk")!.status, "not_evaluated");
  assert.ok(none.riskCheckSummary.notEvaluated >= 1);
  const bad = run("buy", { risk: { withinLimits: false, reasons: ["Daily loss limit reached"] } });
  assert.equal(bad.direction, "NO TRADE");
  assert.match(bad.decision.reasons.join(" "), /Daily loss limit reached/);
  const good = run("buy", { risk: { withinLimits: true, reasons: [] } });
  assert.equal(good.riskChecks.find(g => g.id === "account_risk")!.status, "pass");
});

test("confidence is qualitative without a model, and says why", () => {
  const s = run("buy");
  assert.equal(s.confidence.type, "qualitative");
  if (s.confidence.type !== "qualitative") return;
  assert.ok(["low", "moderate", "high"].includes(s.confidence.level));
  assert.equal(s.confidence.calibration.status, "no_model");
  assert.match(s.confidence.note, /No probability is claimed/);
  assert.ok(!("probability" in s.confidence));
});

test("confidence becomes a calibrated probability only from a validated model matching this scoring configuration", () => {
  const hash = scoreConfigHash(DEFAULT_CONFIG);
  const { model } = fitCalibration(informativeSamples(3000), { strategy: "intraday", scoreConfigHash: hash, now: NOW, minBlockSamples: 30 });
  const good = run("buy", { calibration: model });
  assert.equal(good.confidence.type, "calibrated_probability");
  if (good.confidence.type === "calibrated_probability") {
    assert.ok(good.confidence.probability > 0 && good.confidence.probability < 1);
    assert.ok(good.confidence.basis.testSamples >= 800);
  }
  // Same model, but the scoring weights were changed since it was fitted: it must not be used.
  const reweighted = runPrecisionEngine({ ...inputFor("buy", { calibration: model }), config: resolveConfig({ weights: { liquidity: 14 } }).config });
  assert.equal(reweighted.confidence.type, "qualitative");
  if (reweighted.confidence.type === "qualitative") { assert.equal(reweighted.confidence.calibration.status, "rejected"); assert.match(reweighted.confidence.calibration.reasons.join(" "), /configuration changed/); }
  // A model for another strategy is ignored.
  const swing = run("buy", { calibration: { ...model!, strategy: "swing" } });
  assert.equal(swing.confidence.type, "qualitative");
  // NO TRADE never carries a probability, even with a valid model.
  const nt = run("thinReward", { calibration: model });
  assert.equal(nt.confidence.type, "qualitative");
});

test("a TP3 that cannot be justified is omitted with the reason, and the final target moves to TP2", () => {
  const strict = runPrecisionEngine({ ...inputFor("buy"), config: resolveConfig({ tp3MinRewardRisk: 9 }).config });
  assert.equal(strict.tp3.included, false);
  assert.deepEqual(strict.takeProfits.map(t => t.label), ["TP1", "TP2"]);
  assert.match(strict.tp3.reason, /TP3 omitted/);
  assert.equal(strict.riskReward.finalTarget, "TP2");
});

test("the signal expires before a scheduled high-impact event instead of straddling it", () => {
  const ctx = fullContext(1);
  const withEvent = (min: number) => ({ ...ctx.news, events: [{ title: "CPI", time: new Date(NOW + min * MINUTE_MS).toISOString(), impact: "high", sentiment: null, scheduled: true, source: null, url: null }] });
  const go = (min: number) => run("buy", { fundamentals: ctx.fundamentals, news: withEvent(min), expectancy: ctx.expectancy });
  // An event beyond the normal 8-bar (120 min) life changes nothing.
  assert.equal(go(240).expiresAt, new Date(NOW + 120 * MINUTE_MS).toISOString());
  // An event 2h out starts its blackout in 1h, so the signal is cut short to end exactly then.
  const s = go(120);
  assert.equal(s.direction, "BUY");
  assert.equal(Date.parse(s.expiresAt!), NOW + 60 * MINUTE_MS);
  assert.equal(s.validForBars, 4);
  assert.ok(s.relevantNews.events.some(e => e.title === "CPI"));
});

test("a signal that would expire within one bar is refused: it is not actionable", () => {
  const ctx = fullContext(1);
  const news = { ...ctx.news, events: [{ title: "CPI", time: new Date(NOW + 70 * MINUTE_MS).toISOString(), impact: "high", sentiment: null, scheduled: true, source: null, url: null }] };
  const s = run("buy", { fundamentals: ctx.fundamentals, news, expectancy: ctx.expectancy });
  assert.equal(s.direction, "NO TRADE");
  assert.deepEqual(fails(s), ["signal_validity"]);
  assert.match(s.decision.reasons[0], /expire in 10 min/);
  assert.equal(s.validForBars, 0);
  assert.equal(run("buy").riskChecks.find(g => g.id === "signal_validity")!.status, "pass");
});

test("the engine is deterministic and has no hidden state", () => {
  const a = JSON.stringify(run("buy")), b = JSON.stringify(run("buy"));
  assert.equal(a, b);
  assert.notEqual(run("buy").signalId, run("sell").signalId);
  const ctx = fullContext(1);
  const withCtx = run("buy", { fundamentals: ctx.fundamentals, news: ctx.news, expectancy: ctx.expectancy });
  assert.equal(withCtx.signalId, run("buy").signalId, "the id identifies the candle, direction and scoring configuration");
});

test("every strategy produces a valid result on its own execution timeframe", () => {
  const candles = candlesFor(1, 2, 1, 100);
  const tf = { scalp: "5m", intraday: "15m", swing: "4h", position: "1d" } as const;
  for (const strategy of ["scalp", "intraday", "swing", "position"] as const) {
    const s = runPrecisionEngine({ symbol: "ETHUSDT", strategy, candles, depth: depthAround(lastClose(candles, tf[strategy])), now: NOW });
    assert.equal(s.setupTimeframe, tf[strategy]);
    assert.ok(["BUY", "SELL", "NO TRADE"].includes(s.direction));
    assert.equal(s.opportunityScore.components.length, 10);
    assert.equal(s.liveExecutionAllowed, false);
  }
});

test("instrument parsing recognises quote currencies and rejects non-crypto tickers", () => {
  assert.deepEqual(parseInstrument("btcusdt"), { symbol: "BTCUSDT", base: "BTC", quote: "USDT", pair: "BTC/USDT", market: "crypto_spot" });
  assert.equal(parseInstrument("ETHBTC")!.quote, "BTC");
  assert.equal(parseInstrument("SOLFDUSD")!.quote, "FDUSD");
  assert.equal(parseInstrument("AAPL"), null);
  assert.equal(parseInstrument("USDT"), null);
  assert.equal(SUPPORTED_MARKETS[0].id, "crypto_spot");
});
