/** Causal synchronized multi-timeframe replay. Every vote is frozen at the execution candle close. */
import type { Kline } from "../market.ts";
import { evaluateV3Alpha } from "./v3-alpha.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TF_SECONDS, type Strategy, type Timeframe } from "./timeframes.ts";

export interface MtfBacktestOptions { symbol:string; strategy:Strategy; feeBps:number; slippageBps:number }
interface Trade { entryTime:number; exitTime:number; entryIndex:number; exitIndex:number; netR:number; grossR:number; costR:number; reason:"stop"|"tp3"|"time" }
const valid=(rows:Kline[])=>Array.isArray(rows)&&rows.length<=1000&&rows.every((r,i)=>r.slice(0,6).every(Number.isFinite)&&r[0]>0&&r[1]>0&&r[2]>=Math.max(r[1],r[4])&&r[3]<=Math.min(r[1],r[4])&&r[3]>0&&r[5]>=0&&(i===0||r[0]>rows[i-1][0]));
function metrics(trades:Trade[],bars:number){
 const rs=trades.map(t=>t.netR),wins=rs.filter(x=>x>0),losses=rs.filter(x=>x<=0);
 let equity=1,peak=1,dd=0;for(const r of rs){equity*=Math.max(0,1+r*.01);peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak)}
 const gp=wins.reduce((a,b)=>a+b,0),gl=-losses.reduce((a,b)=>a+b,0),n=rs.length;
 return{trades:n,wins:wins.length,losses:losses.length,winRate:n>=30?wins.length/n:null,expectancyR:n>=30?rs.reduce((a,b)=>a+b,0)/n:null,profitFactor:n>=30?(gl?gp/gl:gp?null:0):null,netR:rs.reduce((a,b)=>a+b,0),maxDrawdownPct:dd*100,exposurePct:bars?trades.reduce((a,t)=>a+t.exitIndex-t.entryIndex+1,0)/bars*100:0,status:n>=30?"reportable_sample":"insufficient_sample"};}

export function backtestV3AlphaMtf(candles:Partial<Record<Timeframe,Kline[]>>,o:MtfBacktestOptions){
 const tf=EXECUTION_TF[o.strategy],rows=candles[tf]??[],minimum=220;
 if(!valid(rows)||rows.length<minimum+20)return{status:rows.length<minimum+20?"insufficient_data":"invalid_data",bars:rows.length,minimumBars:minimum+20,train:null,test:null,walkForward:[],all:null,trades:[],note:"At least 240 valid chronological execution candles are required."};
 const aligned:Partial<Record<Timeframe,Kline[]>>={};
 const warnings:string[]=[];
 for(const [key,value] of Object.entries(candles) as [Timeframe,Kline[]][]){if(!valid(value)){warnings.push(key+" timeframe failed OHLCV validation and was excluded.");continue}aligned[key]=value;}
 const needed=Object.entries(DEFAULT_WEIGHTS[o.strategy]).filter(([,w])=>w>0).map(([key])=>key as Timeframe);
 for(const key of needed)if(!aligned[key]||aligned[key]!.length<60)warnings.push(key+" timeframe has fewer than 60 valid candles; its vote may be unavailable.");
 const intervalMs=TF_SECONDS[tf]*1000,trades:Trade[]=[];let signals=0,i=minimum;
 while(i<rows.length-2){
  const asOf=rows[i][0]+intervalMs,asOfCandles:Partial<Record<Timeframe,Kline[]>>={};
  for(const key of Object.keys(aligned) as Timeframe[]){const ms=TF_SECONDS[key]*1000;asOfCandles[key]=aligned[key]!.filter(c=>c[0]+ms<=asOf);}
  const signal=evaluateV3Alpha({symbol:o.symbol,strategy:o.strategy,candles:asOfCandles,now:asOf});
  if(signal.status!=="SIGNAL"||signal.stopLoss===null||!signal.takeProfits){i++;continue}
  signals++;const entryIndex=i+1,dir=signal.direction,entry=rows[entryIndex][1],stop=signal.stopLoss,risk=dir*(entry-stop);
  if(!(risk>0&&Number.isFinite(risk))){i++;continue}
  const targets=signal.takeProfits.map(x=>x.price);let stopNow=stop,hit=0,grossR=0,exit=entry,exitIndex=Math.min(rows.length-1,entryIndex+100),reason:Trade["reason"]="time";
  const end=Math.min(rows.length-1,entryIndex+100);
  for(let j=entryIndex;j<=end;j++){
   const bar=rows[j],stopHit=dir>0?bar[3]<=stopNow:bar[2]>=stopNow;
   if(stopHit){grossR+=(1-hit/3)*((stopNow-entry)*dir/risk);exit=stopNow;exitIndex=j;reason="stop";break;}
   while(hit<3&&(dir>0?bar[2]>=targets[hit]:bar[3]<=targets[hit])){
    grossR+=(targets[hit]-entry)*dir/risk/3;hit++;stopNow=hit===1?entry:targets[hit-2];
   }
   if(hit===3){exit=targets[2];exitIndex=j;reason="tp3";break;}
   if(j===end){exit=bar[4];exitIndex=j;grossR+=(1-hit/3)*((exit-entry)*dir/risk);}
  }
  const costR=entry*(2*(o.feeBps+o.slippageBps)/10000)/risk;
  trades.push({entryTime:rows[entryIndex][0],exitTime:rows[exitIndex][0],entryIndex,exitIndex,grossR,costR,netR:grossR-costR,reason});
  i=exitIndex+2;
 }
 const split=Math.floor(rows.length*.7),splitTime=rows[split][0];
 const train=trades.filter(t=>t.exitTime<splitTime),test=trades.filter(t=>t.entryTime>=splitTime),walkForward=[];
 const foldSize=Math.floor(rows.length*.15);
 for(let f=0;f<3;f++){const start=split+f*foldSize,end=Math.min(rows.length,start+foldSize);if(start>=rows.length||end<=start)break;const subset=trades.filter(t=>t.entryTime>=rows[start][0]&&t.exitTime<rows[end-1][0]);walkForward.push({fold:f+1,start:rows[start][0],end:rows[end-1][0],metrics:metrics(subset,end-start)});}
 return{status:"ok",symbol:o.symbol,strategy:o.strategy,executionTimeframe:tf,bars:rows.length,signals,train:metrics(train,split),test:metrics(test,rows.length-split),walkForward,all:metrics(trades,rows.length),trades:trades.slice(-100),warnings,method:"Closed-candle synchronized MTF votes; next-execution-bar-open entries; stop-first same-candle handling; staged 1/3 exits; fee and slippage costs included.",disclaimer:"Historical replay is not a forecast. The chronological holdout is not used to auto-select parameters. Real fills, latency, funding, liquidation and exchange-specific execution may differ."};
}
