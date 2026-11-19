/**
 * ETI Autonomous On-Chain Trading Intelligence (AOTI).
 * Discovery and risk decisions are deterministic. Unknown security evidence fails closed.
 * This module never signs a transaction or submits a live DEX swap.
 */
import { buildAdvancedVolumeProfile } from "../analysis/advanced-volume-profile.ts";

export const AOTI_CHAINS = ["solana","ethereum","base","bsc","arbitrum","polygon","optimism"] as const;
export type AotiChain = typeof AOTI_CHAINS[number];
export type GateState = "pass" | "fail" | "unknown";
export interface SecurityEvidence {
  holderCount: number | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  lpLocked: boolean | null;
  lpLockDays: number | null;
  developerSupplyPct: number | null;
  top10SupplyPct: number | null;
  sellSimulationPassed: boolean | null;
  bundledLaunchClear: boolean | null;
  provider: string;
  checkedAt: number;
  risks: string[];
}
export interface AotiCandidate {
  id: string; chain: AotiChain; address: string; pairAddress: string; dexId: string;
  name: string; symbol: string; url: string | null; priceUsd: number; liquidityUsd: number;
  volume5mUsd: number; volume1hUsd: number; buys5m: number; sells5m: number;
  pairCreatedAt: number; ageMinutes: number; holderGrowthPct: number | null;
  smartWalletBuys: number | null; kolBuyVerified: boolean | null;
  security: SecurityEvidence; securityGate: "PASS" | "FAIL" | "PENDING";
  signals: string[]; score: number; eligible: boolean; reasons: string[];
  profile?: { poc: number | null; vah: number | null; val: number | null; method: string; location: string | null };
  source: "dexscreener"; observedAt: number;
}
export interface AotiRiskInput { equity: number; peakEquity: number; openPositions: number; consecutiveLosses: number; requestedRiskPct?: number; liquidityUsd: number; stopPct?: number }
export interface AotiRiskDecision { allowed: boolean; riskPct: number; riskUsd: number; notionalUsd: number; allocationPct: number; maxOpenPositions: number; drawdownPct: number; mode: string; reasons: string[] }
const n=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const pct=(v:number)=>Number(v.toFixed(4));
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
const asBool=(v:unknown):boolean|null=>v===true||v===1||v==="1"||v==="true"?true:v===false||v===0||v==="0"||v==="false"?false:null;
const clean=(v:unknown,max=100)=>String(v??"").replace(/[<>]/g,"").trim().slice(0,max);
const CHAIN_MAP:Record<string,AotiChain>={solana:"solana",ethereum:"ethereum",eth:"ethereum",base:"base",bsc:"bsc",binance:"bsc",arbitrum:"arbitrum",polygon:"polygon",polygon_pos:"polygon",optimism:"optimism"};
const GOPLUS:Record<Exclude<AotiChain,"solana">,string>={ethereum:"1",base:"8453",bsc:"56",arbitrum:"42161",polygon:"137",optimism:"10"};
const json=async(fetcher:typeof fetch,url:string,init?:RequestInit)=>{const r=await fetcher(url,{...init,headers:{accept:"application/json",...(init?.headers||{})},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error("provider_http_"+r.status);return r.json() as Promise<any>};

export function evaluateSecurity(e:SecurityEvidence,now=Date.now()):{status:"PASS"|"FAIL"|"PENDING";failed:string[];unknown:string[];checkedAt:number;provider:string}{
  const age=now-e.checkedAt, fields:[string,unknown][]=[
    ["holder_count",e.holderCount!==null&&e.holderCount>=300],
    ["mint_authority",e.mintAuthorityRevoked],["freeze_authority",e.freezeAuthorityRevoked],
    ["lp_lock",e.lpLocked===true&&Number(e.lpLockDays)>=30],
    ["developer_supply",e.developerSupplyPct!==null&&e.developerSupplyPct<5],
    ["top10_supply",e.top10SupplyPct!==null&&e.top10SupplyPct<35],
    ["sell_simulation",e.sellSimulationPassed],["bundled_launch",e.bundledLaunchClear]
  ];
  const stale=!(age>=0&&age<=5*60_000), failed=fields.filter(([,v])=>v===false).map(([k])=>k), unknown=fields.filter(([,v])=>v===null||v===undefined).map(([k])=>k);
  if(stale)unknown.push("stale_security_report");
  return {status:failed.length?"FAIL":unknown.length?"PENDING":"PASS",failed,unknown,checkedAt:e.checkedAt,provider:e.provider};
}
export function scoreAotiCandidate(input:Omit<AotiCandidate,"score"|"eligible"|"reasons"|"securityGate"|"signals"> & {profile?:AotiCandidate["profile"]},now=Date.now()){
  const signals:string[]=[],reasons:string[]=[];let score=0;
  const burst=input.volume1hUsd>0?input.volume5mUsd/(input.volume1hUsd/12):0;
  const buyRatio=input.buys5m+input.sells5m>0?input.buys5m/(input.buys5m+input.sells5m):0;
  if(input.liquidityUsd>=40000){score+=20;signals.push("liquidity_threshold_pass")}else reasons.push("liquidity_below_40k");
  if(input.volume5mUsd>=25000){score+=15;signals.push("five_minute_volume_pass")}else reasons.push("five_minute_volume_below_25k");
  if(input.ageMinutes<=360&&input.ageMinutes>=0){score+=10;signals.push("new_pair_under_6h")}else reasons.push("pair_age_outside_6h");
  if(burst>=5){score+=15;signals.push("volume_burst_over_5x")}else reasons.push("volume_burst_unconfirmed");
  if(buyRatio>=.70){score+=15;signals.push("buy_pressure_over_70pct")}else reasons.push("buy_pressure_below_70pct");
  if(input.holderGrowthPct!==null&&input.holderGrowthPct>0){score+=5;signals.push("holder_growth_positive")}else reasons.push("holder_growth_unavailable_or_negative");
  if(input.smartWalletBuys!==null&&input.smartWalletBuys>=3){score+=10;signals.push("smart_wallet_cluster_buying")}else reasons.push("smart_wallet_evidence_missing");
  if(input.kolBuyVerified===true){score+=5;signals.push("verified_kol_buy")}else reasons.push("verified_kol_buy_missing");
  if(input.profile?.poc&&input.profile.method==="transaction_level"){score+=5;signals.push("transaction_level_poc_available")}
  else if(input.profile?.poc){score+=2;signals.push("ohlcv_poc_approximation")}
  const security=evaluateSecurity(input.security,now),securityGate=security.status;
  if(securityGate!=="PASS")reasons.push("security_gate_"+securityGate.toLowerCase()+":"+[...security.failed,...security.unknown].join(","));
  const baseEligible=input.liquidityUsd>=40000&&input.volume5mUsd>=25000&&input.ageMinutes<=360&&input.ageMinutes>=0;
  if(!baseEligible)reasons.push("minimum_market_criteria_not_met");
  return {...input,score,signals,reasons,securityGate,eligible:baseEligible&&securityGate==="PASS"&&score>=75,observedAt:now};
}

export function sizeAotiPosition(i:AotiRiskInput):AotiRiskDecision{
  const equity=Math.max(0,i.equity),peak=Math.max(equity,i.peakEquity),dd=peak>0?(peak-equity)/peak*100:100;
  const reasons:string[]=[];let mode="normal",riskPct=clamp(i.requestedRiskPct??1,0.25,2),maxOpenPositions=2;
  if(dd>=20){mode="suspended";reasons.push("drawdown_at_or_above_20_percent");}
  else if(dd>=15){mode="defensive";riskPct=Math.min(riskPct,.25);maxOpenPositions=1;reasons.push("drawdown_at_or_above_15_percent");}
  else if(dd>=10){mode="restricted";riskPct=Math.min(riskPct,.5);maxOpenPositions=1;reasons.push("drawdown_at_or_above_10_percent");}
  else if(dd>=5){mode="reduced";riskPct=Math.min(riskPct,.75);reasons.push("drawdown_at_or_above_5_percent");}
  if(i.consecutiveLosses>=2){riskPct=Math.min(riskPct,.5);reasons.push("two_consecutive_losses_risk_halved");}
  if(i.openPositions>=maxOpenPositions)reasons.push("max_open_positions_reached");
  if(i.liquidityUsd<40000)reasons.push("insufficient_pool_liquidity");
  const riskUsd=equity*riskPct/100,stopPct=clamp(i.stopPct??12,3,20),riskNotional=stopPct>0?riskUsd/(stopPct/100):0;
  const liquidityCap=i.liquidityUsd*.005,allocationCap=equity*.2,notionalUsd=Math.max(0,Math.min(riskNotional,liquidityCap,allocationCap));
  if(notionalUsd<5)reasons.push("position_below_minimum_5_usd");
  if(equity<=0)reasons.push("equity_unavailable");
  const allowed=equity>0&&dd<20&&i.openPositions<maxOpenPositions&&i.liquidityUsd>=40000&&notionalUsd>=5;
  return {allowed,riskPct:pct(riskPct),riskUsd:pct(riskUsd),notionalUsd:pct(notionalUsd),allocationPct:equity?pct(notionalUsd/equity*100):0,maxOpenPositions,drawdownPct:pct(dd),mode,reasons};
}
export interface AotiPosition {id:string;candidateId:string;chain:AotiChain;address:string;symbol:string;entryPrice:number;quantity:number;notionalUsd:number;openedAt:number;remainingPct:number;realizedPnlUsd:number;status:"open"|"closed";lastPrice:number}
export function manageAotiPosition(p:AotiPosition,price:number,now=Date.now(),securityIncident=false){
  if(!(price>0)||!(p.entryPrice>0))return {action:"HOLD" as const,reason:"invalid_price",closePct:0,unrealizedPnlUsd:0};
  const change=(price-p.entryPrice)/p.entryPrice,age=now-p.openedAt;
  let action:"HOLD"|"STOP_LOSS"|"TAKE_PROFIT_2X"|"TAKE_PROFIT_4X"|"TRAILING_STOP"|"TIME_STOP"|"SECURITY_EXIT"="HOLD",closePct=0,reason="position_within_plan";
  if(securityIncident){action="SECURITY_EXIT";closePct=100;reason="security_or_liquidity_emergency";}
  else if(change<=-.12){action="STOP_LOSS";closePct=100;reason="hard_stop_12pct";}
  else if(change>=3.0&&p.remainingPct>0){action="TAKE_PROFIT_4X";closePct=Math.min(30,p.remainingPct);reason="four_x_target";}
  else if(change>=1.0&&p.remainingPct>0){action="TAKE_PROFIT_2X";closePct=Math.min(40,p.remainingPct);reason="two_x_target";}
  else if(age>=25*60_000){action="TIME_STOP";closePct=100;reason="time_stop_25_minutes";}
  const unrealizedPnlUsd=p.notionalUsd*change*p.remainingPct/100;
  return {action,reason,closePct,unrealizedPnlUsd:pct(unrealizedPnlUsd),priceChangePct:pct(change*100),ageMs:age};
}
async function securityFor(chain:AotiChain,address:string,fetcher:typeof fetch,now:number):Promise<SecurityEvidence>{
  const empty=(provider:string):SecurityEvidence=>({holderCount:null,mintAuthorityRevoked:null,freezeAuthorityRevoked:null,lpLocked:null,lpLockDays:null,developerSupplyPct:null,top10SupplyPct:null,sellSimulationPassed:null,bundledLaunchClear:null,provider,checkedAt:now,risks:[]});
  try{
    if(chain==="solana"){
      const r=await json(fetcher,"https://api.rugcheck.xyz/v1/tokens/"+encodeURIComponent(address)+"/report");
      const risks=Array.isArray(r.risks)?r.risks.map((x:any)=>clean(x.name||x.description,120)):[],markets=Array.isArray(r.markets)?r.markets:[];
      const top=Array.isArray(r.topHolders)?r.topHolders:[],top10=top.slice(0,10).reduce((s:number,x:any)=>s+Number(x.pct??x.percentage??0),0);
      const lp=markets.flatMap((m:any)=>m.lp?.lpLocked===true?[m.lp]:[]),lpDays=lp.length?Math.max(...lp.map((x:any)=>Number(x.lockDuration||0)/86400)):null;
      const authority=(v:any)=>v===null||v===""?true:v===undefined?null:false;
      return {holderCount:n(r.totalHolders),mintAuthorityRevoked:authority(r.mintAuthority),freezeAuthorityRevoked:authority(r.freezeAuthority),lpLocked:markets.length?lp.length>0:null,lpLockDays:lpDays,developerSupplyPct:n(r.creatorPercentage),top10SupplyPct:top.length?top10:null,sellSimulationPassed:null,bundledLaunchClear:risks.some((x:string)=>/bundle|insider/i.test(x))?false:null,provider:"rugcheck",checkedAt:now,risks};
    }
    const chainId=GOPLUS[chain as Exclude<AotiChain,"solana">],r=await json(fetcher,"https://api.gopluslabs.io/api/v1/token_security/"+chainId+"?contract_addresses="+encodeURIComponent(address)),item=r.result?.[address.toLowerCase()]||r.result?.[address];
    if(!item)return empty("goplus");
    const holders=n(item.holder_count),top10=n(item.owner_percent),dev=n(item.creator_percent);
    const lpRows=Array.isArray(item.lp_holders)?item.lp_holders:[],locked=lpRows.some((x:any)=>Number(x.is_locked)===1);
    const lockDays=locked?Math.max(...lpRows.filter((x:any)=>Number(x.is_locked)===1).map((x:any)=>Number(x.locked_detail?.[0]?.end_time||0)>now/1000?(Number(x.locked_detail[0].end_time)-now/1000)/86400:0)):null;
    const honeypot=asBool(item.is_honeypot),buyTax=n(item.buy_tax),sellTax=n(item.sell_tax);
    return {holderCount:holders,mintAuthorityRevoked:asBool(item.is_mintable)===null?null:asBool(item.is_mintable)===false,freezeAuthorityRevoked:asBool(item.transfer_pausable)===null?null:asBool(item.transfer_pausable)===false,lpLocked:lpRows.length?locked:null,lpLockDays:lockDays,developerSupplyPct:dev===null?null:dev*100,top10SupplyPct:top10===null?null:top10*100,sellSimulationPassed:honeypot===false&&sellTax!==null&&sellTax<.1,bundledLaunchClear:null,provider:"goplus",checkedAt:now,risks:[...(honeypot===true?["honeypot"]:[]),...(asBool(item.is_mintable)===true?["mintable"]:[]),...(asBool(item.transfer_pausable)===true?["transfer_pausable"]:[])]};
  }catch{return empty(chain==="solana"?"rugcheck_unavailable":"goplus_unavailable")}
}
function normalizePair(p:any,now:number):Omit<AotiCandidate,"score"|"eligible"|"reasons"|"securityGate"|"signals">|null{
  const chain=CHAIN_MAP[String(p.chainId||"").toLowerCase()],address=clean(p.baseToken?.address,120),pairAddress=clean(p.pairAddress,120),priceUsd=Number(p.priceUsd),liquidityUsd=Number(p.liquidity?.usd),volume5mUsd=Number(p.volume?.m5),volume1hUsd=Number(p.volume?.h1),created=Number(p.pairCreatedAt);
  if(!chain||!address||!pairAddress||!(priceUsd>0)||!(created>0))return null;
  const ageMinutes=(now-created)/60000,buys5m=Number(p.txns?.m5?.buys||0),sells5m=Number(p.txns?.m5?.sells||0);
  return {id:chain+":"+address.toLowerCase()+":"+pairAddress.toLowerCase(),chain,address,pairAddress,dexId:clean(p.dexId,80),name:clean(p.baseToken?.name,100),symbol:clean(p.baseToken?.symbol,24),url:typeof p.url==="string"?p.url:null,priceUsd,liquidityUsd:Number.isFinite(liquidityUsd)?liquidityUsd:0,volume5mUsd:Number.isFinite(volume5mUsd)?volume5mUsd:0,volume1hUsd:Number.isFinite(volume1hUsd)?volume1hUsd:0,buys5m,sells5m,pairCreatedAt:created,ageMinutes,holderGrowthPct:null,smartWalletBuys:null,kolBuyVerified:null,security:{holderCount:null,mintAuthorityRevoked:null,freezeAuthorityRevoked:null,lpLocked:null,lpLockDays:null,developerSupplyPct:null,top10SupplyPct:null,sellSimulationPassed:null,bundledLaunchClear:null,provider:"not_checked",checkedAt:0,risks:[]},profile:undefined,source:"dexscreener",observedAt:now};
}
const GEO:Record<AotiChain,string>={solana:"solana",ethereum:"eth",base:"base",bsc:"bsc",arbitrum:"arbitrum",polygon:"polygon_pos",optimism:"optimism"};
async function loadPairProfile(chain:AotiChain,pairAddress:string,symbol:string,price:number,fetcher:typeof fetch){
  const network=GEO[chain],url="https://api.geckoterminal.com/api/v2/networks/"+network+"/pools/"+encodeURIComponent(pairAddress)+"/ohlcv/minute?aggregate=5&limit=120";
  const data=await json(fetcher,url),rows=data?.data?.attributes?.ohlcv_list;
  if(!Array.isArray(rows)||!rows.length)return undefined;
  const candles=rows.map((r:any)=>[Number(r[0])*1000,Number(r[1]),Number(r[2]),Number(r[3]),Number(r[4]),Number(r[5])]).filter((r:number[])=>r.every(Number.isFinite));
  const result=buildAdvancedVolumeProfile({symbol,candles:candles as any,currentPrice:price,bins:64});
  if(result.status!=="ok")return undefined;
  return {poc:result.poc,vah:result.vah,val:result.val,method:result.sourceCoverage.method,location:result.location};
}
export async function scanAotiPairs(fetcher:typeof fetch=fetch,now=Date.now(),limit=12){
  const profile=await json(fetcher,"https://api.dexscreener.com/token-profiles/latest/v1").catch(()=>[]);
  const tokens=(Array.isArray(profile)?profile:[]).filter((x:any)=>CHAIN_MAP[String(x.chainId||"").toLowerCase()]&&x.tokenAddress).slice(0,Math.max(1,Math.min(30,limit*2)));
  const addresses=[...new Map(tokens.map((x:any)=>[String(x.chainId)+":"+String(x.tokenAddress).toLowerCase(),x])).values()];
  const candidates:AotiCandidate[]=[];
  for(let i=0;i<addresses.length&&candidates.length<limit;i+=3){
    const group=addresses.slice(i,i+3);
    const results=await Promise.all(group.map(async(t:any)=>{
      const chain=CHAIN_MAP[String(t.chainId).toLowerCase()];try{
        const data=await json(fetcher,"https://api.dexscreener.com/latest/dex/tokens/"+encodeURIComponent(t.tokenAddress));
        return (Array.isArray(data.pairs)?data.pairs:[]).filter((p:any)=>CHAIN_MAP[String(p.chainId||"").toLowerCase()]===chain).map((p:any)=>normalizePair(p,now)).filter(Boolean) as ReturnType<typeof normalizePair>[];
      }catch{return []}
    }));
    for(const rows of results)for(const row of rows){if(!row||row.ageMinutes<0||row.ageMinutes>360||row.liquidityUsd<40000||row.volume5mUsd<25000)continue;
      const security=await securityFor(row.chain,row.address,fetcher,now);
      const profile=await loadPairProfile(row.chain,row.pairAddress,row.symbol,row.priceUsd,fetcher).catch(()=>undefined);
      const candidate=scoreAotiCandidate({...row,security,profile},now);
      candidates.push(candidate);
    }
  }
  return {schema:"eti.aoti.scan/1",observedAt:now,provider:"DexScreener + RugCheck/GoPlus",count:candidates.length,candidates:candidates.sort((a,b)=>b.score-a.score).slice(0,limit),coverage:{chains:AOTI_CHAINS,profileTokens:addresses.length,holders:"provider-dependent",smartWallets:"not connected unless an independently verified wallet feed is configured",kolBuys:"not inferred from mentions; verified trade feed required"},liveExecutionAllowed:false};
}
export interface AotiEnv {ETI_PORTFOLIO_DB?:any;ETI_AOTI_ENABLED?:string;ETI_AOTI_MAX_CANDIDATES?:string;ETI_AOTI_SESSION_START_UTC?:string;ETI_AOTI_SESSION_END_UTC?:string}
export function isAotiSessionOpen(now=Date.now(),start="23:00",end="07:00"){
  const parse=(v:string)=>{const m=/^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(v);return m?Number(m[1])*60+Number(m[2]):-1};
  const a=parse(start),b=parse(end);if(a<0||b<0)return false;if(a===b)return true;
  const d=new Date(now),minute=d.getUTCHours()*60+d.getUTCMinutes();
  return a<b?minute>=a&&minute<b:minute>=a||minute<b;
}
export async function ensureAotiSchema(db:any){
  await db.prepare(`CREATE TABLE IF NOT EXISTS eti_aoti_candidates(id TEXT PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,pair_address TEXT NOT NULL,symbol TEXT NOT NULL,score REAL NOT NULL,security_gate TEXT NOT NULL,eligible INTEGER NOT NULL,payload_json TEXT NOT NULL,observed_at INTEGER NOT NULL)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_aoti_candidates_observed ON eti_aoti_candidates(observed_at DESC,score DESC)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS eti_aoti_positions(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,symbol TEXT NOT NULL,status TEXT NOT NULL,entry_price REAL NOT NULL,last_price REAL NOT NULL,quantity REAL NOT NULL,notional_usd REAL NOT NULL,remaining_pct REAL NOT NULL,realized_pnl_usd REAL NOT NULL,opened_at INTEGER NOT NULL,closed_at INTEGER,payload_json TEXT NOT NULL)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_aoti_positions_status ON eti_aoti_positions(status,opened_at DESC)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS eti_aoti_events(id TEXT PRIMARY KEY,event_type TEXT NOT NULL,candidate_id TEXT,position_id TEXT,reason TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_aoti_events_created ON eti_aoti_events(created_at DESC)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS eti_aoti_state(k TEXT PRIMARY KEY,v TEXT NOT NULL,updated_at INTEGER NOT NULL)`).run();
}
export async function persistAotiScan(db:any,result:Awaited<ReturnType<typeof scanAotiPairs>>){
  await ensureAotiSchema(db);
  for(let c of result.candidates){
    const previous=await db.prepare("SELECT payload_json FROM eti_aoti_candidates WHERE id=?").bind(c.id).first().catch(()=>null);
    if(previous?.payload_json){try{const old=JSON.parse(previous.payload_json);if(old.security?.provider==="operator_attested"&&result.observedAt-Number(old.security.checkedAt)<=5*60_000){c=scoreAotiCandidate({...c,security:old.security},result.observedAt)}}catch{}}
    await db.prepare("INSERT OR REPLACE INTO eti_aoti_candidates(id,chain,address,pair_address,symbol,score,security_gate,eligible,payload_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(c.id,c.chain,c.address,c.pairAddress,c.symbol,c.score,c.securityGate,c.eligible?1:0,JSON.stringify(c),c.observedAt).run();
  }
  await db.prepare("INSERT INTO eti_aoti_events(id,event_type,reason,payload_json,created_at) VALUES(?,?,?,?,?)").bind("scan:"+result.observedAt,"SCAN","scheduled_market_scan",JSON.stringify({count:result.count,provider:result.provider}),result.observedAt).run().catch(()=>{});
}
export async function runAotiCycle(env:AotiEnv,now=Date.now(),fetcher:typeof fetch=fetch){
  if(env.ETI_AOTI_ENABLED!=="true"||!env.ETI_PORTFOLIO_DB)return {enabled:false,scanned:0,eligible:0,reason:"AOTI disabled or D1 binding unavailable"};
  const result=await scanAotiPairs(fetcher,now,Number(env.ETI_AOTI_MAX_CANDIDATES||12));
  await persistAotiScan(env.ETI_PORTFOLIO_DB,result);
  return {enabled:true,scanned:result.count,eligible:result.candidates.filter(c=>c.eligible).length,securityPending:result.candidates.filter(c=>c.securityGate==="PENDING").length,provider:result.provider};
}

/** Refreshes the two-slot paper book. A failed price/security refresh never creates a fictitious fill. */
export async function manageAotiPaperPositions(env:AotiEnv,now=Date.now(),fetcher:typeof fetch=fetch){
  const db=env.ETI_PORTFOLIO_DB;if(env.ETI_AOTI_ENABLED!=="true"||!db)return {checked:0,updated:0,closed:0,failures:0};
  await ensureAotiSchema(db);
  const rows=(await db.prepare("SELECT * FROM eti_aoti_positions WHERE status='open' ORDER BY opened_at LIMIT 2").all()).results||[];
  let updated=0,closed=0,failures=0;
  for(const row of rows){
    try{
      const p=JSON.parse(row.payload_json),chain=row.chain as AotiChain;
      const result=await json(fetcher,"https://api.dexscreener.com/latest/dex/pairs/"+encodeURIComponent(chain)+"/"+encodeURIComponent(p.pairAddress||""));
      const pair=(result.pairs||[]).find((x:any)=>String(x.pairAddress||"").toLowerCase()===String(p.pairAddress||"").toLowerCase())||(result.pairs||[])[0];
      const price=Number(pair?.priceUsd);if(!(price>0))throw new Error("live_pair_price_unavailable");
      const security=await securityFor(chain,row.address,fetcher,now);
      const gate=evaluateSecurity(security,now),liquidity=Number(pair?.liquidity?.usd||0),liquidityIncident=Number(p.initialLiquidityUsd||0)>0&&liquidity<Number(p.initialLiquidityUsd)*.6;
      const high=Math.max(Number(p.highWaterPrice||p.entryPrice),price),change=(price-Number(p.entryPrice))/Number(p.entryPrice),age=now-Number(p.openedAt);
      let closePct=0,reason="mark_to_market",eventType="PAPER_MARK";
      if(gate.status==="FAIL"||liquidityIncident){closePct=Number(row.remaining_pct);reason=liquidityIncident?"pool_liquidity_drop_over_40pct":"security_gate_failed_after_entry";eventType="PAPER_SECURITY_EXIT";}
      else if(change<=-.12){closePct=Number(row.remaining_pct);reason="hard_stop_12pct";eventType="PAPER_STOP";}
      else if(!p.takeProfit2xDone&&change>=1){closePct=Math.min(40,Number(row.remaining_pct));p.takeProfit2xDone=true;reason="take_profit_2x";eventType="PAPER_TP";}
      else if(p.takeProfit2xDone&&!p.takeProfit4xDone&&change>=3){closePct=Math.min(30,Number(row.remaining_pct));p.takeProfit4xDone=true;reason="take_profit_4x";eventType="PAPER_TP";}
      else if(p.takeProfit2xDone&&p.takeProfit4xDone&&price<=high*.75){closePct=Number(row.remaining_pct);reason="runner_trailing_stop_25pct";eventType="PAPER_TRAIL";}
      else if(age>=25*60_000){closePct=Number(row.remaining_pct);reason="time_stop_25_minutes";eventType="PAPER_TIME_EXIT";}
      const realized=Number(row.realized_pnl_usd)+Number(row.notional_usd)*change*closePct/100,remaining=Math.max(0,Number(row.remaining_pct)-closePct),status=remaining<=0.0001?"closed":"open";
      const next={...p,lastPrice:price,highWaterPrice:high,remainingPct:remaining,realizedPnlUsd:realized,status,securityGate:gate.status,lastSecurityCheck:now,lastLiquidityUsd:liquidity};
      await db.prepare("UPDATE eti_aoti_positions SET status=?,last_price=?,remaining_pct=?,realized_pnl_usd=?,closed_at=?,payload_json=? WHERE id=? AND status='open'").bind(status,price,remaining,realized,status==="closed"?now:null,JSON.stringify(next),row.id).run();
      if(closePct>0){
        const equity=Number(await (async()=>{const x=await db.prepare("SELECT v FROM eti_aoti_state WHERE k='equity_usd'").first();return x?.v??"70"})())+Number(row.notional_usd)*change*closePct/100;
        const peakRow=await db.prepare("SELECT v FROM eti_aoti_state WHERE k='peak_equity_usd'").first(),peak=Math.max(Number(peakRow?.v??"70"),equity);
        await db.prepare("INSERT INTO eti_aoti_state(k,v,updated_at) VALUES('equity_usd',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at").bind(String(equity),now).run();
        await db.prepare("INSERT INTO eti_aoti_state(k,v,updated_at) VALUES('peak_equity_usd',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at").bind(String(peak),now).run();
        if(status==="closed"){const loss=realized<0,old=await db.prepare("SELECT v FROM eti_aoti_state WHERE k='consecutive_losses'").first();const streak=loss?Number(old?.v||0)+1:0;await db.prepare("INSERT INTO eti_aoti_state(k,v,updated_at) VALUES('consecutive_losses',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at").bind(String(streak),now).run();}
        await db.prepare("INSERT OR IGNORE INTO eti_aoti_events(id,event_type,candidate_id,position_id,reason,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").bind("manage:"+row.id+":"+now,eventType,row.candidate_id,row.id,reason,JSON.stringify({price,closePct,realizedPnlUsd:realized,remainingPct:remaining,securityGate:gate.status,liquidityUsd:liquidity}),now).run();
      }
      updated++;if(status==="closed")closed++;
    }catch{failures++;}
  }
  return {checked:rows.length,updated,closed,failures};
}
