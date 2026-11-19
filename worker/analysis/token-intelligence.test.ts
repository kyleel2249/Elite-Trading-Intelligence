import test from "node:test";
import assert from "node:assert/strict";
import { searchTokens, scanTokenActivity, validTokenAddress } from "./token-intelligence.ts";

test("token address validation is chain-specific",()=>{
 assert.equal(validTokenAddress("ethereum","0x"+"a".repeat(40)),true);
 assert.equal(validTokenAddress("ethereum","So11111111111111111111111111111111111111112"),false);
 assert.equal(validTokenAddress("solana","So11111111111111111111111111111111111111112"),true);
});
test("token search normalizes and sorts candidate pairs by liquidity",async()=>{
 const fake=async()=>new Response(JSON.stringify({pairs:[
  {chainId:"base",baseToken:{address:"0x"+"1".repeat(40),name:"Token One",symbol:"ONE"},pairAddress:"pair-low",liquidity:{usd:500},volume:{h24:30},priceChange:{h24:-5},priceUsd:"0.1"},
  {chainId:"ethereum",baseToken:{address:"0x"+"2".repeat(40),name:"Token Two",symbol:"TWO"},pairAddress:"pair-high",liquidity:{usd:25000},volume:{h24:5000},priceChange:{h24:8},priceUsd:"2.5"}
 ]}),{status:200,headers:{"content-type":"application/json"});
 const result=await searchTokens(" test ",fake);
 assert.equal(result.query,"test");
 assert.equal(result.candidates.length,2);
 assert.equal(result.candidates[0].symbol,"TWO");
 assert.equal(result.candidates[0].liquidityUsd,25000);
});
test("EVM token scan maps transfer rows to contract-specific events",async()=>{
 const fake=async(url)=>new Response(JSON.stringify({items:[{transaction_hash:"0xabc",timestamp:"2026-11-19T10:00:00Z",from:{hash:"0x"+"3".repeat(40)},to:{hash:"0x"+"4".repeat(40)},total:{value:"1000000"},token:{symbol:"TST",decimals:"6"}}]}),{status:200,headers:{"content-type":"application/json"}});
 const address="0x"+"a".repeat(40),scan=await scanTokenActivity("base",address,fake);
 assert.equal(scan.count,1);assert.equal(scan.events[0].amount,1);assert.equal(scan.events[0].tokenSymbol,"TST");assert.equal(scan.events[0].kind,"token_transfer");
});
test("scanner rejects malformed token contract addresses before network call",async()=>{
 let called=false;const fake=async()=>{called=true;return new Response("{}");};
 await assert.rejects(()=>scanTokenActivity("base","bad",fake),/invalid_token_address/);
 assert.equal(called,false);
});
