import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSecurity, scoreAotiCandidate, sizeAotiPosition, manageAotiPosition, scanAotiPairs, isAotiSessionOpen } from "./engine.ts";
const now=1_800_000_000_000;
const secure={holderCount:500,mintAuthorityRevoked:true,freezeAuthorityRevoked:true,lpLocked:true,lpLockDays:45,developerSupplyPct:2,top10SupplyPct:30,sellSimulationPassed:true,bundledLaunchClear:true,provider:"test",checkedAt:now,risks:[]};
const base={id:"solana:mint:pair",chain:"solana" as const,address:"mint",pairAddress:"pair",dexId:"raydium",name:"Example",symbol:"EX",url:null,priceUsd:1,liquidityUsd:80000,volume5mUsd:30000,volume1hUsd:50000,buys5m:80,sells5m:20,pairCreatedAt:now-60_000,ageMinutes:1,holderGrowthPct:null,smartWalletBuys:null,kolBuyVerified:null,security:secure,profile:{poc:1,vah:1.1,val:.9,method:"ohlcv_approximation",location:"inside_value"},source:"dexscreener" as const,observedAt:now};
test("unknown or stale token security evidence never passes",()=>{
 const pending=evaluateSecurity({...secure,sellSimulationPassed:null},now);
 assert.equal(pending.status,"PENDING");
 const stale=evaluateSecurity({...secure,checkedAt:now-6*60_000},now);
 assert.equal(stale.status,"PENDING");
 const failed=evaluateSecurity({...secure,lpLocked:false},now);
 assert.equal(failed.status,"FAIL");
});
test("opportunity eligibility requires all independent security gates and market thresholds",()=>{
 const good=scoreAotiCandidate(base,now);
 assert.equal(good.securityGate,"PASS");
 assert.equal(good.eligible,true);
 const pending=scoreAotiCandidate({...base,security:{...secure,bundledLaunchClear:null}},now);
 assert.equal(pending.securityGate,"PENDING");
 assert.equal(pending.eligible,false);
 const thin=scoreAotiCandidate({...base,liquidityUsd:12000},now);
 assert.equal(thin.eligible,false);
});
test("position sizing caps risk, liquidity exposure, open slots and drawdown",()=>{
 const normal=sizeAotiPosition({equity:70,peakEquity:70,openPositions:0,consecutiveLosses:0,liquidityUsd:80000});
 assert.equal(normal.allowed,true);
 assert.ok(normal.riskPct<=1);
 assert.ok(normal.notionalUsd<=14);
 const losses=sizeAotiPosition({equity:70,peakEquity:70,openPositions:0,consecutiveLosses:2,liquidityUsd:80000});
 assert.equal(losses.riskPct,.5);
 const halted=sizeAotiPosition({equity:55,peakEquity:70,openPositions:0,consecutiveLosses:0,liquidityUsd:80000});
 assert.equal(halted.allowed,false);
 assert.equal(halted.mode,"suspended");
});
test("paper position manager applies hard stop, staged targets and time stop",()=>{
 const p={id:"p",candidateId:"c",chain:"solana" as const,address:"mint",symbol:"EX",entryPrice:1,quantity:10,notionalUsd:10,openedAt:now,remainingPct:100,realizedPnlUsd:0,status:"open" as const,lastPrice:1};
 assert.equal(manageAotiPosition(p,.87,now).action,"STOP_LOSS");
 assert.equal(manageAotiPosition(p,2,now).action,"TAKE_PROFIT_2X");
 assert.equal(manageAotiPosition(p,1,now+26*60_000).action,"TIME_STOP");
});
test("scanner applies pair age, liquidity and volume gates and retains security uncertainty",async()=>{
 const fake=async(url:string|URL)=>{const u=String(url);
  if(u.includes("token-profiles/latest"))return new Response(JSON.stringify([{chainId:"solana",tokenAddress:"Mint111111111111111111111111111111111111"}]),{status:200});
  if(u.includes("/latest/dex/tokens/"))return new Response(JSON.stringify({pairs:[{chainId:"solana",baseToken:{address:"Mint111111111111111111111111111111111111",name:"Example",symbol:"EX"},pairAddress:"Pair111111111111111111111111111111111111",dexId:"raydium",url:"https://dexscreener.com/solana/pair",priceUsd:"1",liquidity:{usd:90000},volume:{m5:35000,h1:60000},txns:{m5:{buys:90,sells:10}},pairCreatedAt:now-120000}]}),{status:200});
  if(u.includes("rugcheck"))return new Response(JSON.stringify({totalHolders:500,mintAuthority:null,freezeAuthority:null,creatorPercentage:2,topHolders:Array.from({length:10},()=>({pct:2})),markets:[{lp:{lpLocked:true,lockDuration:4000000}}],risks:[]}),{status:200});
  if(u.includes("geckoterminal"))return new Response(JSON.stringify({data:{attributes:{ohlcv_list:[[now/1000,1,1.1,.9,1.02,100],[now/1000-300,1,1.05,.95,1.01,120]]}}}),{status:200});
  return new Response("{}",{status:404});
 };
 const result=await scanAotiPairs(fake as typeof fetch,now,4);
 assert.equal(result.count,1);
 assert.equal(result.candidates[0].securityGate,"PENDING");
 assert.equal(result.candidates[0].eligible,false);
 assert.equal(result.candidates[0].profile?.method,"ohlcv_approximation");
 assert.equal(result.liveExecutionAllowed,false);
});

test("overnight paper-entry session handles UTC midnight correctly",()=>{
 const at=(h:number,m:number)=>Date.UTC(2026,0,1,h,m);
 assert.equal(isAotiSessionOpen(at(23,0)),true);
 assert.equal(isAotiSessionOpen(at(6,59)),true);
 assert.equal(isAotiSessionOpen(at(7,0)),false);
 assert.equal(isAotiSessionOpen(at(22,59)),false);
});
