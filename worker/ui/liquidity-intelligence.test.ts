import test from "node:test";
import assert from "node:assert/strict";
import { LIQUIDITY_CSS, LIQUIDITY_JS } from "./liquidity-intelligence.ts";
test("liquidity dashboard script parses and exposes the heatmap controls",()=>{
 assert.doesNotThrow(()=>new Function(LIQUIDITY_JS));
 for(const token of ["Institutional Liquidity Intelligence","eti-liq-canvas","eti-liq-overlay","eti-liq-scenarios","api/liquidity/analyze","api/analysis/orderflow","ETIBitget.subscribe","eti-sr-canvas","eti-strategy-direction","eti-risk-apply","riskPercent:30","venue:\"bitget\""])assert.ok(LIQUIDITY_JS.includes(token),token);
 assert.ok(LIQUIDITY_CSS.includes(".eti-liq-canvas"));
});
test("liquidity dashboard remains analysis-only and labels liquidation scenarios",()=>{
 assert.ok(LIQUIDITY_JS.includes("does not submit orders"));
 assert.ok(LIQUIDITY_JS.includes("not exchange liquidation data"));
 assert.ok(!LIQUIDITY_JS.includes("/api/orders"));
});

test("strategic support/resistance heat zones are painted on the shared live and Pro Terminal chart overlay",()=>{assert.ok(LIQUIDITY_JS.includes("supportResistanceHeatmap"));assert.ok(LIQUIDITY_JS.includes("SUP"));assert.ok(LIQUIDITY_JS.includes("RES"));assert.ok(LIQUIDITY_JS.includes("eti-liq-overlay"));});
test("capital and realised PnL inputs compound the next 30 percent risk budget",()=>{for(const token of ["eti-risk-capital","eti-risk-pnl","eti-risk-equity","eti-risk-next","capital+pnl","state.equity*.30","eti-risk-equity-v1"])assert.ok(LIQUIDITY_JS.includes(token),token);});
test("universal strategy UI defaults to Bitget and compounds closed-trade equity locally",()=>{assert.ok(LIQUIDITY_JS.includes("eti-risk-equity-v1"));assert.ok(LIQUIDITY_JS.includes("candlesByTimeframe:state.candlesByTimeframe"));assert.ok(LIQUIDITY_JS.includes("Update capital & calculate next trade"));assert.ok(LIQUIDITY_JS.includes("USDT-FUTURES"));});

test("capital UI uses unique IDs, records closed-trade PnL, and supports undo",()=>{assert.equal((LIQUIDITY_JS.match(/id="eti-risk-equity"/g)||[]).length,1);assert.ok(LIQUIDITY_JS.includes("eti-risk-equity-summary"));for(const token of ["eti-risk-ledger-v1","eti-risk-undo","renderRiskLedger","previousCapital","riskBudget:Number((next*.30).toFixed(8))"])assert.ok(LIQUIDITY_JS.includes(token),token);});
test("strategic chart zones use native Lightweight Charts price coordinates when available",()=>{assert.ok(LIQUIDITY_JS.includes("window.ETILiveChart"));assert.ok(LIQUIDITY_JS.includes("window.ETIProTerminalChart"));assert.ok(LIQUIDITY_JS.includes("bridge.priceToCoordinate"));assert.ok(LIQUIDITY_JS.includes("document.querySelector(\"#chartAdvanced\")"));});
test("multi-timeframe confluence is visible in the strategy summary",()=>{assert.ok(LIQUIDITY_JS.includes("multiTimeframeConfluence?.bias"));assert.ok(LIQUIDITY_JS.includes("availableCount"));});


test("Institutional heatmaps render horizontal price zones and vertical structure-event bands",()=>{
 for(const token of ["buildStructureMap","unmitigated","orderBlocks","CHoCH","BOS","timeToCoordinate","priceToCoordinate","data-eti-layer"])assert.ok(LIQUIDITY_JS.includes(token),token);
 assert.ok(LIQUIDITY_JS.includes('state.layers.fvg'));
 assert.ok(LIQUIDITY_JS.includes('state.layers.structure'));
});
test("Bitget liquidity intelligence can recover from REST depth failure using its live WebSocket book",()=>{
 assert.ok(LIQUIDITY_JS.includes("Bitget WebSocket recovery"));
 assert.ok(LIQUIDITY_JS.includes("waiting for WebSocket depth"));
 assert.ok(LIQUIDITY_JS.includes("state.sequence++;state.busy=false"));
});


test("Institutional Bitget recovery retains streamed candles and maps cached ticker metrics correctly",()=>{
 assert.ok(LIQUIDITY_JS.includes('else if(m.type==="candle")'));
 assert.ok(LIQUIDITY_JS.includes("state.structure=buildStructureMap(state.candles)"));
 assert.ok(LIQUIDITY_JS.includes("quoteVolume:state.marketMetrics.turnover24h"));
 assert.ok(LIQUIDITY_JS.includes("if(!state.candles.length)throw e;rows=state.candles"));
});


test("Institutional Bitget WebSocket ticker feeds turnover, price change and derivatives into analysis",()=>{
 for(const token of ['m.type==="ticker"','turnover24h:t.quoteVolume','priceChange24h:t.priceChangePercent','source:"bitget-websocket"'])assert.ok(LIQUIDITY_JS.includes(token),token);
});


test("Institutional Liquidity reads the selected Bitget contract category instead of defaulting all futures to USDT",()=>{
 assert.ok(LIQUIDITY_JS.includes('$(state.root?"orderBitgetMarket":"tt-category")'));
 assert.ok(LIQUIDITY_JS.includes('["USDT-FUTURES","USDC-FUTURES","COIN-FUTURES"].includes(normalizedCategory)'));
});


test("Institutional category routing keeps Bybit inverse/linear mapping separate from Bitget product types",()=>{
 assert.ok(LIQUIDITY_JS.includes('state.root&&state.venue==="bitget"?$("orderBitgetMarket")'));
 assert.ok(LIQUIDITY_JS.includes('cat==="inverse"?"inverse":"linear"'));
});
