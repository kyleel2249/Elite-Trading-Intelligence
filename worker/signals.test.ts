import test from "node:test";
import assert from "node:assert/strict";
import { handleSignals } from "./signals.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("signal endpoint rejects malformed symbols and unsupported intervals", async () => {
  const a = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTC%20USDT"), {});
  const b = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=7m"), {});
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
});

test("signal endpoint calculates market-derived BUY, ATR risk levels and attribution", async () => {
  const now = Date.now();
  const candles = Array.from({ length: 500 }, (_, i) => {
    const close = 100 + i * 0.8 + (i === 499 ? 3 : 0);
    const open = close - 0.25;
    return [now - (499 - i) * 3600000, String(open), String(close + 1.2), String(open - 0.5), String(close), String(i === 499 ? 5000 : 100 + (i % 7) * 25)];
  });
  globalThis.fetch = (async () => new Response(JSON.stringify(candles), { status: 200 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h"), {});
  assert.equal(res.status, 200);
  const signal = await res.json() as any;
  assert.equal(signal.action, "BUY");
  assert.ok(signal.entry > 0);
  assert.ok(signal.stopLoss < signal.entry);
  assert.equal(signal.targets.length, 3);
  assert.ok(signal.targets[0].price > signal.entry);
  assert.ok(signal.targets[2].price > signal.targets[1].price);
  assert.equal(signal.confidenceType, "heuristic_score_not_probability");
  assert.ok(signal.strategyAttribution.some((x: any) => x.trader.includes("Dennis")));
  assert.ok(signal.historicalValidation.sampleCount >= 0);
  if (signal.historicalValidation.sampleCount < 20) assert.equal(signal.historicalValidation.winRate, null);
});

test("signal endpoint fails closed when upstream market data is unavailable", async () => {
  globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h"), {});
  assert.equal(res.status, 503);
});

function series(fn: (i: number) => number, n = 500) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i), open = fn(i) - (i % 2 ? 0.1 : -0.1);
    return [now - (n - 1 - i) * 3600000, String(open), String(Math.max(open, close) + 0.5), String(Math.min(open, close) - 0.5), String(close), String(100 + (i % 5) * 10)];
  });
}
async function signalFor(candles: unknown[]) {
  globalThis.fetch = (async () => new Response(JSON.stringify(candles), { status: 200 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h"), {});
  assert.equal(res.status, 200);
  return await res.json() as any;
}

test("downtrend is labelled SELL with stop above entry and three descending targets", async () => {
  const s = await signalFor(series(i => 500 - i * 0.8));
  assert.equal(s.label, "SELL");
  assert.equal(s.action, "SELL");
  assert.ok(s.stopLoss > s.entry);
  assert.ok(s.targets[0].price < s.entry && s.targets[2].price < s.targets[1].price);
});

test("a choppy chart still gets BUY or SELL, honestly marked low conviction and not tradeable", async () => {
  const s = await signalFor(series(i => 100 + Math.sin(i / 3) * 2));
  assert.ok(s.label === "BUY" || s.label === "SELL");
  assert.equal(s.action, s.label);
  assert.ok(s.entry > 0 && s.stopLoss > 0 && s.targets.length === 3);
  if (s.gatedAction === "WAIT") { assert.notEqual(s.conviction, "high"); assert.equal(s.tradeable, false); }
  assert.match(s.historicalValidation.note, /conviction/i);
  if (s.historicalValidation.sampleCount < 20) assert.equal(s.historicalValidation.winRate, null);
});

// ---------------------------------------------------------------------------------------------
// Chart payload: the per-candle series that the dashboard charts draw. These tests pin the series
// to the engine so a chart can never disagree with the signal it is illustrating.
// ---------------------------------------------------------------------------------------------

async function responseFor(candles: unknown[], query = "") {
  globalThis.fetch = (async () => new Response(JSON.stringify(candles), { status: 200 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h" + query), {});
  return { status: res.status, body: await res.json() as any };
}
const wave = (i: number) => 100 + i * 0.15 + Math.sin(i / 5) * 6 + Math.cos(i / 11) * 3;
const last = <T>(a: T[]) => a[a.length - 1];

test("chart payload is aligned, complete and ends on the live signal", async () => {
  const { status, body: s } = await responseFor(series(wave, 600));
  assert.equal(status, 200);
  const c = s.chart;
  assert.ok(c, "chart missing");
  assert.equal(c.window, 120);
  for (const key of ["times", "ema20", "ema50", "ema200", "bbUpper", "bbMiddle", "bbLower", "rsi", "macd", "macdSignal", "macdHistogram", "adx", "atr", "volumeRatio", "breakoutHigh", "breakoutLow", "score", "direction", "conviction"]) {
    assert.equal(c[key].length, c.times.length, key + " length");
  }
  for (let i = 1; i < c.times.length; i++) assert.ok(c.times[i] > c.times[i - 1]);
  const ind = s.indicators, near = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), a + " vs " + b);
  near(last(c.ema20), ind.ema20); near(last(c.ema50), ind.ema50); near(last(c.ema200), ind.ema200);
  near(last(c.rsi), ind.rsi14); near(last(c.macd), ind.macd); near(last(c.macdSignal), ind.macdSignal);
  near(last(c.macdHistogram), ind.macdHistogram); near(last(c.atr), ind.atr14); near(last(c.adx), ind.adx14);
  near(last(c.bbUpper), ind.bollingerUpper); near(last(c.bbLower), ind.bollingerLower); near(last(c.bbMiddle), ind.bollingerMiddle);
  near(last(c.volumeRatio), ind.volumeRatio); near(last(c.breakoutHigh), ind.breakoutHigh20); near(last(c.breakoutLow), ind.breakoutLow20);
  assert.equal(last(c.score), s.score);
  assert.equal(last(c.direction), s.label === "BUY" ? 1 : -1);
  assert.equal(last(c.conviction), s.conviction);
  assert.equal(c.levels.entry, s.entry);
  assert.equal(c.levels.stopLoss, s.stopLoss);
  assert.deepEqual(c.levels.targets, s.targets.map((t: any) => t.price));
  assert.equal(c.levels.asOf, last(c.times));
});

test("chart series equals the engine recomputed on shorter histories (no look-ahead, no drift)", async () => {
  const n = 600, k = 40;
  const full = (await responseFor(series(wave, n))).body.chart;
  const prefix = (await responseFor(series(wave, n - k))).body;
  const at = full.times.length - 1 - k;
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), a + " vs " + b);
  near(full.ema20[at], prefix.indicators.ema20); near(full.ema200[at], prefix.indicators.ema200);
  near(full.rsi[at], prefix.indicators.rsi14); near(full.macdHistogram[at], prefix.indicators.macdHistogram);
  near(full.atr[at], prefix.indicators.atr14); near(full.adx[at], prefix.indicators.adx14);
  near(full.bbUpper[at], prefix.indicators.bollingerUpper); near(full.volumeRatio[at], prefix.indicators.volumeRatio);
  near(full.breakoutHigh[at], prefix.indicators.breakoutHigh20); near(full.breakoutLow[at], prefix.indicators.breakoutLow20);
  assert.equal(full.score[at], prefix.score);
  assert.equal(full.direction[at], prefix.label === "BUY" ? 1 : -1);
});

test("score components explain the score and carry per-factor limits", async () => {
  for (const fn of [wave, (i: number) => 500 - i * 0.8, (i: number) => 100 + i * 0.8]) {
    const s = (await responseFor(series(fn, 500))).body;
    const sum = s.components.reduce((a: number, x: any) => a + x.points, 0);
    assert.equal(Math.max(-100, Math.min(100, sum)), s.score);
    for (const x of s.components) assert.ok(Math.abs(x.points) <= x.max && x.id && x.label);
    assert.deepEqual(s.components.map((x: any) => x.id), ["trend", "macd", "rsi", "breakout", "breakdown", "volume", "adx", "bearStack"]);
  }
});

test("markers and replay trades are consistent with the series and the validation counts", async () => {
  const { body: s } = await responseFor(series(wave, 1000), "&window=400");
  const c = s.chart;
  assert.ok(c.window <= 400 && c.window > 120);
  const t0 = c.times[0], t1 = last(c.times);
  for (const m of c.markers) {
    assert.ok(m.time >= t0 && m.time <= t1);
    const i = c.times.indexOf(m.time);
    assert.ok(i > 0 || m.kind === "flip");
    assert.equal(m.score, c.score[i]);
    assert.equal(m.label, c.direction[i] === 1 ? "BUY" : "SELL");
    if (m.kind === "high") assert.equal(m.conviction, "high");
  }
  for (let i = 1; i < c.direction.length; i++) {
    if (c.direction[i] !== c.direction[i - 1]) assert.ok(c.markers.some((m: any) => m.time === c.times[i]), "missing flip marker at " + i);
  }
  const total = s.historicalValidation;
  const wins = c.replay.filter((t: any) => t.outcome === "win").length, losses = c.replay.filter((t: any) => t.outcome === "loss").length;
  assert.ok(wins <= total.wins && losses <= total.losses);
  for (const t of c.replay) {
    assert.ok(t.time >= t0 && t.time <= t1);
    if (t.label === "BUY") assert.ok(t.stop < t.entry && t.tp1 > t.entry); else assert.ok(t.stop > t.entry && t.tp1 < t.entry);
    assert.equal(t.outcome === "unresolved", t.exitTime === null);
  }
});

test("window parameter is validated and honoured", async () => {
  const c = series(wave, 500);
  assert.equal((await responseFor(c, "&window=5")).status, 400);
  assert.equal((await responseFor(c, "&window=9999")).status, 400);
  assert.equal((await responseFor(c, "&window=abc")).status, 400);
  const { status, body } = await responseFor(c, "&window=60");
  assert.equal(status, 200);
  assert.equal(body.chart.window, 60);
  assert.equal(body.chart.times.length, 60);
});

test("with the minimum 210 candles the chart is limited to bars that have a full indicator set", async () => {
  const { status, body } = await responseFor(series(wave, 210));
  assert.equal(status, 200);
  assert.equal(body.chart.window, 1);
  assert.equal(body.chart.score[0], body.score);
  assert.ok((await responseFor(series(wave, 209))).status === 422);
});
