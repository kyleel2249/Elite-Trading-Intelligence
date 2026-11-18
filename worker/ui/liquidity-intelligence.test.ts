import test from "node:test";
import assert from "node:assert/strict";
import { LIQUIDITY_CSS, LIQUIDITY_JS } from "./liquidity-intelligence.ts";
test("liquidity dashboard script parses and exposes the heatmap controls",()=>{
 assert.doesNotThrow(()=>new Function(LIQUIDITY_JS));
 for(const token of ["Institutional Liquidity Intelligence","eti-liq-canvas","eti-liq-overlay","eti-liq-scenarios","api/liquidity/analyze","api/analysis/orderflow","ETIBitget.subscribe"])assert.ok(LIQUIDITY_JS.includes(token),token);
 assert.ok(LIQUIDITY_CSS.includes(".eti-liq-canvas"));
});
test("liquidity dashboard remains analysis-only and labels liquidation scenarios",()=>{
 assert.ok(LIQUIDITY_JS.includes("does not submit orders"));
 assert.ok(LIQUIDITY_JS.includes("not exchange liquidation data"));
 assert.ok(!LIQUIDITY_JS.includes("/api/orders"));
});
