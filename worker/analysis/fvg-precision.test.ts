import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFvgPrecision } from "./fvg-precision.ts";
import type { Kline } from "../market.ts";

const candles = (values: number[][]): Kline[] => values.map((r,i)=>[1_700_000_000_000+i*60_000,r[0],r[1],r[2],r[3],r[4]] as Kline);

test("precision engine is fail-closed with insufficient history",()=>{
 const out=analyzeFvgPrecision(candles([[10,11,9,10,1]]),"5m");
 assert.equal(out.status,"insufficient_history"); assert.equal(out.direction,"WAIT"); assert.equal(out.submitsOrder,false);
});

test("precision engine never authorizes or submits an order",()=>{
 const rows=candles(Array.from({length:80},(_,i)=>{const p=100+Math.sin(i/3)*2+i*.04;return [p,p+1,p-1,p+.2,100+i];}));
 const out=analyzeFvgPrecision(rows,"5m",{symbol:"TEST"});
 assert.equal(out.canTriggerTrade,false); assert.equal(out.submitsOrder,false); assert.equal(out.liveExecutionAllowed,false);
 assert.ok(out.candidates.length<=20);
});

test("FVG candidate entries use exact consequent-encroachment midpoint",()=>{
 const rows=candles(Array.from({length:90},(_,i)=>{const p=100+i*.03;return [p,p+.4,p-.4,p+.1,100];}));
 const out=analyzeFvgPrecision(rows,"5m");
 for(const c of out.candidates) assert.equal(c.entry.price,(c.zone.lower+c.zone.upper)/2);
});
