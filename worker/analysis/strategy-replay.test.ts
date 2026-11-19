import test from "node:test";import assert from "node:assert/strict";import {replayEmaStrategy} from "./strategy-replay.ts";
const data=Array.from({length:80},(_,i)=>({time:i+1,close:100+i+Math.sin(i/5)*3}));
test("replay produces finite metrics and trade stats",()=>{const r=replayEmaStrategy(data);assert.ok(Number.isFinite(r.netReturnPct));assert.ok(r.winRatePct>=0&&r.winRatePct<=100);assert.ok(r.maxDrawdownPct>=0);});
test("validates backtest candles and settings",()=>{assert.throws(()=>replayEmaStrategy(data.slice(0,10)),/backtest_requires/);assert.throws(()=>replayEmaStrategy(data,{fast:30,slow:20}),/invalid_ema_periods/);});
