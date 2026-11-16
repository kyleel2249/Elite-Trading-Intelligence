import test from "node:test";
import assert from "node:assert/strict";
import { placeBitgetLiveOrder } from "./trading.ts";

const baseEnv:any={BITGET_API_KEY:"key",BITGET_API_SECRET:"secret",BITGET_API_PASSPHRASE:"pass",ETI_BITGET_LIVE_ENABLED:"true",ETI_BITGET_MAX_LEVERAGE:"150",ETI_BITGET_MAX_NOTIONAL_USDT:"10000",ETI_MAX_ORDER_QUANTITY:"100",ETI_EXECUTION_LOG:null};
function store(){const m=new Map<string,string>();return {m,get:async(k:string)=>m.get(k)??null,put:async(k:string,v:string)=>{m.set(k,v)}};}
function ok(){return new Response(JSON.stringify({code:"00000",msg:"success",data:{orderId:"bg-order-1",clientOid:"eti1234567890abcdef"}}),{status:200});}
const orderBody=(overrides:any={})=>({broker:"bitget",bitgetMarket:"spot",symbol:"BTCUSDT",side:"buy",type:"market",quantity:0.01,quoteAmount:100,clientOrderId:"eti1234567890abcdef",riskConfirmed:true,executionSource:{actorType:"manual_user",actorId:"operator",sourceName:"ETI Dashboard"},...overrides});

test("Bitget spot market buy sends quote-denominated size and records live execution",async()=>{
 const kv=store(),env={...baseEnv,ETI_EXECUTION_LOG:kv};let seen:any;
 const r=await placeBitgetLiveOrder(env,orderBody(),{now:()=>1700000000000,fetchImpl:(async(url:any,init:any)=>{seen={url,init};return ok();}) as any});
 assert.equal(r.status,201);const b:any=await r.json();assert.equal(b.broker,"bitget");assert.equal(b.mode,"live");assert.equal(b.exchangeOrderPlaced,true);
 assert.equal(seen.url,"https://api.bitget.com/api/v2/spot/trade/place-order");
 const p=JSON.parse(seen.init.body);assert.equal(p.size,"100");assert.equal(p.orderType,"market");assert.equal(p.clientOid,"eti1234567890abcdef");
 assert.equal(kv.m.get("exec:live:id:eti1234567890abcdef"),"executed");
});

test("Bitget futures configures isolated margin and leverage before submitting a futures order",async()=>{
 const kv=store(),env={...baseEnv,ETI_EXECUTION_LOG:kv};const calls:any[]=[];
 const r=await placeBitgetLiveOrder(env,orderBody({bitgetMarket:"usdt-futures",side:"sell",quantity:0.02,leverage:25,marginMode:"isolated",marginCoin:"USDT",referencePrice:65000}),{now:()=>1700000000000,fetchImpl:(async(url:any,init:any)=>{calls.push({url,body:init.body?JSON.parse(init.body):null});return String(url).includes("/mix/account/account?")?new Response(JSON.stringify({code:"00000",data:{marginMode:"isolated"}})):ok();}) as any});
 assert.equal(r.status,201);assert.equal(calls.length,3);
 assert.match(calls[0].url,/mix\/account\/account\?/);assert.equal(calls[0].body,null);
 assert.match(calls[1].url,/set-leverage$/);assert.equal(calls[1].body.leverage,"25");
 assert.match(calls[2].url,/mix\/order\/place-order$/);assert.equal(calls[2].body.productType,"usdt-futures");assert.equal(calls[2].body.marginMode,"isolated");assert.equal(calls[2].body.side,"sell");
});

test("Bitget isolated hedge-mode futures sets equal long and short leverage without changing margin mode",async()=>{
 const kv=store(),env={...baseEnv,ETI_EXECUTION_LOG:kv};const calls:any[]=[];
 const r=await placeBitgetLiveOrder(env,orderBody({bitgetMarket:"usdt-futures",quantity:0.01,leverage:40,marginMode:"isolated",referencePrice:60000}),{now:()=>1700000000000,fetchImpl:(async(url:any,init:any)=>{calls.push({url,body:init.body?JSON.parse(init.body):null});return String(url).includes("/mix/account/account?")?new Response(JSON.stringify({code:"00000",data:{marginMode:"isolated",posMode:"hedge_mode"}})):ok();}) as any});
 assert.equal(r.status,201);assert.equal(calls.length,3);
 assert.equal(calls[1].body.longLeverage,"40");assert.equal(calls[1].body.shortLeverage,"40");assert.equal(calls[1].body.leverage,undefined);
});

test("Bitget cross and isolated margin orders use the correct classic V2 endpoint and size units",async()=>{
 for(const market of ["margin-crossed","margin-isolated"]){
  const kv=store(),env={...baseEnv,ETI_EXECUTION_LOG:kv};let seen:any;
  const r=await placeBitgetLiveOrder(env,orderBody({bitgetMarket:market,side:"buy",quoteAmount:45}),{now:()=>1700000000000,fetchImpl:(async(url:any,init:any)=>{seen={url,body:JSON.parse(init.body)};return ok();}) as any});
  assert.equal(r.status,201);assert.ok(seen.url.includes(market==="margin-crossed"?"/margin/crossed/place-order":"/margin/isolated/place-order"));
  assert.equal(seen.body.quoteSize,"45");assert.equal(seen.body.loanType,"normal");
 }
});

test("kill switch, missing explicit confirmation, leverage limits and duplicate ids fail closed",async()=>{
 const kv=store(),env={...baseEnv,ETI_EXECUTION_LOG:kv};
 assert.equal((await placeBitgetLiveOrder({...env,ETI_KILL_SWITCH:"true"},orderBody())).status,423);
 assert.equal((await placeBitgetLiveOrder(env,orderBody({riskConfirmed:false}))).status,400);
 assert.equal((await placeBitgetLiveOrder(env,orderBody({bitgetMarket:"usdt-futures",leverage:151}))).status,400);
 await placeBitgetLiveOrder(env,orderBody(),{fetchImpl:(async()=>ok()) as any});
 assert.equal((await placeBitgetLiveOrder(env,orderBody(),{fetchImpl:(async()=>ok()) as any})).status,409);
});

test("network uncertainty retains the client order id reservation and never retries implicitly",async()=>{
 const kv=store(),env={...baseEnv,ETI_EXECUTION_LOG:kv};
 const r=await placeBitgetLiveOrder(env,orderBody(),{fetchImpl:(async()=>{throw new Error("socket closed");}) as any});
 assert.equal(r.status,502);assert.equal((await r.json() as any).outcome,"unknown");
 assert.equal(kv.m.get("exec:live:id:eti1234567890abcdef"),"unknown");
});
