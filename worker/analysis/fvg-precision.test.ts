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
 const rows=candles(Array.from({length:90},(_,i)=>{if(i===45)return [100,100.2,99.8,100.1,100];if(i===46)return [100.1,102.5,100.0,102.2,240];if(i===47)return [102.2,103.5,101.2,103.1,180];const p=i<45?100+Math.sin(i)*.08:103+(i-48)*.015;return [p,p+.15,p-.15,p+.03,100];}));
 const out=analyzeFvgPrecision(rows,"5m");
 assert.ok(out.candidates.length>0,"synthetic displacement should create at least one FVG");
 for(const c of out.candidates) assert.ok(Math.abs(c.entry.price-(c.zone.lower+c.zone.upper)/2)<1e-8);
});
