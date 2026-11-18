import test from "node:test";
import assert from "node:assert/strict";
import { handleLiquidity } from "./api.ts";
const req=(method:string,body?:unknown)=>new Request("https://eti.test/api/liquidity/analyze",{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
const book={bids:[[99,2]],asks:[[101,2]]};
test("liquidity endpoint requires POST and a valid book",async()=>{
 assert.equal((await handleLiquidity(req("GET"))).status,405);
 assert.equal((await handleLiquidity(req("POST",{symbol:"BTCUSDT"}))).status,400);
 const ok=await handleLiquidity(req("POST",{symbol:"BTCUSDT",venue:"bybit",market:"spot",depth:book}));
 assert.equal(ok.status,200);const data=await ok.json() as any;assert.equal(data.confluence.direction,"WAIT");
});
test("liquidity endpoint rejects oversized depth and malformed history",async()=>{
 const large={bids:Array.from({length:201},()=>[99,1]),asks:[[101,1]]};
 assert.equal((await handleLiquidity(req("POST",{symbol:"BTCUSDT",depth:large}))).status,413);
 assert.equal((await handleLiquidity(req("POST",{symbol:"BTCUSDT",depth:book,history:[{bids:[],asks:"invalid"}]}))).status,400);
});
