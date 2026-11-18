import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { detectDivergence } from "./divergence.ts";

function rows():Kline[]{return Array.from({length:40},(_,i)=>[i*60_000,100,101,99,100,100]);}
function osc():number[]{return Array(40).fill(50);}
test("detects regular bullish divergence from a lower price low and higher RSI low",()=>{
 const c=rows(),r=osc();c[10]=[c[10][0],100,101,95,99,100];c[22]=[c[22][0],100,101,92,99,100];r[10]=28;r[22]=41;
 const x=detectDivergence(c,r,{left:2,right:2,lookback:40});
 assert.equal(x.kind,"regular_bullish");assert.equal(x.direction,1);assert.equal(x.status,"detected");assert.ok(x.strength>50);
});
test("detects hidden bullish divergence from a higher price low and lower RSI low",()=>{
 const c=rows(),r=osc();c[10]=[c[10][0],100,101,94,99,100];c[22]=[c[22][0],100,101,97,99,100];r[10]=42;r[22]=27;
 assert.equal(detectDivergence(c,r,{left:2,right:2,lookback:40}).kind,"hidden_bullish");
});
test("detects regular bearish divergence from a higher price high and lower RSI high",()=>{
 const c=rows(),r=osc();c[10]=[c[10][0],100,105,99,101,100];c[22]=[c[22][0],100,108,99,101,100];r[10]=76;r[22]=61;
 const x=detectDivergence(c,r,{left:2,right:2,lookback:40});assert.equal(x.kind,"regular_bearish");assert.equal(x.direction,-1);
});
test("does not use a swing pivot until its right-hand confirmation bars exist",()=>{
 const c=rows(),r=osc();c[10]=[c[10][0],100,101,95,99,100];c[37]=[c[37][0],100,101,90,99,100];r[10]=30;r[37]=45;
 const x=detectDivergence(c,r,{left:2,right:3,lookback:40});assert.equal(x.status,"none");
});
test("rejects insufficient or misaligned inputs without throwing",()=>{
 assert.equal(detectDivergence(rows().slice(0,20),osc().slice(0,20)).status,"insufficient_data");
 assert.equal(detectDivergence(rows(),osc().slice(0,39)).status,"insufficient_data");
});
