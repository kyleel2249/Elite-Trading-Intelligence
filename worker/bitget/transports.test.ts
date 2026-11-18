import test from "node:test";
import assert from "node:assert/strict";
import {
  BITGET_WS_ENDPOINTS, bitgetWsEndpoint, bitgetUtaPublicArgs, bitgetClassicPublicArgs,
  bitgetClassicPrivateSubscriptions, bitgetPrivateCredentialSet, decodeBitgetSbe
} from "./transports.ts";

test("all documented production/demo UTA, SBE and Classic endpoints are explicit", () => {
  assert.equal(bitgetWsEndpoint("production","uta","public"),"wss://ws.bitget.com/v3/ws/public");
  assert.equal(bitgetWsEndpoint("production","uta","private"),"wss://ws.bitget.com/v3/ws/private");
  assert.equal(bitgetWsEndpoint("production","uta","public",true),"wss://ws.bitget.com/v3/ws/public/sbe");
  assert.equal(bitgetWsEndpoint("demo","uta","public"),"wss://wspap.bitget.com/v3/ws/public");
  assert.equal(bitgetWsEndpoint("demo","uta","private"),"wss://wspap.bitget.com/v3/ws/private");
  assert.equal(bitgetWsEndpoint("production","classic","public"),"wss://ws.bitget.com/v2/ws/public");
  assert.equal(bitgetWsEndpoint("production","classic","private"),"wss://ws.bitget.com/v2/ws/private");
  assert.throws(()=>bitgetWsEndpoint("demo","classic","public"),/unsupported_environment_account_combination/);
  assert.throws(()=>bitgetWsEndpoint("demo","classic","public",true),/sbe_public_uta_only/);
  assert.ok(BITGET_WS_ENDPOINTS);
});

test("UTA and Classic public subscriptions use their respective wire schemas", () => {
  const uta=bitgetUtaPublicArgs("usdt-futures","BTCUSDT","1m");
  assert.deepEqual(uta[0],{instType:"usdt-futures",topic:"ticker",symbol:"BTCUSDT"});
  assert.ok(uta.some(x=>x.topic==="kline"&&x.interval==="1m"));
  const classic=bitgetClassicPublicArgs("USDT-FUTURES","BTCUSDT","1m");
  assert.deepEqual(classic[0],{instType:"USDT-FUTURES",channel:"ticker",instId:"BTCUSDT"});
  assert.ok(classic.some(x=>x.channel==="candle1m"&&x.instId==="BTCUSDT"));
  assert.ok(!("topic" in classic[0]));
});

test("Classic private subscriptions cover spot account, orders and all futures positions/orders",()=>{
  const s=bitgetClassicPrivateSubscriptions();
  assert.ok(s.some(x=>x.instType==="SPOT"&&x.channel==="account"));
  assert.ok(s.some(x=>x.instType==="SPOT"&&x.channel==="orders"));
  for(const type of ["USDT-FUTURES","USDC-FUTURES","COIN-FUTURES"]){
    assert.ok(s.some(x=>x.instType===type&&x.channel==="orders"));
    assert.ok(s.some(x=>x.instType===type&&x.channel==="positions"));
  }
});

test("environment-scoped private credentials are isolated",()=>{
  const env={BITGET_API_KEY:"live",BITGET_API_SECRET:"ls",BITGET_API_PASSPHRASE:"lp",BITGET_DEMO_API_KEY:"demo",BITGET_DEMO_API_SECRET:"ds",BITGET_DEMO_API_PASSPHRASE:"dp",BITGET_CLASSIC_API_KEY:"classic",BITGET_CLASSIC_API_SECRET:"cs",BITGET_CLASSIC_API_PASSPHRASE:"cp"};
  assert.equal(bitgetPrivateCredentialSet(env,"production","uta").key,"live");
  assert.equal(bitgetPrivateCredentialSet(env,"demo","uta").key,"demo");
  assert.equal(bitgetPrivateCredentialSet(env,"production","classic").key,"classic");
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
 assert.equal(d.type,"books1");assert.equal(d.bids[0][0],65690.38);assert.equal(d.bids[0][1],1.5);assert.equal(d.asks[0][0],65690.42);assert.equal(d.asks[0][1],2);assert.equal(d.seq,1);assert.equal(d.symbol,"BTCUSDT");
});

test("SBE publicTrade template 1003 decodes batch trade entry and symbol",()=>{
 const b:number[]=[0xfe,0xfc,0,0,0,0,0,0];b.push(48,0,1,0);putU64(b,1700000000000002n);putU64(b,9999n);putI64(b,6566738n);putI64(b,5000n);b.push(0,0);putU64(b,1700000000001002n);b.push(1,0,0,0,0,0,7,...new TextEncoder().encode("BTCUSDT"));
 const d=decodeBitgetSbe(frame(1003,8,4,b));
 assert.equal(d.trades[0].price,65667.38);assert.equal(d.trades[0].size,0.5);assert.equal(d.trades[0].side,"buy");assert.equal(d.symbol,"BTCUSDT");
});

test("SBE rejects unsupported schemas, templates and truncated frames",()=>{
 assert.throws(()=>decodeBitgetSbe(new Uint8Array([1,2])),/too_short/);
 const bad=frame(1002,56,2,new Array(56).fill(0));new DataView(bad.buffer).setUint16(4,2,true);
 assert.throws(()=>decodeBitgetSbe(bad),/schema/);
 assert.throws(()=>decodeBitgetSbe(frame(9999,8,1,new Array(8).fill(0))),/template/);
});
