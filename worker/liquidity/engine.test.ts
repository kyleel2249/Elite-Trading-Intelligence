import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiquidity } from "./engine.ts";
const now=Date.now();
const depth={timestamp:now,bids:[[99.9,20],[99.8,2],[99.7,1]],asks:[[100.1,2],[100.2,25],[100.3,1]]};
const candles=[
 [now-300000,99,100,98,99.5,10],[now-240000,99.5,100.2,99,100,12],
 [now-180000,100,101,99.8,100.8,15],[now-120000,100.8,101.2,100.5,101,13],
 [now-60000,101,101.1,98.5,99.2,20]
];
test("calculates valid spread, depth imbalance, walls and confluence metadata",()=>{
 const r=analyzeLiquidity({symbol:"BTCUSDT",venue:"bybit",market:"futures",depth,trades:[{price:100,qty:4,side:"buy"},{price:100,qty:1,side:"sell"}],candles});
 assert.equal(r.symbol,"BTCUSDT");assert.ok(r.spreadBps>0);assert.ok(r.walls.bids.length);assert.ok(r.walls.asks.length);
 assert.ok(r.confluence.score>=0&&r.confluence.score<=100);assert.equal(r.orderFlow.tradeCount,2);
});
test("classifies pulled, absorbed and replenished displayed liquidity using prior snapshots",()=>{
 const prev={bids:[[99.9,40],[99.8,2]],asks:[[100.1,2],[100.2,30]]};
 const curr={bids:[[99.9,5],[99.8,2]],asks:[[100.1,2],[100.2,45]]};
 const r=analyzeLiquidity({symbol:"BTCUSDT",venue:"bitget",market:"futures",depth:{...curr,timestamp:now},previousDepth:prev,trades:[{price:99.9,qty:20,side:"sell"}],candles});
 assert.ok(r.behaviour.pulled>=1);assert.ok(r.behaviour.replenished>=1);assert.ok(r.behaviour.absorbed>=1);
});
test("rejects crossed books and empty sides",()=>{
 assert.throws(()=>analyzeLiquidity({symbol:"BTCUSDT",venue:"x",market:"spot",depth:{bids:[],asks:[]}}),/valid_bid_and_ask/);
 assert.throws(()=>analyzeLiquidity({symbol:"BTCUSDT",venue:"x",market:"spot",depth:{bids:[[101,1]],asks:[[100,1]]}}),/crossed_or_locked/);
});
test("keeps unavailable trade/candle evidence explicit and never fabricates a trade direction",()=>{
 const r=analyzeLiquidity({symbol:"ETHUSDT",venue:"bybit",market:"spot",depth:{bids:[[99,2]],asks:[[101,2]]}});
 assert.equal(r.confluence.direction,"WAIT");assert.equal(r.orderFlow.tradeCount,0);assert.ok(r.dataQuality.warnings.length>=2);
});
