import test from "node:test";
import assert from "node:assert/strict";
import { evaluateV3Alpha } from "./v3-alpha.ts";
import { series } from "./fixtures.ts";
import { TIMEFRAMES,TF_SECONDS,type Timeframe } from "./timeframes.ts";
const NOW=1_800_000_000_000;
function market(drift:number){const candles:Partial<Record<Timeframe,any>>={};for(const tf of TIMEFRAMES)candles[tf]=series(280,{drift,noise:.12,start:100,seed:17,stepMs:TF_SECONDS[tf]*1000,end:NOW-TF_SECONDS[tf]*2000});return candles}
test("V3 Alpha emits bounded, closed-candle analysis and never submits orders",()=>{const r=evaluateV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:market(.8),now:NOW});assert.equal(r.name,"ETIAlgo V3 Alpha");assert.equal(r.nonRepainting,true);assert.equal(r.submitsOrder,false);assert.ok(r.divergence&&["detected","none","insufficient_data"].includes(r.divergence.status));assert.ok(r.score>=-100&&r.score<=100);if(r.status==="SIGNAL"){assert.equal(r.action,"BUY");assert.ok(r.stopLoss!<r.entryZone![0]);assert.equal(r.takeProfits!.length,3)}});
test("V3 Alpha rejects short and stale data",()=>{assert.equal(evaluateV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:{"15m":series(20)},now:NOW}).status,"INSUFFICIENT_DATA");const c=market(.8);c["15m"]=series(280,{stepMs:TF_SECONDS["15m"]*1000,end:NOW-TF_SECONDS["15m"]*10_000});assert.equal(evaluateV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:c,now:NOW}).status,"INSUFFICIENT_DATA")});
test("V3 Alpha ignores a still-forming last candle",()=>{const c=market(.8),a=evaluateV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:c,now:NOW});c["15m"]=[...c["15m"]!,[NOW-60000,110,112,109,111,900]];const b=evaluateV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:c,now:NOW});assert.equal(b.evaluatedCandleTime,a.evaluatedCandleTime)});
