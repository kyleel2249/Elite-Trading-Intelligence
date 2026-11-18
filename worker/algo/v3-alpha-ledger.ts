import type { MarketEnv, Kline } from "../market.ts";
import { getMarketData, providerOrder } from "../market.ts";
import { authorized } from "../execution.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TF_SECONDS, TIMEFRAMES, type Strategy, type Timeframe } from "./timeframes.ts";
import { evaluateSynchronizedV3Alpha, evaluateAgentGates, monteCarloRisk, thresholdSensitivity, type OutcomeSample } from "./v3-alpha-intelligence.ts";
import type { V3AlphaResult } from "./v3-alpha.ts";
import { backtestV3Alpha } from "./v3-alpha-backtest.ts";
import { backtestV3AlphaMtf } from "./v3-alpha-mtf-backtest.ts";

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
 const id=[venue,market,category,symbol,strategy,a.evaluatedCandleTime].join(":");
 await db.prepare(`INSERT OR IGNORE INTO eti_v3_alpha_signals
 (id,symbol,strategy,venue,market,category,timeframe,direction,signal_time,received_at,entry_low,entry_high,entry,stop_loss,tp1,tp2,tp3,score,threshold,regime,payload_json)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .bind(id,symbol,strategy,venue,market,category,tfFor(strategy),a.direction,a.evaluatedCandleTime,now,a.entryZone[0],a.entryZone[1],(a.entryZone[0]+a.entryZone[1])/2,a.stopLoss,a.takeProfits[0].price,a.takeProfits[1].price,a.takeProfits[2].price,a.score,a.threshold,a.regime,JSON.stringify(a)).run();
 return true;
}

export type SignalLifecycleStatus = "confirmed" | "entry_reached" | "tp1_reached" | "tp2_reached" | "tp3_reached" | "invalidated" | "expired";
export interface SignalLifecycleAdvance {
 status:SignalLifecycleStatus;outcome:"win"|"loss"|"expired"|null;r:number|null;at:number|null;bars:number;note:string;
}
/** Advance one immutable signal through closed-candle lifecycle states. A same-candle stop/target collision resolves conservatively as a stop. */
export function advanceSignalLifecycle(row:any,candles:Kline[]):SignalLifecycleAdvance{
 let status=(["confirmed","entry_reached","tp1_reached","tp2_reached","tp3_reached","invalidated","expired"].includes(String(row.lifecycle_status))?String(row.lifecycle_status):"confirmed") as SignalLifecycleStatus;
 let bars=0;const signalTime=Number(row.signal_time),direction=Number(row.direction),entryLow=Number(row.entry_low),entryHigh=Number(row.entry_high),stop=Number(row.stop_loss);
 const lo=Math.min(entryLow,entryHigh),hi=Math.max(entryLow,entryHigh);
 for(const c of candles){
  if(c[0]<=signalTime)continue;
  bars++;
  const stopHit=direction>0?c[3]<=stop:c[2]>=stop;
  const entryHit=c[2]>=lo&&c[3]<=hi;
  const tp1=Number(row.tp1),tp2=Number(row.tp2),tp3=Number(row.tp3);
  const hit=(target:number)=>direction>0?c[2]>=target:c[3]<=target;
  if(stopHit)return{status:"invalidated",outcome:"loss",r:-1,at:c[0],bars,note:status==="confirmed"?"Protective stop reached before a confirmed entry.":"Protective stop reached after entry."};
  if(status==="confirmed"&&entryHit)status="entry_reached";
  if(hit(tp3))return{status:"tp3_reached",outcome:"win",r:1.5,at:c[0],bars,note:"TP3 reached; historical outcome remains TP1-based for compatibility."};
  if(hit(tp2))return{status:"tp2_reached",outcome:"win",r:1.5,at:c[0],bars,note:"TP2 reached; historical outcome remains TP1-based for compatibility."};
  if(hit(tp1))return{status:"tp1_reached",outcome:"win",r:1.5,at:c[0],bars,note:"TP1 reached."};
  if(bars>=100)return{status:"expired",outcome:"expired",r:null,at:c[0],bars,note:"Signal expired after 100 observed candles without a terminal target or stop event."};
 }
 return{status,outcome:null,r:null,at:null,bars,note:status==="entry_reached"?"Entry zone reached; targets and stop remain active.":"Awaiting entry-zone interaction."};
}

async function trackOpen(db:DB,env:MarketEnv,now:number){
 const q=await db.prepare("SELECT s.*,COALESCE(l.status,'confirmed') AS lifecycle_status FROM eti_v3_alpha_signals s LEFT JOIN eti_v3_alpha_lifecycle l ON l.signal_id=s.id WHERE s.outcome IS NULL AND s.venue='bybit' ORDER BY s.signal_time ASC LIMIT 100").all();
 const rows=(q.results??[]) as any[], updates:any[]=[];
 const grouped=new Map<string,any[]>();
 for(const r of rows){const k=r.symbol+"|"+r.timeframe;grouped.set(k,[...(grouped.get(k)??[]),r]);}
 for(const [key,items] of [...grouped].slice(0,20)){
  const [symbol,interval]=key.split("|");
  let candles:Kline[];
  try{candles=(await getMarketData("klines",{symbol,interval,limit:1000},providerOrder(env))).data as Kline[];}catch{continue}
  for(const r of items){
   const o=advanceSignalLifecycle(r,candles),previous=String(r.lifecycle_status??"confirmed");
   if(o.status===previous&&!o.outcome)continue;
   await db.prepare("UPDATE eti_v3_alpha_signals SET outcome=COALESCE(outcome,?),outcome_r=COALESCE(outcome_r,?),resolved_at=COALESCE(resolved_at,?),last_checked_at=?,bars_observed=? WHERE id=? AND outcome IS NULL")
    .bind(o.outcome,o.r,o.at,now,o.bars,r.id).run();
   await db.prepare("INSERT INTO eti_v3_alpha_lifecycle(signal_id,status,updated_at,note,bars_observed) VALUES(?,?,?,?,?) ON CONFLICT(signal_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,note=excluded.note,bars_observed=excluded.bars_observed")
    .bind(r.id,o.status,now,o.note,o.bars).run();
   updates.push({id:r.id,lifecycleStatus:o.status,outcome:o.outcome,outcomeR:o.r,barsObserved:o.bars,note:o.note});
  }
 }
 return{checked:rows.length,resolved:updates.length,updates};
}

export async function runV3AlphaTrackingCycle(env:Env,now=nowMs()){if(!env.ETI_PORTFOLIO_DB)return{skipped:true,reason:"d1_unavailable"};return trackOpen(env.ETI_PORTFOLIO_DB,env,now)}

export async function handleV3AlphaLedger(req:Request,env:Env):Promise<Response>{
 const url=new URL(req.url),path=url.pathname,db=env.ETI_PORTFOLIO_DB;
 if(!path.startsWith("/api/algo/v3-alpha/"))return reply({error:"not_found"},404);

 if(path==="/api/algo/v3-alpha/signals"&&req.method==="GET"){
  if(!db)return reply({error:"storage_not_configured",message:"Signal history requires the ETI_PORTFOLIO_DB D1 binding."},503);
  const symbol=(url.searchParams.get("symbol")??"").toUpperCase(),limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit")??50)||50));
  if(symbol&&!validSymbol(symbol))return reply({error:"invalid_symbol"},400);
  const q=await db.prepare("SELECT s.id,s.symbol,s.strategy,s.venue,s.market,s.category,s.timeframe,s.direction,s.signal_time,s.received_at,s.entry,s.stop_loss,s.tp1,s.tp2,s.tp3,s.score,s.threshold,s.regime,s.outcome,s.outcome_r,s.resolved_at,s.bars_observed,COALESCE(l.status,'confirmed') AS lifecycle_status,l.updated_at AS lifecycle_updated_at,l.note AS lifecycle_note FROM eti_v3_alpha_signals s LEFT JOIN eti_v3_alpha_lifecycle l ON l.signal_id=s.id "+(symbol?"WHERE s.symbol=? ":"")+"ORDER BY s.signal_time DESC LIMIT ?").bind(...(symbol?[symbol,limit]:[limit])).all();
  return reply({signals:q.results??[],submitsOrder:false});
 }
 if(path==="/api/algo/v3-alpha/performance"&&req.method==="GET"){
  if(!db)return reply({error:"storage_not_configured",message:"Historical performance requires the ETI_PORTFOLIO_DB D1 binding."},503);
  const symbol=(url.searchParams.get("symbol")??"").toUpperCase();if(symbol&&!validSymbol(symbol))return reply({error:"invalid_symbol"},400);
  const q=await db.prepare("SELECT outcome,outcome_r FROM eti_v3_alpha_signals WHERE outcome IN ('win','loss') "+(symbol?"AND symbol=? ":"")).bind(...(symbol?[symbol]:[])).all();
  const a=(q.results??[]) as any[],wins=a.filter(x=>x.outcome==="win").length,losses=a.length-wins,netR=a.reduce((s,x)=>s+Number(x.outcome_r??0),0),enough=a.length>=30;
  return reply({sampleSize:a.length,wins,losses,winRate:enough?wins/a.length:null,expectancyR:enough?netR/a.length:null,netR,minimumSample:30,status:enough?"reportable_sample":"insufficient_sample",note:enough?"Historical first-touch outcomes only; not a forecast.":"Win rate and expectancy are withheld until 30 resolved signals are recorded.",trackedVenue:"bybit",noteOnCoverage:"Automatic outcome tracking uses Bybit historical candles. Bitget signal records are retained but are not scored against a different venue feed.",submitsOrder:false});
 }
 if(path==="/api/algo/v3-alpha/track"&&req.method==="POST"){
  if(!db)return reply({error:"storage_not_configured"},503);
  if(!(await authorized(req,env as any)))return reply({error:"unauthorized"},401);
  try{return reply({...await trackOpen(db,env,nowMs()),submitsOrder:false});}catch(e){return reply({error:"tracking_failed",message:e instanceof Error?e.message:"unknown"},500);}
 }
 if(path==="/api/algo/v3-alpha/mtf-backtest"&&req.method==="GET"){
  const symbol=(url.searchParams.get("symbol")??"BTCUSDT").toUpperCase(),strategy=(url.searchParams.get("strategy")??"intraday") as Strategy;
  const feeBps=Number(url.searchParams.get("feeBps")??10),slippageBps=Number(url.searchParams.get("slippageBps")??5),limit=Number(url.searchParams.get("limit")??500);
  if(!validSymbol(symbol)||!strategies.includes(strategy)||![feeBps,slippageBps,limit].every(Number.isFinite)||feeBps<0||slippageBps<0||feeBps>500||slippageBps>500||!Number.isInteger(limit)||limit<240||limit>1000)return reply({error:"invalid_parameters",limitRange:[240,1000]},400);
  const required=TIMEFRAMES.filter(tf=>DEFAULT_WEIGHTS[strategy][tf]>0||tf===tfFor(strategy)),candles:Partial<Record<Timeframe,Kline[]>>={},failures:Record<string,string>={};
  for(const tf of required){try{candles[tf]=(await getMarketData("klines",{symbol,interval:tf,limit},providerOrder(env))).data as Kline[];}catch(e){failures[tf]=e instanceof Error?e.message:"market_data_unavailable";}}
  if(!candles[tfFor(strategy)])return reply({error:"execution_timeframe_unavailable",failures,submitsOrder:false},503);
  return reply({symbol,strategy,requestedLimit:limit,failures,report:backtestV3AlphaMtf(candles,{symbol,strategy,feeBps,slippageBps}),submitsOrder:false,liveExecutionAllowed:false});
 }
 if(path==="/api/algo/v3-alpha/intelligence"&&req.method==="GET"){
  const symbol=(url.searchParams.get("symbol")??"BTCUSDT").toUpperCase(),strategy=(url.searchParams.get("strategy")??"intraday") as Strategy;
  const simulations=Number(url.searchParams.get("simulations")??3000),riskPct=Number(url.searchParams.get("riskPct")??1);
  if(!validSymbol(symbol)||!strategies.includes(strategy)||!Number.isFinite(simulations)||simulations<100||simulations>10000||!Number.isFinite(riskPct)||riskPct<0.1||riskPct>2)return reply({error:"invalid_parameters",riskPctRange:[0.1,2],simulationRange:[100,10000]},400);
  const required=TIMEFRAMES.filter(tf=>DEFAULT_WEIGHTS[strategy][tf]>0||tf===tfFor(strategy));
  const candles:Partial<Record<Timeframe,Kline[]>>={},fetchFailures:Record<string,string>={};
  for(const tf of required){
   try{candles[tf]=(await getMarketData("klines",{symbol,interval:tf,limit:300},providerOrder(env))).data as Kline[];}
   catch(e){fetchFailures[tf]=e instanceof Error?e.message:"market_data_unavailable";}
  }
  const snapshot=evaluateSynchronizedV3Alpha({symbol,strategy,candles,now:nowMs()});
  const q=db?await db.prepare("SELECT strategy,regime,score,outcome,outcome_r,signal_time,entry,stop_loss FROM eti_v3_alpha_signals WHERE outcome IN ('win','loss') ORDER BY signal_time ASC LIMIT 2000").all():{results:[]};
  const samples=(q.results??[]).map((x:any)=>({...x,score:Number(x.score),outcome_r:Number(x.outcome_r),signal_time:Number(x.signal_time)})) as OutcomeSample[];
  const signalRecorded=db?await recordV3AlphaSignal(db,symbol,strategy,"bybit","futures",/USDT$|USDC$/.test(symbol)?"linear":"inverse",snapshot.signal,nowMs()).catch(()=>false):false;
  const strategySamples=samples.filter(x=>x.strategy===strategy);
  const regimeSamples=snapshot.signal.regime==="unknown"?strategySamples:strategySamples.filter(x=>x.regime===snapshot.signal.regime);
  const riskSamples=regimeSamples.length>=30?regimeSamples:strategySamples;
  return reply({symbol,strategy,snapshot:{...snapshot,fetchFailures},storage:{available:!!db,signalRecorded},marketDataSource:"bybit_public_market_data",agentEvaluation:evaluateAgentGates(samples),parameterSensitivity:thresholdSensitivity(strategySamples),monteCarlo:monteCarloRisk({rMultiples:riskSamples.map(x=>Number(x.outcome_r)),simulations,riskPct}),sampleContext:{strategySamples:strategySamples.length,matchingRegimeSamples:regimeSamples.length,riskSimulationSamples:riskSamples.length,minimumSample:30},submitsOrder:false,liveExecutionAllowed:false,note:"Multi-timeframe analysis is synchronized to the last fully closed execution candle. Parameter results are sensitivity research, not auto-deployed settings. AI agent gates authorize paper evaluation only."});
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
