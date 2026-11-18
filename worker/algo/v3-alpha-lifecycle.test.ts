import test from "node:test";
import assert from "node:assert/strict";
import { advanceSignalLifecycle } from "./v3-alpha-ledger.ts";
import type { Kline } from "../market.ts";

function signal(direction:1|-1=1){return{id:"s1",signal_time:1000,direction,entry_low:99,entry_high:101,stop_loss:95,tp1:110,tp2:115,tp3:120,lifecycle_status:"confirmed"};}
const candle=(time:number,high:number,low:number):Kline=>[time,100,high,low,100,100];

test("signal remains confirmed until a candle reaches the entry zone",()=>{
 const r=advanceSignalLifecycle(signal(),[candle(2000,98,96)]);
 assert.equal(r.status,"confirmed");assert.equal(r.outcome,null);
});
test("long signal advances to entry reached and then TP1",()=>{
 const entered=advanceSignalLifecycle(signal(),[candle(2000,102,100)]);
 assert.equal(entered.status,"entry_reached");assert.equal(entered.outcome,null);
 const target=advanceSignalLifecycle({...signal(),lifecycle_status:entered.status},[candle(3000,111,108)]);
 assert.equal(target.status,"tp1_reached");assert.equal(target.outcome,"win");
});
test("short signal uses mirrored entry, stop and target conditions",()=>{
 const s=signal(-1);s.entry_low=99;s.entry_high=101;s.stop_loss=105;s.tp1=90;s.tp2=85;s.tp3=80;
 const entered=advanceSignalLifecycle(s,[candle(2000,101,98)]);
 assert.equal(entered.status,"entry_reached");
 const target=advanceSignalLifecycle({...s,lifecycle_status:entered.status},[candle(3000,92,89)]);
 assert.equal(target.status,"tp1_reached");assert.equal(target.outcome,"win");
});
test("stop is treated as first when a candle touches stop and target",()=>{
 const r=advanceSignalLifecycle(signal(),[candle(2000,111,94)]);
 assert.equal(r.status,"invalidated");assert.equal(r.outcome,"loss");assert.equal(r.r,-1);
});
test("stop before entry invalidates the setup; 100 observed candles expire it",()=>{
 const stopped=advanceSignalLifecycle(signal(),[candle(2000,98,94)]);
 assert.equal(stopped.status,"invalidated");assert.equal(stopped.outcome,"loss");
 const bars=Array.from({length:100},(_,i)=>candle(2000+i,98,96));
 const expired=advanceSignalLifecycle(signal(),bars);
 assert.equal(expired.status,"expired");assert.equal(expired.outcome,"expired");assert.equal(expired.bars,100);
});
