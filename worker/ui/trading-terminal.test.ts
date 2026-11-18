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
  assert.match(TRADING_TERMINAL_JS, /\/api\/market\/depth/);
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
  assert.match(TRADING_TERMINAL_JS, /\/api\/market\/depth/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /tt-heatmap/);
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
  assert.ok(TRADING_TERMINAL_JS.includes("api/market/depth"));
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
  assert.ok(TRADING_TERMINAL_CSS.includes(".tt-work{display:grid;grid-template-columns:minmax(0,1fr)"), "chart workspace has one full-width column");
  assert.ok(TRADING_TERMINAL_CSS.includes(".tt-chart{height:clamp(520px,58vh,620px);min-height:520px;max-height:620px;width:100%;position:relative}"), "Pro Terminal chart matches the Live Market Chart height and full width");
  assert.ok(TRADING_TERMINAL_CSS.includes(".tt-shell{max-width:1920px;margin:auto;padding:12px 24px 34px;"), "Pro Terminal uses the same 1920px desktop workspace width");
  assert.ok(TRADING_TERMINAL_CSS.includes(".tt-chart-card{grid-column:1/-1;width:100%;min-width:0}"), "chart card spans the entire workspace");
});


test("advanced terminal chart preserves exchange tick precision for tiny-priced instruments", () => {
  assert.match(TRADING_TERMINAL_JS, /pricePrecision:2/);
  assert.match(TRADING_TERMINAL_JS, /function decimalPlaces\(/);
  assert.match(TRADING_TERMINAL_JS, /function capturePricePrecision\(/);
  assert.match(TRADING_TERMINAL_JS, /minimumFractionDigits:S\.pricePrecision/);
  assert.match(TRADING_TERMINAL_JS, /maximumFractionDigits:S\.pricePrecision/);
  assert.match(TRADING_TERMINAL_JS, /precision:S\.pricePrecision/);
  assert.match(TRADING_TERMINAL_JS, /capturePricePrecision\(\(d\.candles\|\|\[\]\)\.flatMap/);
  assert.match(TRADING_TERMINAL_JS, /capturePricePrecision\(\(results\[0\]\.value\|\|\[\]\)\.flatMap/);
  assert.match(TRADING_TERMINAL_JS, /v\.toFixed\(S\.pricePrecision\)/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /maximumFractionDigits:8/);
});


test("synchronized multi-chart workspace shares venue, symbol and visible time range", () => {
  for (const tf of ["5m", "15m", "1h", "4h"]) assert.match(TRADING_TERMINAL_HTML, new RegExp("tt-multi-" + tf));
  assert.match(TRADING_TERMINAL_HTML, /Synchronized multi-timeframe charts/);
  assert.match(TRADING_TERMINAL_JS, /function initMultiCharts\(/);
  assert.match(TRADING_TERMINAL_JS, /function loadMultiCharts\(/);
  assert.match(TRADING_TERMINAL_JS, /subscribeVisibleTimeRangeChange/);
  assert.match(TRADING_TERMINAL_JS, /setVisibleRange\(range\)/);
  assert.match(TRADING_TERMINAL_JS, /Promise\.allSettled/);
});

test("advanced order-flow metrics use exchange trades and depth and feed ETIAlgo read-only analysis", () => {
  for (const id of ["tt-of-buy", "tt-of-sell", "tt-of-delta", "tt-of-delta-pct", "tt-of-imbalance", "tt-of-spread", "tt-of-microprice"]) assert.match(TRADING_TERMINAL_HTML, new RegExp(id));
  assert.match(TRADING_TERMINAL_JS, /function renderOrderFlow\(/);
  assert.match(TRADING_TERMINAL_JS, /function loadOmniSignal\(/);
  assert.match(TRADING_TERMINAL_JS, /api\/omnisignal/);
  assert.match(TRADING_TERMINAL_JS, /loadSignalInputs/);
  assert.match(TRADING_TERMINAL_HTML, /tt-footprint/);
  assert.match(TRADING_TERMINAL_HTML, /Historical liquidity persistence/i);
  assert.match(TRADING_TERMINAL_JS, /function loadDeepOrderFlow\(/);
  assert.match(TRADING_TERMINAL_JS, /api\/analysis\/orderflow/);
  assert.match(TRADING_TERMINAL_JS, /renderDeepOrderFlow/);
  assert.match(TRADING_TERMINAL_JS, /liveExecutionAllowed/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /fetch\(["']\/api\/orders/);
});


test("Pro Terminal paints qualified Liquidity-FVG zones and estimated sweep reach over the live chart", () => {
  assert.match(TRADING_TERMINAL_HTML, /Liquidity \+ FVG fusion intelligence/);
  assert.match(TRADING_TERMINAL_CSS, /\.tt-liq-overlay/);
  assert.match(TRADING_TERMINAL_JS, /function drawLiquidityOverlay\(/);
  assert.match(TRADING_TERMINAL_JS, /QUALIFIED /);
  assert.match(TRADING_TERMINAL_JS, /ESTIMATED SWEEP REACH/);
  assert.match(TRADING_TERMINAL_JS, /drawLiquidityOverlay\(\)/);
  assert.match(TRADING_TERMINAL_JS, /S\.liquidityFvg\.manipulation/);
  assert.match(TRADING_TERMINAL_JS, /S\.liquidityFvg\.precision/);
});

test("Pro Terminal defaults to Bitget and translates UI contract labels into Bitget product types",()=>{assert.match(TRADING_TERMINAL_HTML,/<option value="bitget" selected>Bitget<\/option>/);assert.match(TRADING_TERMINAL_JS,/S=\{venue:"bitget"/);assert.match(TRADING_TERMINAL_JS,/function bitgetProductType\(\)/);assert.match(TRADING_TERMINAL_JS,/category:bitgetProductType\(\)/);});

test("Pro Terminal publishes native price coordinates for shared strategic liquidity overlays",()=>{assert.match(TRADING_TERMINAL_JS,/window\.ETIProTerminalChart=\{priceToCoordinate:/);assert.match(TRADING_TERMINAL_JS,/S\.candle\.priceToCoordinate\(p\)/);});


test("Pro Terminal invalidates stale exchange loads and exposes time coordinates for strategic overlays",()=>{
 assert.match(TRADING_TERMINAL_JS,/loadSeq:0/);
 assert.match(TRADING_TERMINAL_JS,/const loadSeq=\+\+S\.loadSeq/);
 assert.match(TRADING_TERMINAL_JS,/if\(loadSeq!==S\.loadSeq\)return/);
 assert.match(TRADING_TERMINAL_JS,/timeToCoordinate:time=>/);
});


test("Pro Terminal starts Bitget streaming before REST and retains recent cached candles on temporary REST failure",()=>{
 const stream=TRADING_TERMINAL_JS.indexOf("ensureTerminalBitgetStream();const d=await window.ETIBitget.marketData");
 assert.ok(stream>=0);
 assert.ok(TRADING_TERMINAL_JS.includes("function restoreMarketCache()"));
 assert.ok(TRADING_TERMINAL_JS.includes("function saveMarketCache()"));
 assert.ok(TRADING_TERMINAL_JS.includes("WebSocket live recovery"));
});


test("Pro Terminal preserves USDT, USDC and Coin-M Bitget futures selections",()=>{
 assert.match(TRADING_TERMINAL_JS,/\["USDT-FUTURES","USDC-FUTURES","COIN-FUTURES"\]\.includes\(category\)/);
});


test("Pro Terminal sends the selected exchange provenance with supplied SMC candles",()=>{
 assert.ok(TRADING_TERMINAL_JS.includes('venue:provider,provider,candles:d.candles'));
});


test("terminal exposes production/demo, UTA/Classic and JSON/SBE public transport selectors",()=>{
 for(const id of ["tt-bg-env","tt-bg-account","tt-bg-protocol","tt-private-connect","tt-private-status"])assert.match(TRADING_TERMINAL_HTML,new RegExp('id="'+id+'"'));
 assert.match(TRADING_TERMINAL_JS,/subscribeTransport\(options,handlers\)/);
 assert.match(TRADING_TERMINAL_JS,/S\.bitgetEnvironment/);
 assert.match(TRADING_TERMINAL_JS,/S\.bitgetAccount/);
 assert.match(TRADING_TERMINAL_JS,/S\.bitgetProtocol/);
 assert.match(TRADING_TERMINAL_JS,/terminalBitgetAuxStream/);
 assert.match(TRADING_TERMINAL_JS,/subscribePrivate\(\{environment:S\.bitgetEnvironment,account:S\.bitgetAccount,maxRetries:4\}/);
 assert.match(TRADING_TERMINAL_JS,/toggleTerminalBitgetPrivateStream/);
});

test("terminal forces unsupported demo Classic and SBE combinations back to supported UTA modes",()=>{
 assert.match(TRADING_TERMINAL_JS,/if\(env\.value==="demo"\)\{account\.value="uta";protocol\.value="json";\}/);
 assert.match(TRADING_TERMINAL_JS,/if\(account\.value==="classic"\)\{env\.value="production";protocol\.value="json";\}/);
 assert.match(TRADING_TERMINAL_JS,/if\(protocol\.value==="sbe"\)\{env\.value="production";account\.value="uta";\}/);
});
