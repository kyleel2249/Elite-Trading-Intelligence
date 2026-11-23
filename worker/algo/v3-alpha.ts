/** ETIAlgo V3 Alpha: independent closed-candle signal model. It is advisory/veto-only and never submits orders. */
import type { Kline } from "../market.ts";
import { adxSeries, atrSeries, ema, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { detectDivergence, type DivergenceResult } from "./divergence.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TF_SECONDS, marketStructure, type Strategy, type Timeframe } from "./timeframes.ts";
export interface V3AlphaResult {
 name:"ETIAlgo V3 Alpha";status:"SIGNAL"|"NEUTRAL"|"INSUFFICIENT_DATA";direction:1|-1|0;action:"BUY"|"SELL"|"NO_TRADE";
 score:number;threshold:number;confidenceType:"heuristic_evidence_score_not_probability";
 entryZone:[number,number]|null;stopLoss:number|null;takeProfits:{label:"TP1"|"TP2"|"TP3";price:number;rewardRisk:number}[]|null;
 regime:string;divergence:DivergenceResult;timeframeVotes:Partial<Record<Timeframe,-1|0|1>>;componentScores:Record<string,number>;
 confirmations:string[];warnings:string[];evaluatedCandleTime:number|null;generatedAt:string;nonRepainting:true;submitsOrder:false;
}
const clamp=(v:number,l:number,h:number)=>Math.max(l,Math.min(h,v)),finite=(v:number|undefined):v is number=>typeof v==="number"&&Number.isFinite(v),sign=(v:number):-1|0|1=>v>0?1:v<0?-1:0;
function closed(rows:Kline[]|undefined,tf:Timeframe,now:number):Kline[]{if(!rows?.length)return[];const ms=TF_SECONDS[tf]*1000;return rows.filter((r,i)=>i<rows.length-1||r[0]+ms<=now)}
function rsi(v:number[],p=14):number[]{const out=new Array(v.length).fill(NaN);if(v.length<=p)return out;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(0,d);l+=Math.max(0,-d)}g/=p;l/=p;out[p]=l===0?(g===0?50:100):100-100/(1+g/l);for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];g=(g*(p-1)+Math.max(0,d))/p;l=(l*(p-1)+Math.max(0,-d))/p;out[i]=l===0?(g===0?50:100):100-100/(1+g/l)}return out}
function unavailable(now:number,warning:string):V3AlphaResult{return{name:"ETIAlgo V3 Alpha",status:"INSUFFICIENT_DATA",direction:0,action:"NO_TRADE",score:0,threshold:58,confidenceType:"heuristic_evidence_score_not_probability",entryZone:null,stopLoss:null,takeProfits:null,regime:"unknown",divergence:{status:"insufficient_data",kind:"none",direction:0,strength:0,previous:null,current:null,note:"Insufficient closed candles for divergence analysis."},timeframeVotes:{},componentScores:{},confirmations:[],warnings:[warning],evaluatedCandleTime:null,generatedAt:new Date(now).toISOString(),nonRepainting:true,submitsOrder:false}}
export function evaluateV3Alpha(input:{symbol:string;strategy:Strategy;candles:Partial<Record<Timeframe,Kline[]>>;now?:number}):V3AlphaResult{
 const now=input.now??Date.now(),tf=EXECUTION_TF[input.strategy],rows=closed(input.candles[tf],tf,now);
 if(rows.length<100)return unavailable(now,"At least 100 fully closed execution-timeframe candles are required.");
 const last=rows.at(-1)!,age=now-(last[0]+TF_SECONDS[tf]*1000);
 if(age< -60000||age>TF_SECONDS[tf]*3000)return unavailable(now,"Execution candles are stale or have invalid timestamps.");
 if(rows.some(r=>!r.slice(0,6).every(finite)||r[1]<=0||r[2]<Math.max(r[1],r[4])||r[3]>Math.min(r[1],r[4])||r[5]<0))return unavailable(now,"Invalid OHLCV values detected.");
 const n=rows.length-1,close=rows.map(r=>r[4]),price=last[4],atr=atrSeries(rows).at(-1);
 if(!finite(atr)||atr!<=0)return unavailable(now,"ATR calculation failed.");
 const e9=ema(close,9),e21=ema(close,21),e50=ema(close,50),e200=ema(close,200),rv=volumeMomentum(rows),adx=adxSeries(rows),r=rsi(close),st=marketStructure(rows),reg=classifyRegime(rows);
 const components:Record<string,number>={},confirmations:string[]=[],warnings:string[]=[];const divergence=detectDivergence(rows,r);
 const add=(k:string,v:number,msg:string)=>{components[k]=v;if(v)confirmations.push(msg)};
 const emaDir=e9[n]>e21[n]&&e21[n]>e50[n]&&price>e200[n]?1:e9[n]<e21[n]&&e21[n]<e50[n]&&price<e200[n]?-1:0;
 add("emaTrend",emaDir*20,"EMA 9/21/50/200 alignment");
 const rDir=r[n]>=52&&r[n]>r[n-3]?1:r[n]<=48&&r[n]<r[n-3]?-1:0;
 add("rsiMomentum",rDir*(r[n]>=70||r[n]<=30?5:12),"RSI slope and momentum");
 const di=adx.plusDI[n]>adx.minusDI[n]?1:adx.minusDI[n]>adx.plusDI[n]?-1:0,ad=finite(adx.adx[n])&&adx.adx[n]>=18?di:0;
 add("directionalStrength",ad*12,"ADX and directional-index confirmation");
 const vd=rv.volumeConfirmsPrice?sign(rv.score):0;add("volumeFlow",vd*Math.min(12,Math.round(Math.abs(rv.score)/8)),"Volume-flow participation");
 const sd=st.bias==="bull"?1:st.bias==="bear"?-1:0;add("marketStructure",sd*18,"Swing structure");
 const divergenceScore=divergence.direction*(divergence.strength>=70?10:divergence.strength>=50?7:0);add("divergence",divergenceScore,"Confirmed price/RSI divergence");
 const prior=rows.slice(-21,-1),hi=Math.max(...prior.map(x=>x[2])),lo=Math.min(...prior.map(x=>x[3])),bd=price>hi?1:price<lo?-1:0;
 add("rangeBreakout",bd*10,"Closed-candle range breakout");
 const weights=DEFAULT_WEIGHTS[input.strategy],votes:Partial<Record<Timeframe,-1|0|1>>={};let mtf=0,tw=0;
 for(const key of Object.keys(weights) as Timeframe[]){if(weights[key]<=0)continue;const data=closed(input.candles[key],key,now);if(data.length<60)continue;const c=data.map(x=>x[4]),f=ema(c,20),s=ema(c,50),p=c.at(-1)!;const vote=f.at(-1)!>s.at(-1)!&&p>f.at(-1)!?1:f.at(-1)!<s.at(-1)!&&p<f.at(-1)!?-1:0;votes[key]=vote;mtf+=vote*weights[key];tw+=weights[key]}
 add("multiTimeframe",tw?Math.round(clamp(mtf/tw,-1,1)*18):0,"Strategy-weighted multi-timeframe consensus");
 const score=Math.round(clamp(Object.values(components).reduce((a,b)=>a+b,0),-100,100)),threshold=finite(adx.adx[n])&&adx.adx[n]<14||reg.regime==="high_volatility"||reg.regime==="abnormal"?68:58;
 const candidate=Math.abs(score)>=threshold?sign(score):0,aligned=Object.values(components).filter(v=>candidate!==0&&Math.sign(v)===candidate&&Math.abs(v)>=5).length,opposed= candidate!==0&&sd===-candidate;
 const ok=candidate!==0&&aligned>=3&&!opposed&&reg.profile.allowNewEntries,dir=ok?candidate:0;
 if(opposed)warnings.push("Signal conflicts with swing structure; trade withheld.");if(candidate!==0&&divergence.direction!==0&&candidate!==divergence.direction)warnings.push("Momentum divergence opposes the candidate direction; treat the setup as lower quality.");if(!reg.profile.allowNewEntries)warnings.push("Regime profile suspends new entries.");if(candidate&&aligned<3)warnings.push("Fewer than three evidence families agree.");
 const risk=atr!*1.6,targets=ok?([1.5,2.5,3.5] as const).map((rr,i)=>({label:("TP"+(i+1)) as "TP1"|"TP2"|"TP3",price:price+dir*risk*rr,rewardRisk:rr})):null;
 return{name:"ETIAlgo V3 Alpha",status:ok?"SIGNAL":"NEUTRAL",direction:dir,action:dir>0?"BUY":dir<0?"SELL":"NO_TRADE",score,threshold,confidenceType:"heuristic_evidence_score_not_probability",entryZone:ok?[price-atr!*.15,price+atr!*.15]:null,stopLoss:ok?price-dir*risk:null,takeProfits:targets,regime:reg.regime,divergence,timeframeVotes:votes,componentScores:components,confirmations,warnings,evaluatedCandleTime:last[0],generatedAt:new Date(now).toISOString(),nonRepainting:true,submitsOrder:false}
}