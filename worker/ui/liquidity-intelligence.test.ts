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
test("universal strategy UI defaults to Bitget and compounds closed-trade equity locally",()=>{assert.ok(LIQUIDITY_JS.includes("eti-risk-equity-v1"));assert.ok(LIQUIDITY_JS.includes("candlesByTimeframe:state.candlesByTimeframe"));assert.ok(LIQUIDITY_JS.includes("Apply to next-trade equity"));assert.ok(LIQUIDITY_JS.includes("USDT-FUTURES"));});
