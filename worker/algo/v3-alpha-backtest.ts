/** Causal ETIAlgo V3 Alpha historical replay. Signals use closed bars; entries occur at the next bar open. */
import type { Kline } from "../market.ts";
import { evaluateV3Alpha } from "./v3-alpha.ts";
import { TF_SECONDS, type Strategy, type Timeframe } from "./timeframes.ts";
export interface V3BacktestOptions { symbol:string;strategy:Strategy;interval:Timeframe;feeBps:number;slippageBps:number }
interface Trade { entryTime:number;exitTime:number;entryIndex:number;exitIndex:number;direction:1|-1;entry:number;exit:number;grossR:number;costR:number;netR:number;targetsHit:number;reason:"stop"|"tp3"|"time" }
function stats(trades:Trade[],bars:number){const n=trades.length,w=trades.filter(t=>t.netR>0),l=trades.filter(t=>t.netR<=0),gp=w.reduce((s,t)=>s+t.netR,0),gl=-l.reduce((s,t)=>s+t.netR,0),rs=trades.map(t=>t.netR);let eq=1,peak=1,dd=0;for(const r of rs){eq*=1+.01*r;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak)}return{trades:n,wins:w.length,losses:l.length,winRate:n>=30?w.length/n:null,expectancyR:n>=30?rs.reduce((s,x)=>s+x,0)/n:null,profitFactor:n>=30?(gl>0?gp/gl:gp>0?Infinity:null):null,netR:rs.reduce((s,x)=>s+x,0),maxDrawdownPct:dd*100,exposurePct:bars?trades.reduce((s,t)=>s+(t.exitIndex-t.entryIndex+1),0)/bars*100:0,minimumSample:30,status:n>=30?"reportable_sample":"insufficient_sample"}}
export function backtestV3Alpha(rows:Kline[],o:V3BacktestOptions){
 const intervalMs=TF_SECONDS[o.interval]*1000,minimum=220;
 if(rows.length<minimum+20)return{status:"insufficient_data",bars:rows.length,minimumBars:minimum+20,train:null,test:null,walkForward:[],trades:[],note:"At least 240 chronological candles are required."};
 if(rows.some((r,i)=>!r.slice(0,6).every(Number.isFinite)||r[1]<=0||r[2]<Math.max(r[1],r[4])||r[3]>Math.min(r[1],r[4])||r[5]<0||(i>0&&r[0]<=rows[i-1][0])))return{status:"invalid_data",bars:rows.length,train:null,test:null,walkForward:[],trades:[],note:"OHLCV data failed validation."};
 const trades:Trade[]=[];let i=minimum,signals=0;
 while(i<rows.length-2){
  const signal=evaluateV3Alpha({symbol:o.symbol,strategy:o.strategy,candles:{[o.interval]:rows.slice(0,i+1)},now:rows[i][0]+intervalMs});
  if(signal.status!=="SIGNAL"||!signal.stopLoss||!signal.takeProfits){i++;continue}signals++;
  const entryIndex=i+1,dir=signal.direction,entry=rows[entryIndex][1],signedRisk=dir*(entry-signal.stopLoss),risk=Math.abs(signedRisk);
  if(!(signedRisk>0&&risk>0&&Number.isFinite(risk))){i++;continue}
  const targets=[1.5,2.5,3.5].map(rr=>entry+dir*risk*rr),partial=[1/3,1/3,1/3];let stop=signal.stopLoss,hit=0,grossR=0,exit=entry,exitIndex=Math.min(rows.length-1,entryIndex+100),reason:Trade["reason"]="time";
  const end=Math.min(rows.length-1,entryIndex+100);
  for(let j=entryIndex;j<=end;j++){
   const c=rows[j],stopHit=dir>0?c[3]<=stop:c[2]>=stop;
   if(stopHit){grossR+=(1-hit/3)*((stop-entry)*dir/risk);exit=stop;exitIndex=j;reason="stop";break}
   while(hit<3&&(dir>0?c[2]>=targets[hit]:c[3]<=targets[hit])){grossR+=partial[hit]*((targets[hit]-entry)*dir/risk);hit++;stop=hit===1?entry:targets[hit-2];}
   if(hit===3){exit=targets[2];exitIndex=j;reason="tp3";break}
   if(j===end){exit=c[4];exitIndex=j;grossR+=(1-hit/3)*((exit-entry)*dir/risk)}
  }
  const costR=(entry*(2*(o.feeBps+o.slippageBps)/10000))/risk;
  trades.push({entryTime:rows[entryIndex][0],exitTime:rows[exitIndex][0],entryIndex,exitIndex,direction:dir,entry,exit,grossR,costR,netR:grossR-costR,targetsHit:hit,reason});
  i=exitIndex+2;
 }
 const split=Math.floor(rows.length*.7),train=trades.filter(t=>t.exitTime<rows[split][0]),test=trades.filter(t=>t.entryTime>=rows[split][0]);
 const folds=[];const foldSize=Math.floor(rows.length*.15);for(let f=0;f<3;f++){const start=split+f*foldSize,end=Math.min(rows.length, start+foldSize);if(start>=rows.length)break;const ft=trades.filter(t=>t.entryTime>=rows[start][0]&&t.exitTime<rows[end-1][0]);folds.push({fold:f+1,start:rows[start][0],end:rows[end-1][0],metrics:stats(ft,end-start)})}
 return{status:"ok",bars:rows.length,signals,train:stats(train,split),test:stats(test,rows.length-split),walkForward:folds,all:stats(trades,rows.length),trades:trades.slice(-100),disclaimer:"Historical replay of V3 Alpha only. Single-timeframe input means higher-timeframe votes are unavailable; next-open entries, stop-first same-candle handling, 1/3 staged exits, fees and slippage are modelled. Historical outcomes are not forecasts."};
}
