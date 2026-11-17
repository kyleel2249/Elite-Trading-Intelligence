import type { MarketEnv, Kline } from "../market.ts";
import { getMarketData, providerOrder } from "../market.ts";
import { authorized } from "../execution.ts";
import { EXECUTION_TF, TF_SECONDS, type Strategy, type Timeframe } from "./timeframes.ts";
import type { V3AlphaResult } from "./v3-alpha.ts";
import { backtestV3Alpha } from "./v3-alpha-backtest.ts";

type DB = { prepare(sql:string): any };
type Env = MarketEnv & { ETI_PORTFOLIO_DB?: DB };
const H = { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", "access-control-allow-origin":"*" };
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});
const validSymbol=(s:string)=>/^[A-Z0-9]{5,20}$/.test(s);
const strategies:Strategy[]=["scalp","intraday","swing","position"];
const tfFor=(s:Strategy)=>EXECUTION_TF[s];
const nowMs=()=>Date.now();

export async function recordV3AlphaSignal(db:DB|undefined, symbol:string, strategy:Strategy, venue:string, market:string, category:string, a:V3AlphaResult, now=nowMs()):Promise<boolean>{
 if(!db||a.status!=="SIGNAL"||!a.evaluatedCandleTime||!a.entryZone||a.stopLoss===null||!a.takeProfits)return false;
 const id=[symbol,strategy,a.evaluatedCandleTime].join(":");
 await db.prepare(`INSERT OR IGNORE INTO eti_v3_alpha_signals
 (id,symbol,strategy,venue,market,category,timeframe,direction,signal_time,received_at,entry_low,entry_high,entry,stop_loss,tp1,tp2,tp3,score,threshold,regime,payload_json)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .bind(id,symbol,strategy,venue,market,category,tfFor(strategy),a.direction,a.evaluatedCandleTime,now,a.entryZone[0],a.entryZone[1],(a.entryZone[0]+a.entryZone[1])/2,a.stopLoss,a.takeProfits[0].price,a.takeProfits[1].price,a.takeProfits[2].price,a.score,a.threshold,a.regime,JSON.stringify(a)).run();
 return true;
}

function outcomeFor(row:any, candles:Kline[]):{outcome:"win"|"loss"|"expired"|null; r:number|null; at:number|null; bars:number}{
 let seen=0;
 for(const c of candles){if(c[0]<=Number(row.signal_time))continue;seen++;const stop=Number(row.stop_loss),tp=Number(row.tp1),dir=Number(row.direction);
 const stopHit=dir>0?c[3]<=stop:c[2]>=stop, targetHit=dir>0?c[2]>=tp:c[3]<=tp;
 // If both levels are touched in one OHLC candle, assume the protective stop was hit first.
 if(stopHit)return{outcome:"loss",r:-1,at:c[0],bars:seen};
 if(targetHit)return{outcome:"win",r:1.5,at:c[0],bars:seen};
 if(seen>=100)return{outcome:"expired",r:null,at:c[0],bars:seen};
 }
 return{outcome:null,r:null,at:null,bars:seen};
}

async function trackOpen(db:DB,env:MarketEnv,now:number){
 const q=await db.prepare("SELECT * FROM eti_v3_alpha_signals WHERE outcome IS NULL ORDER BY signal_time ASC LIMIT 100").all();
 const rows=(q.results??[]) as any[], updates:any[]=[];
 const grouped=new Map<string,any[]>();
 for(const r of rows){const k=r.symbol+"|"+r.timeframe;grouped.set(k,[...(grouped.get(k)??[]),r]);}
 for(const [key,items] of grouped){
  const [symbol,interval]=key.split("|");
  let candles:Kline[];
  try{candles=(await getMarketData("klines",{symbol,interval,limit:1000},providerOrder(env))).data as Kline[];}catch{continue}
  for(const r of items){const o=outcomeFor(r,candles);await db.prepare("UPDATE eti_v3_alpha_signals SET outcome=?,outcome_r=?,resolved_at=?,last_checked_at=?,bars_observed=? WHERE id=? AND outcome IS NULL").bind(o.outcome,o.r,o.at,now,o.bars,r.id).run();if(o.outcome)updates.push({id:r.id,outcome:o.outcome,outcomeR:o.r,barsObserved:o.bars});}
 }
 return{checked:rows.length,resolved:updates.length,updates};
}

export async function runV3AlphaTrackingCycle(env:Env,now=nowMs()){if(!env.ETI_PORTFOLIO_DB)return{skipped:true,reason:"d1_unavailable"};return trackOpen(env.ETI_PORTFOLIO_DB,env,now)}

export async function handleV3AlphaLedger(req:Request,env:Env):Promise<Response>{
 const url=new URL(req.url),path=url.pathname,db=env.ETI_PORTFOLIO_DB;
 if(!path.startsWith("/api/algo/v3-alpha/"))return reply({error:"not_found"},404);
 if(!db)return reply({error:"storage_not_configured",message:"ETI_PORTFOLIO_DB D1 binding is required for durable V3 Alpha tracking."},503);
 if(path==="/api/algo/v3-alpha/signals"&&req.method==="GET"){
  const symbol=(url.searchParams.get("symbol")??"").toUpperCase(),limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit")??50)||50));
  if(symbol&&!validSymbol(symbol))return reply({error:"invalid_symbol"},400);
  const q=await db.prepare("SELECT id,symbol,strategy,venue,market,category,timeframe,direction,signal_time,received_at,entry,stop_loss,tp1,tp2,tp3,score,threshold,regime,outcome,outcome_r,resolved_at,bars_observed FROM eti_v3_alpha_signals "+(symbol?"WHERE symbol=? ":"")+"ORDER BY signal_time DESC LIMIT ?").bind(...(symbol?[symbol,limit]:[limit])).all();
  return reply({signals:q.results??[],submitsOrder:false});
 }
 if(path==="/api/algo/v3-alpha/performance"&&req.method==="GET"){
  const symbol=(url.searchParams.get("symbol")??"").toUpperCase();if(symbol&&!validSymbol(symbol))return reply({error:"invalid_symbol"},400);
  const q=await db.prepare("SELECT outcome,outcome_r FROM eti_v3_alpha_signals WHERE outcome IN ('win','loss') "+(symbol?"AND symbol=? ":"")).bind(...(symbol?[symbol]:[])).all();
  const a=(q.results??[]) as any[],wins=a.filter(x=>x.outcome==="win").length,losses=a.length-wins,netR=a.reduce((s,x)=>s+Number(x.outcome_r??0),0),enough=a.length>=30;
  return reply({sampleSize:a.length,wins,losses,winRate:enough?wins/a.length:null,expectancyR:enough?netR/a.length:null,netR,minimumSample:30,status:enough?"reportable_sample":"insufficient_sample",note:enough?"Historical first-touch outcomes only; not a forecast.":"Win rate and expectancy are withheld until 30 resolved signals are recorded.",submitsOrder:false});
 }
 if(path==="/api/algo/v3-alpha/track"&&req.method==="POST"){
  if(!(await authorized(req,env as any)))return reply({error:"unauthorized"},401);
  try{return reply({...await trackOpen(db,env,nowMs()),submitsOrder:false});}catch(e){return reply({error:"tracking_failed",message:e instanceof Error?e.message:"unknown"},500);}
 }
 if(path==="/api/algo/v3-alpha/backtest"&&req.method==="GET"){
  const symbol=(url.searchParams.get("symbol")??"BTCUSDT").toUpperCase(),strategy=(url.searchParams.get("strategy")??"intraday") as Strategy,interval=url.searchParams.get("interval")??"15m";
  const feeBps=Number(url.searchParams.get("feeBps")??10),slippageBps=Number(url.searchParams.get("slippageBps")??5);
  if(!validSymbol(symbol)||!strategies.includes(strategy)||interval!==tfFor(strategy)||![feeBps,slippageBps].every(Number.isFinite)||feeBps<0||slippageBps<0||feeBps>500||slippageBps>500)return reply({error:"invalid_parameters",expectedInterval:strategies.includes(strategy)?tfFor(strategy):null},400);
  try{const candles=(await getMarketData("klines",{symbol,interval,limit:1000},providerOrder(env))).data as Kline[];return reply({symbol,strategy,interval,candles:candles.length,report:backtestV3Alpha(candles,{symbol,strategy,interval:interval as Timeframe,feeBps,slippageBps}),submitsOrder:false,liveExecutionAllowed:false});}
  catch{return reply({error:"market_data_unavailable",symbol,submitsOrder:false},503);}
 }
 return reply({error:"not_found_or_method_not_allowed"},404);
}
