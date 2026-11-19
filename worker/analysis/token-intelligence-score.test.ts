import test from "node:test";
import assert from "node:assert/strict";
import { scoreTokenCandidate } from "./token-intelligence.ts";
test("token intelligence score rewards deeper liquidity and coherent activity",()=>{
 const strong=scoreTokenCandidate({priceUsd:1,liquidityUsd:500000,volume24hUsd:200000,change24hPct:5,fdvUsd:5000000,marketCapUsd:4000000,pairCreatedAt:Date.now()-120*86400000});
 const weak=scoreTokenCandidate({priceUsd:0.001,liquidityUsd:1500,volume24hUsd:20000,change24hPct:60,fdvUsd:50000000,marketCapUsd:1000000,pairCreatedAt:Date.now()-86400000});
 assert.ok(strong.score>weak.score);
 assert.ok(strong.score>=0&&strong.score<=100);
 assert.ok(["A","B","C","D","E"].includes(strong.grade));
 assert.ok(strong.riskFlags.every(x=>typeof x==="string"));
});
test("token score reports missing data and limits confidence",()=>{
 const missing=scoreTokenCandidate({symbol:"UNKNOWN"});
 assert.ok(missing.riskFlags.length>0);
 assert.ok(missing.confidencePct<=45);
 assert.equal(missing.metrics.liquidityUsd,0);
});
test("extreme movement raises risk flag",()=>{
 const score=scoreTokenCandidate({priceUsd:2,liquidityUsd:300000,volume24hUsd:150000,change24hPct:50,fdvUsd:1000000,marketCapUsd:800000,pairCreatedAt:Date.now()-40*86400000});
 assert.ok(score.riskFlags.some(x=>x.includes("Extreme 24-hour")));
});
