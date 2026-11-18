import test from "node:test";
import assert from "node:assert/strict";
import { TRADING_TERMINAL_CSS, TRADING_TERMINAL_HTML, TRADING_TERMINAL_JS } from "./trading-terminal.ts";
import worker from "../index.ts";

test("terminal is served as a self-contained responsive workspace", () => {
  assert.match(TRADING_TERMINAL_HTML, /Professional Trading Terminal/);
  assert.match(TRADING_TERMINAL_HTML, /\/bitget-client\.js/);
  assert.match(TRADING_TERMINAL_CSS, /@media\(max-width:650px\)/);
  assert.match(TRADING_TERMINAL_JS, /ETIBitget\.marketData/);
});

test("terminal keeps order placement inside the existing guarded execution flow", () => {
  assert.match(TRADING_TERMINAL_HTML, /Planning only/);
  assert.match(TRADING_TERMINAL_HTML, /risk controls/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /fetch\(["']\/api\/orders/);
});

test("terminal exposes Bybit venue-specific market data requests", () => {
  assert.match(TRADING_TERMINAL_JS, /venue:"bybit"/);
  assert.match(TRADING_TERMINAL_JS, /\/api\/market\/klines/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /\/api\/market\/depth/);
});

test("Cloudflare Worker serves the terminal and its assets without a backend", async () => {
  const page = await worker.fetch(new Request("https://eti.test/terminal"), {} as any);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(await page.text(), /ETIAlgo signal intelligence/);
  const script = await worker.fetch(new Request("https://eti.test/terminal.js"), {} as any);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);
  assert.match(await script.text(), /loadSignal/);
  const home = await worker.fetch(new Request("https://eti.test/"), {} as any);
  assert.match(await home.text(), /href="\/terminal"/);
});

test("terminal exposes recent trades, chart presentation and manual level tools", () => {
  assert.match(TRADING_TERMINAL_HTML, /Recent trades/);
  assert.doesNotMatch(TRADING_TERMINAL_HTML, /Order book|tt-book|tt-spread|tt-bids|tt-asks/);
  assert.match(TRADING_TERMINAL_HTML, /tt-chart-style/);
  assert.match(TRADING_TERMINAL_HTML, /tt-draw-level/);
  assert.match(TRADING_TERMINAL_JS, /renderTrades/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /api\/market\/depth|tt-heatmap/);
  assert.match(TRADING_TERMINAL_JS, /api\/market\/trades/);
  assert.match(TRADING_TERMINAL_JS, /createPriceLine/);
});

test("institutional chart workspace exposes SMC, multi-timeframe and auction profile intelligence", () => {
  assert.match(TRADING_TERMINAL_HTML, /Institutional market intelligence/);
  assert.match(TRADING_TERMINAL_HTML, /tt-inst-layout/);
  assert.match(TRADING_TERMINAL_HTML, /tt-vp-poc/);
  assert.doesNotMatch(TRADING_TERMINAL_HTML, /tt-heatmap|Liquidity heatmap/);
  assert.match(TRADING_TERMINAL_JS, /api\/analysis\/smc/);
  assert.match(TRADING_TERMINAL_JS, /function calcProfile/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /function renderDepthHeat|renderDepth\(/);
  assert.match(TRADING_TERMINAL_JS, /function renderFlow/);
  assert.ok(!TRADING_TERMINAL_JS.includes("api/market/depth"));
  assert.ok(!TRADING_TERMINAL_JS.includes("renderDepth"));
  assert.match(TRADING_TERMINAL_JS, /saveChartPrefs/);
  assert.match(TRADING_TERMINAL_JS, /drawFallbackChart/);
  assert.match(TRADING_TERMINAL_JS, /if\(S\.chart&&S\.candle\)/);
  assert.match(TRADING_TERMINAL_JS, /Chart library unavailable · native chart fallback active/);
  assert.match(TRADING_TERMINAL_JS, /Promise\.allSettled/);
  assert.match(TRADING_TERMINAL_JS, /renderTrades\(trades\)/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /fetch\(["']\/api\/orders/);
});

test("terminal chart is full-width and institutional intelligence plus recent trades sit below the market structure monitor", () => {
  const chart = TRADING_TERMINAL_HTML.indexOf('<section class="tt-card tt-chart-card">');
  const ticket = TRADING_TERMINAL_HTML.indexOf('<aside class="tt-card tt-ticket">');
  const monitor = TRADING_TERMINAL_HTML.indexOf('<h2>Market structure monitor</h2>');
  const institutional = TRADING_TERMINAL_HTML.indexOf('<h2>Institutional market intelligence</h2>');
  const trades = TRADING_TERMINAL_HTML.indexOf('<h2>Recent trades</h2>');
  assert.ok(chart >= 0 && ticket > chart, "chart is first and ticket follows it");
  assert.ok(monitor > ticket, "market structure monitor follows the chart and planning ticket");
  assert.ok(institutional > monitor, "institutional intelligence follows the market structure monitor");
  assert.ok(trades > institutional, "recent trades follow institutional intelligence at the bottom");
  assert.match(TRADING_TERMINAL_CSS, /\.tt-work\\{display:grid;grid-template-columns:minmax\\(0,1fr\\)/);
  assert.match(TRADING_TERMINAL_CSS, /\.tt-chart\\{height:clamp\\(560px,72vh,900px\\);min-height:560px;width:100%\\}/);
  assert.match(TRADING_TERMINAL_CSS, /\.tt-chart-card\\{grid-column:1\\/-1;width:100%;min-width:0\\}/);
});
