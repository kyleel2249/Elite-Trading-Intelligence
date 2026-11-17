import test from "node:test";
import assert from "node:assert/strict";
import { backtestV3Alpha } from "./v3-alpha-backtest.ts";
import { series } from "./fixtures.ts";
import { TF_SECONDS, type Timeframe } from "./timeframes.ts";
const NOW=1_800_000_000_000;
test("V3 Alpha replay is chronological, cost-aware and explicitly historical",()=>{
 const interval:Timeframe="15m",rows=series(600,{drift:.35,noise:.5,start:100,seed:41,stepMs:TF_SECONDS[interval]*1000,end:NOW-TF_SECONDS[interval]*1000});
 const r=backtestV3Alpha(rows,{symbol:"BTCUSDT",strategy:"intraday",interval,feeBps:10,slippageBps:5});
 assert.equal(r.status,"ok");assert.ok(r.bars===600);assert.ok(r.train&&r.test&&r.walkForward.length>0);assert.equal(r.disclaimer.includes("not forecasts"),true);
});
test("V3 Alpha replay rejects malformed candles and short history",()=>{
 const interval:Timeframe="15m";
 assert.equal(backtestV3Alpha(series(80),{symbol:"BTCUSDT",strategy:"intraday",interval,feeBps:10,slippageBps:5}).status,"insufficient_data");
 const rows=series(300);rows[200]=[rows[200][0],1,0,1,1,1];
 assert.equal(backtestV3Alpha(rows,{symbol:"BTCUSDT",strategy:"intraday",interval,feeBps:10,slippageBps:5}).status,"invalid_data");
});
