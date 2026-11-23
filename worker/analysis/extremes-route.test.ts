import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { handleExtremeForecast } from "./extremes.ts";

const DAY = 86_400_000, HOUR = 3_600_000;
function fixture(days = 45) {
  const now = Date.now(), today = Math.floor(now / DAY) * DAY, start = today - days * DAY;
  const hourly: Kline[] = [], daily: Kline[] = [];
  for (let d = 0; d < days; d++) {
    const day = start + d * DAY, open = 90 + d * .35;
    let high = -Infinity, low = Infinity;
    for (let h = 0; h < 24; h++) {
      const ts = day + h * HOUR, close = open * (1 + (h % 4) * .0001);
      const hi = h === 14 ? open * 1.02 : Math.max(open, close) * 1.001;
      const lo = h === 3 ? open * .985 : Math.min(open, close) * .999;
      hourly.push([ts, open, hi, lo, close, 1000]);
      high = Math.max(high, hi); low = Math.min(low, lo);
    }
    daily.push([day, open, high, low, open * 1.001, 24000]);
  }
  const binanceRows = (rows: Kline[]) => rows.map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), k[0] + (rows === hourly ? HOUR : DAY) - 1, String(k[5] * k[4]), 100, String(k[5] * .55)]);
  return { hourly, daily, binanceHourly: binanceRows(hourly), binanceDaily: binanceRows(daily) };
}

test("24-hour forecast fails over from blocked Bybit to one complete Binance spot data bundle", async () => {
  const h = fixture(), requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url.origin + url.pathname + url.search);
    if (url.hostname === "api.bybit.com" || url.hostname === "api.bytick.com") return new Response("blocked by upstream", { status: 403 });
    if (url.hostname === "data-api.binance.vision") {
      if (url.pathname === "/api/v3/klines") {
        const rows = url.searchParams.get("interval") === "1d" ? h.binanceDaily : h.binanceHourly;
        return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/v3/ticker/24hr") return new Response(JSON.stringify({
        lastPrice: "110", priceChangePercent: "1.2", highPrice: "112", lowPrice: "107", volume: "1234", quoteVolume: "135740"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected mock route", { status: 404 });
  };
  const response = await handleExtremeForecast(new Request("https://eti.test/api/analysis/extremes?symbol=BTCUSDT"), {} as any, fakeFetch);
  const body: any = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.provider, "binance");
  assert.equal(body.source, "Binance Spot public market data");
  assert.equal(body.failover, true);
  assert.equal(body.history.priceSampleSource, "1d");
  assert.ok(body.forecast.high.price > 110);
  assert.ok(body.forecast.low.price < 110);
  assert.ok(body.providerFailures.some((x: any) => x.provider === "bybit" && x.endpoint === "hourly"));
  const successfulHosts = requests.filter(x => x.includes("data-api.binance.vision"));
  assert.equal(successfulHosts.length, 3, "hourly, daily and ticker all come from the same fallback venue");
  assert.ok(requests.some(x => x.startsWith("https://api.bybit.com/")));
  assert.ok(requests.some(x => x.startsWith("https://api.bytick.com/")));
});

test("forecast never combines ticker and candles from different exchanges", async () => {
  const h = fixture(), requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url.origin + url.pathname + url.search);
    if (url.hostname === "api.bybit.com" || url.hostname === "api.bytick.com") return new Response("blocked", { status: 403 });
    if (url.hostname === "data-api.binance.vision" && url.pathname === "/api/v3/ticker/24hr") return new Response("ticker unavailable", { status: 503 });
    if (url.hostname === "data-api.binance.vision" && url.pathname === "/api/v3/klines") return new Response(JSON.stringify(url.searchParams.get("interval") === "1d" ? h.binanceDaily : h.binanceHourly), { status: 200 });
    if (url.hostname === "www.okx.com" && url.pathname === "/api/v5/market/candles") {
      const rows = url.searchParams.get("bar") === "1Dutc" ? h.daily : h.hourly;
      return new Response(JSON.stringify({ code: "0", data: rows.map(k => [String(k[0]), String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), "0", "0", "1"]) }), { status: 200 });
    }
    if (url.hostname === "www.okx.com" && url.pathname === "/api/v5/market/ticker") return new Response(JSON.stringify({ code: "0", data: [{ open24h: "109", last: "110", high24h: "112", low24h: "107", vol24h: "1234", volCcy24h: "135740" }] }), { status: 200 });
    return new Response("unexpected mock route", { status: 404 });
  };
  const response = await handleExtremeForecast(new Request("https://eti.test/api/analysis/extremes?symbol=BTCUSDT"), {} as any, fakeFetch);
  const body: any = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.provider, "okx");
  assert.equal(body.source, "OKX V5 public market data");
  assert.equal(body.failover, true);
  assert.ok(requests.filter(x => x.startsWith("https://www.okx.com/")).length === 3);
  assert.equal(body.observed.lastPrice, 110);
});
