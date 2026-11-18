import test from "node:test";
import assert from "node:assert/strict";
import {
  BITGET_WS_ENDPOINTS, bitgetWsEndpoint, bitgetUtaPublicArgs,
  bitgetPrivateCredentialSet, decodeBitgetSbe
} from "./transports.ts";

test("only Production UTA V3 JSON and SBE endpoints are enabled", () => {
  assert.equal(bitgetWsEndpoint("production","uta","public"),"wss://ws.bitget.com/v3/ws/public");
  assert.equal(bitgetWsEndpoint("production","uta","private"),"wss://ws.bitget.com/v3/ws/private");
  assert.equal(bitgetWsEndpoint("production","uta","public",true),"wss://ws.bitget.com/v3/ws/public/sbe");
  assert.ok(BITGET_WS_ENDPOINTS.production.uta);
});

test("UTA public subscriptions use the V3 topic schema", () => {
  const uta=bitgetUtaPublicArgs("usdt-futures","BTCUSDT","1m");
  assert.deepEqual(uta[0],{instType:"usdt-futures",topic:"ticker",symbol:"BTCUSDT"});
  assert.ok(uta.some(x=>x.topic==="kline"&&x.interval==="1m"));
});

test("private credentials resolve only the production UTA key set",()=>{
  const env={BITGET_API_KEY:"live",BITGET_API_SECRET:"ls",BITGET_API_PASSPHRASE:"lp"};
  assert.equal(bitgetPrivateCredentialSet(env).key,"live");
});

function frame(template:number,block:number,version:number,body:number[]) {
  const bytes=new Uint8Array(8+body.length),v=new DataView(bytes.buffer);
  v.setUint16(0,block,true);v.setUint16(2,template,true);v.setUint16(4,1,true);v.setUint16(6,version,true);
  bytes.set(body,8);return bytes;
}
function putI64(a:number[],n:bigint){const b=new ArrayBuffer(8);new DataView(b).setBigInt64(0,n,true);a.push(...new Uint8Array(b));}
function putU64(a:number[],n:bigint){const b=new ArrayBuffer(8);new DataView(b).setBigUint64(0,n,true);a.push(...new Uint8Array(b));}

test("SBE BBO template 1002 decodes fixed-point prices, sizes, sequence and symbol",()=>{
 const b:number[]=[];putU64(b,1700000000000001n);putI64(b,6569038n);putI64(b,15000n);putI64(b,6569042n);putI64(b,20000n);b.push(0xfe,0xfc);putU64(b,1n);b.push(0,0,0,0,0,0,7,...new TextEncoder().encode("BTCUSDT"));
 const d=decodeBitgetSbe(frame(1002,56,2,b));
 assert.equal(d.type,"books1");assert.equal(d.bids[0][0],65690.38);assert.ok(Math.abs(d.bids[0][1]-1.5)<1e-12);assert.equal(d.asks[0][0],65690.42);assert.ok(Math.abs(d.asks[0][1]-2)<1e-12);assert.equal(d.seq,1);assert.equal(d.symbol,"BTCUSDT");
});

test("SBE publicTrade template 1003 decodes batch trade entry and symbol",()=>{
 const b:number[]=[0xfe,0xfc,0,0,0,0,0,0];b.push(48,0,1,0);putU64(b,1700000000000002n);putU64(b,9999n);putI64(b,6566738n);putI64(b,5000n);b.push(0,0);putU64(b,1700000000001002n);b.push(1,0,0,0,0,0,7,...new TextEncoder().encode("BTCUSDT"));
 const d=decodeBitgetSbe(frame(1003,8,4,b));
 assert.equal(d.trades[0].price,65667.38);assert.ok(Math.abs(d.trades[0].size-0.5)<1e-12);assert.equal(d.trades[0].side,"buy");assert.equal(d.symbol,"BTCUSDT");
});

test("SBE rejects unsupported schemas, templates and truncated frames",()=>{
 assert.throws(()=>decodeBitgetSbe(new Uint8Array([1,2])),/too_short/);
 const bad=frame(1002,56,2,new Array(56).fill(0));new DataView(bad.buffer).setUint16(4,2,true);
 assert.throws(()=>decodeBitgetSbe(bad),/schema/);
 assert.throws(()=>decodeBitgetSbe(frame(9999,8,1,new Array(8).fill(0))),/template/);
});


test("SBE Depth50 schema v5 decodes groups and incremental continuity metadata",()=>{
 const b:number[]=[];putU64(b,1700000000000000n);putU64(b,42n);b.push(0xfe,0xfc);putU64(b,1700000000001000n);b.push(1);putU64(b,41n);b.push(1,0,0,0,0);
 b.push(16,0,1,0);putI64(b,6566738n);putI64(b,5000n);
 b.push(16,0,1,0);putI64(b,6566438n);putI64(b,6000n);
 b.push(7,...new TextEncoder().encode("BTCUSDT"));
 const d=decodeBitgetSbe(frame(1001,40,5,b));
 assert.equal(d.type,"books50");assert.equal(d.seq,42);assert.equal(d.pseq,41);assert.equal(d.depthAction,1);assert.equal(d.asks[0][0],65667.38);assert.ok(Math.abs(d.bids[0][1]-0.6)<1e-12);assert.equal(d.symbol,"BTCUSDT");
});
