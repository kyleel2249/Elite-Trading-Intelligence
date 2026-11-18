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
  assert.match(TRADING_TERMINAL_HTML, /tt-heatmap/);
  assert.match(TRADING_TERMINAL_JS, /api\/analysis\/smc/);
  assert.match(TRADING_TERMINAL_JS, /function calcProfile/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /function renderDepthHeat|renderDepth\(/);
  assert.match(TRADING_TERMINAL_JS, /function renderFlow/);
  assert.match(TRADING_TERMINAL_JS, /saveChartPrefs/);
  assert.match(TRADING_TERMINAL_JS, /drawFallbackChart/);
  assert.match(TRADING_TERMINAL_JS, /if\(S\.chart&&S\.candle\)/);
  assert.match(TRADING_TERMINAL_JS, /Chart library unavailable · native chart fallback active/);
  assert.match(TRADING_TERMINAL_JS, /Promise\.allSettled/);
  assert.match(TRADING_TERMINAL_JS, /renderTrades\(trades\)/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /fetch\(["']\/api\/orders/);
});
