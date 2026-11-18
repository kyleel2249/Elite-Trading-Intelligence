import test from "node:test";
import assert from "node:assert/strict";
import { parseSignal, evaluateConsensus, independentMarketAssessment } from "./engine.ts";
import { handleGainz } from "./api.ts";
test("normalises V2 and Alpha payloads and validates direction-aware levels",()=>{
 const v2=parseSignal({engine:"GainzAlgo V2",symbol:"BTCUSDT",direction:"BUY",timeframe:"5m",timestamp:Date.now(),entry:100,sl:98,tp1:104});
 assert.ok(v2);assert.equal(v2.engine,"gainz_v2");assert.equal(v2.state,"validated");assert.equal(v2.rewardRisk,2);
 const alpha=parseSignal({engine:"GainzAlgo V2 Alpha",symbol:"ETHUSDT",direction:"SELL",timeframe:"15m",timestamp:Date.now(),entry:100,sl:102,tp1:96});
 assert.ok(alpha);assert.equal(alpha.engine,"gainz_v2_alpha");assert.equal(alpha.state,"validated");
});
test("rejects malformed and incorrectly oriented stop/target levels",()=>{
 assert.equal(parseSignal({engine:"v2",symbol:"BTCUSDT",direction:"BUY",timeframe:"5m",entry:100,sl:101,tp1:99}),null);
 const bad=parseSignal({engine:"v2",symbol:"BTCUSDT",direction:"BUY",timeframe:"5m",timestamp:Date.now(),entry:100,sl:101,tp1:105});
 assert.equal(bad?.state,"rejected");
});
test("consensus distinguishes agreement, conflict and independent signals",()=>{
 const s=parseSignal({engine:"v2",symbol:"BTCUSDT",direction:"BUY",timeframe:"5m",timestamp:Date.now(),entry:100,sl:98,tp1:104})!;
 assert.equal(evaluateConsensus(s,{engine:"gainz_v2_alpha",direction:"BUY",signal_timestamp:s.signalTimestamp}).consensus,"agreement");
 assert.equal(evaluateConsensus(s,{engine:"gainz_v2_alpha",direction:"SELL",signal_timestamp:s.signalTimestamp}).consensus,"conflict");
 assert.equal(evaluateConsensus(s,null).consensus,"single_engine");
});
test("independent market assessment does not fabricate a signal with insufficient candles",()=>{
 assert.equal(independentMarketAssessment([]).action,"WAIT");
});

test("Gainz webhook reports missing D1 binding instead of throwing before database initialization", async () => {
 const raw=JSON.stringify({engine:"GainzAlgo V2",symbol:"BTCUSDT",direction:"BUY",timeframe:"5m",timestamp:Date.now(),entry:100,sl:98,tp1:104});
 const timestamp=String(Date.now());
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("test-secret"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const mac=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(timestamp+"."+raw)));
 const signature="sha256="+[...mac].map(x=>x.toString(16).padStart(2,"0")).join("");
 const response=await handleGainz(new Request("https://eti.test/api/gainz/webhook",{method:"POST",headers:{"content-type":"application/json","x-eti-gainz-timestamp":timestamp,"x-eti-gainz-signature":signature},body:raw}),{ETI_GAINZ_WEBHOOK_SECRET:"test-secret"} as any);
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:"database_not_configured"});
});
