import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { Kline } from "../market.ts";
import { backtest24hExtremes, buildExtremeMarketContext, forecast24hExtremes, inferBybitCategory } from "../analysis/extremes.ts";
import { EXTREME_FORECAST_JS, withExtremeForecastLayer } from "./extreme-forecast.ts";

const DAY = 86_400_000, HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 17, 10, 30);
function history(days = 30): { hourly: Kline[]; daily: Kline[] } {
  const today = Math.floor(now / DAY) * DAY, start = today - days * DAY;
  const hourly: Kline[] = [], daily: Kline[] = [];
  for (let d = 0; d < days; d++) {
    const day = start + d * DAY, open = 100 + d * .5;
    let high = -Infinity, low = Infinity;
    for (let h = 0; h < 24; h++) {
      const ts = day + h * HOUR, close = open * 1.0002;
      const hi = h === 14 ? open * 1.02 : close * 1.001;
      const lo = h === 3 ? open * .985 : open * .999;
      hourly.push([ts, open, hi, lo, close, 1000]);
      high = Math.max(high, hi); low = Math.min(low, lo);
    }
    daily.push([day, open, high, low, open * 1.001, 24000]);
  }
  return { hourly, daily };
}
const ticker = { symbol: "BTCUSDT", lastPrice: 120, highPrice: 122, lowPrice: 117, priceChangePercent: 1.2, volume: 100, quoteVolume: 12000 };

test("forecast selects the correct Bybit market category for spot, linear and inverse symbols", () => {
  assert.equal(inferBybitCategory("BTCUSDT", "spot"), "spot");
  assert.equal(inferBybitCategory("ETHUSDC", "futures"), "linear");
  assert.equal(inferBybitCategory("BTCUSD", "futures"), "inverse");
});

test("24-hour forecast uses completed daily ranges and hourly high/low timing patterns", () => {
  const h = history();
  const result = forecast24hExtremes(h.hourly, h.daily, ticker, now);
  if (result.status !== "ready") throw new Error("Expected ready forecast, received " + result.status);
  assert.equal(result.history.hourlyDays, 30);
  assert.equal(result.history.dailyDays, 30);
  assert.equal(result.history.priceSampleSource, "1d");
  assert.ok(result.forecast.high.price > ticker.lastPrice);
  assert.ok(result.forecast.low.price < ticker.lastPrice);
  assert.ok(result.forecast.high.range.low <= result.forecast.high.price);
  assert.ok(result.forecast.high.range.high >= result.forecast.high.price);
  assert.ok(result.forecast.low.range.low <= result.forecast.low.price);
  assert.ok(result.forecast.low.range.high >= result.forecast.low.price);
  assert.equal(new Date(result.forecast.high.time.expectedAt).getUTCHours(), 14);
  assert.equal(new Date(result.forecast.high.time.expectedAt).getUTCMinutes(), 30);
  assert.equal(new Date(result.forecast.low.time.expectedAt).getUTCHours(), 3);
  assert.equal(result.observed.high24h, ticker.highPrice);
  assert.equal(result.forecast.confidence.meaning.includes("not a probability"), true);
});

test("hourly sessions provide a transparent fallback when daily history is unavailable", () => {
  const h = history();
  const result = forecast24hExtremes(h.hourly, [], ticker, now);
  assert.equal(result.status, "ready");
  assert.equal(result.history.priceSampleSource, "1h_fallback");
});

test("short or malformed history never produces fabricated forecast values", () => {
  const h = history(4);
  const short = forecast24hExtremes(h.hourly, h.daily, ticker, now);
  assert.equal(short.status, "insufficient_history");
  assert.equal(short.forecast, null);
  const invalid = forecast24hExtremes(h.hourly, h.daily, { ...ticker, lastPrice: NaN }, now);
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.forecast, null);
});

test("forecast overlay parses and is added only to the live dashboard chart", () => {
  const script = EXTREME_FORECAST_JS.replace(/^<script[^>]*>/, "").replace(/<[/]script>$/, "");
  assert.doesNotThrow(() => new vm.Script(script));
  const page = '<html><head></head><body><div id="stack"></div><canvas id="chart"></canvas></body></html>';
  const injected = withExtremeForecastLayer(page);
  assert.ok(injected.includes("eti-extreme-forecast-css"));
  assert.ok(injected.includes("eti-extreme-forecast-js"));
  assert.ok(injected.includes("24H HIGH"));
  assert.ok(injected.includes("24H LOW"));
  assert.ok(injected.includes("Rolling 24H backtest"));
  assert.ok(injected.includes("Historical hit rates are not probabilities"));
  assert.equal(withExtremeForecastLayer("<html><body>no chart</body></html>"), "<html><body>no chart</body></html>");
});

test("rolling 24-hour validation reports out-of-sample price and timing hit rates", () => {
  const h = history(30), result = backtest24hExtremes(h.hourly, h.daily, now);
  assert.equal(result.status, "ready");
  assert.ok(result.sampleCount >= 3);
  for (const key of ["highPriceHitRatePct", "lowPriceHitRatePct", "highTimeWindowHitRatePct", "lowTimeWindowHitRatePct"] as const) {
    assert.ok(result[key] >= 0 && result[key] <= 100, key);
  }
  assert.ok(result.meanAbsoluteHighPriceErrorPct >= 0);
  assert.ok(result.meanAbsoluteLowPriceErrorPct >= 0);
  assert.match(result.note, /not probabilities/);
});
test("market context reports structure, momentum, volatility, volume and transparent liquidity limitations", () => {
  const h = history(30), context = buildExtremeMarketContext(h.hourly, h.daily, ticker, now);
  assert.ok(typeof context.trend === "string");
  assert.ok(context.atr14Pct !== null && context.atr14Pct > 0);
  assert.ok(context.volumeVs20DayAverage !== null);
  assert.ok(context.momentum24hPct !== null);
  assert.match(context.liquidityProxy, /not order-book depth/);
  assert.ok(context.notIncludedInputs.includes("funding rate"));
});
