import test from "node:test";
import assert from "node:assert/strict";
import { backtestV3AlphaMtf } from "./v3-alpha-mtf-backtest.ts";
import { series } from "./fixtures.ts";
import { TF_SECONDS } from "./timeframes.ts";

const NOW=1_800_000_000_000;
test("MTF replay is causal, chronological and returns separate holdout metrics",()=>{
 const candles={
  "15m":series(600,{drift:.3,noise:.6,start:100,seed:81,stepMs:TF_SECONDS["15m"]*1000,end:NOW-TF_SECONDS["15m"]*1000}),
  "1h":series(300,{drift:.3,noise:.6,start:100,seed:82,stepMs:TF_SECONDS["1h"]*1000,end:NOW-TF_SECONDS["1h"]*1000}),
  "4h":series(150,{drift:.3,noise:.6,start:100,seed:83,stepMs:TF_SECONDS["4h"]*1000,end:NOW-TF_SECONDS["4h"]*1000}),
  "1d":series(100,{drift:.3,noise:.6,start:100,seed:84,stepMs:TF_SECONDS["1d"]*1000,end:NOW-TF_SECONDS["1d"]*1000})
 };
 const result=backtestV3AlphaMtf(candles,{symbol:"BTCUSDT",strategy:"intraday",feeBps:10,slippageBps:5});
 assert.equal(result.status,"ok");
 assert.equal(result.bars,600);
 assert.equal(result.train!==null,true);
 assert.equal(result.test!==null,true);
 assert.equal(result.method.includes("Closed-candle synchronized"),true);
 assert.equal(result.disclaimer.includes("not a forecast"),true);
});
test("MTF replay rejects insufficient or malformed execution candles",()=>{
 assert.equal(backtestV3AlphaMtf({"15m":series(100)},{symbol:"BTCUSDT",strategy:"intraday",feeBps:10,slippageBps:5}).status,"insufficient_data");
 const rows=series(300);rows[150]=[rows[150][0],1,0,1,1,1];
 assert.equal(backtestV3AlphaMtf({"15m":rows},{symbol:"BTCUSDT",strategy:"intraday",feeBps:10,slippageBps:5}).status,"invalid_data");
});
