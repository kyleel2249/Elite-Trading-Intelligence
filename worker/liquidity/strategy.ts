import type { Candle, DepthBook, TradePrint } from "./engine.ts";

export type SignalDirection = "LONG" | "SHORT" | "WAIT";
export interface StrategyRiskConfig {
  capital: number; leverage: number; riskPercent: number; maxMarginPercent: number;
  compoundProfits: boolean; maxDailyLossPercent: number;
}
export const DEFAULT_ETI_RISK: StrategyRiskConfig = {
  capital: 74, leverage: 20, riskPercent: 30, maxMarginPercent: 30,
  compoundProfits: true, maxDailyLossPercent: 30
};
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const round=(n:number,d=4)=>Number(n.toFixed(d));
function ema(values:number[],period:number):number|null {
  if(values.length<period)return null;
  const k=2/(period+1);let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function rsi(values:number[],period=14):number|null {
  if(values.length<=period)return null;let up=0,down=0;
  for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)up+=d;else down-=d;}
  if(down===0)return 100;return 100-(100/(1+up/down));
}
function atr(rows:Candle[],period=14):number|null {
  if(rows.length<=period)return null;const tr:number[]=[];
  for(let i=1;i<rows.length;i++){const p=rows[i-1][4],r=rows[i];tr.push(Math.max(r[2]-r[3],Math.abs(r[2]-p),Math.abs(r[3]-p)));}
  return tr.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function macd(values:number[]):{macd:number;signal:number;histogram:number}|null {
  if(values.length<35)return null;
  const fast=ema(values,12),slow=ema(values,26);if(fast===null||slow===null)return null;
  const series:number[]=[];for(let i=26;i<=values.length;i++){const f=ema(values.slice(0,i),12),s=ema(values.slice(0,i),26);if(f!==null&&s!==null)series.push(f-s);}
  const sig=ema(series,9);if(sig===null)return null;return {macd:fast-slow,signal:sig,histogram:fast-slow-sig};
}
function validCandles(rows:Candle[]):Candle[]{return (Array.isArray(rows)?rows:[]).filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(finite)&&r[1]>0&&r[2]>=Math.max(r[1],r[4])&&r[3]<=Math.min(r[1],r[4])&&r[5]>=0).slice(-500);}
function timeframeSignals(rows:Candle[]){
 const c=validCandles(rows),close=c.map(x=>x[4]),last=c[c.length-1];
 if(c.length<35||!last)return {available:false,trend:0,momentum:0,volume:0,structure:0,volatility:0,indicators:{ema20:null,ema50:null,ema200:null,rsi14:null,atr14:null,macd:null,volumeRatio:null},lastPrice:last?.[4]??null};
 const e20=ema(close,20),e50=ema(close,50),e200=ema(close,200),rv=rsi(close),a=atr(c),m=macd(close);
 const avgVol=c.slice(-21,-1).reduce((s,x)=>s+x[5],0)/20,volumeRatio=avgVol>0?last[5]/avgVol:0;
 const trend=(e20!==null&&e50!==null?(last[4]>e20&&e20>e50?1:last[4]<e20&&e20<e50?-1:0):0)+(e200!==null?(last[4]>e200?0.5:last[4]<e200?-0.5:0):0);
 const momentum=(rv===null?0:rv>55?1:rv<45?-1:0)+(m?(m.histogram>0?1:m.histogram<0?-1:0):0);
 const prior=c.slice(-21,-1),hi=Math.max(...prior.map(x=>x[2])),lo=Math.min(...prior.map(x=>x[3]));
 const structure=last[4]>hi?1:last[4]<lo?-1:last[2]>hi&&last[4]<hi?-0.5:last[3]<lo&&last[4]>lo?0.5:0;
 const direction=last[4]>=last[1]?1:-1,volume=volumeRatio>=1.5?direction:volumeRatio<0.7?0:direction*0.35;
 const volatility=a&&last[4]>0?a/last[4]*100:0;
 return {available:true,trend:clamp(trend/1.5,-1,1),momentum:clamp(momentum/2,-1,1),volume:clamp(volume,-1,1),structure:clamp(structure,-1,1),volatility,indicators:{ema20:e20,ema50:e50,ema200:e200,rsi14:rv,atr14:a,macd:m,volumeRatio},lastPrice:last[4]};
}
function depthSignals(book?:DepthBook|null,trades:TradePrint[]=[]){
 if(!book)return {available:false,imbalance:0,deltaPct:0,spreadBps:null,bidNotional:0,askNotional:0};
 const bids=(book.bids||[]).filter(x=>finite(x[0])&&finite(x[1])&&x[0]>0&&x[1]>0).slice(0,50),asks=(book.asks||[]).filter(x=>finite(x[0])&&finite(x[1])&&x[0]>0&&x[1]>0).slice(0,50);
 if(!bids.length||!asks.length)return {available:false,imbalance:0,deltaPct:0,spreadBps:null,bidNotional:0,askNotional:0};
 const bidNotional=bids.reduce((s,x)=>s+x[0]*x[1],0),askNotional=asks.reduce((s,x)=>s+x[0]*x[1],0),mid=(bids[0][0]+asks[0][0])/2;
 let buy=0,sell=0;for(const t of trades){const n=t.price*t.qty;if(t.side==="sell"||t.isBuyerMaker)sell+=n;else buy+=n;}
 const total=buy+sell;return {available:true,imbalance:(bidNotional-askNotional)/(bidNotional+askNotional||1),deltaPct:total?(buy-sell)/total*100:0,spreadBps:(asks[0][0]-bids[0][0])/mid*10000,bidNotional,askNotional};
}
export interface HeatZone { price:number; low:number; high:number; strength:number; type:"support"|"resistance"; source:"orderbook"|"volume_profile"|"swing"; touches:number; notional?:number }
function supportResistance(rows:Candle[],book?:DepthBook|null):HeatZone[]{
 const c=validCandles(rows);if(c.length<10)return [];
 const last=c[c.length-1][4],range=Math.max(last*0.0002,(Math.max(...c.slice(-100).map(x=>x[2]))-Math.min(...c.slice(-100).map(x=>x[3])))/100);
 const raw:HeatZone[]=[];
 // Swing pivots are candle-derived zones, not claimed resting orders.
 for(let i=Math.max(2,c.length-120);i<c.length-2;i++){
  const r=c[i],left=c.slice(i-2,i),right=c.slice(i+1,i+3);
  if(left.every(x=>r[3]<=x[3])&&right.every(x=>r[3]<=x[3]))raw.push({price:r[3],low:r[3]-range,high:r[3]+range,strength:1,touches:1,type:r[3]<=last?"support":"resistance",source:"swing"});
  if(left.every(x=>r[2]>=x[2])&&right.every(x=>r[2]>=x[2]))raw.push({price:r[2],low:r[2]-range,high:r[2]+range,strength:1,touches:1,type:r[2]>=last?"resistance":"support",source:"swing"});
 }
 // Approximate volume-at-price from candle typical price; not exchange trade-level volume profile.
 const bins=new Map<number,{v:number;count:number}>();for(const r of c.slice(-200)){const p=(r[2]+r[3]+r[4])/3,k=Math.round(p/range);const x=bins.get(k)||{v:0,count:0};x.v+=r[5];x.count++;bins.set(k,x);}
 const maxVol=Math.max(1,...Array.from(bins.values()).map(x=>x.v));
 for(const [k,v] of bins){if(v.v/maxVol>=0.35){const p=k*range;raw.push({price:p,low:p-range,high:p+range,strength:round(v.v/maxVol,3),touches:v.count,type:p<=last?"support":"resistance",source:"volume_profile"});}}
 if(book){for(const [side,levels] of [["support",book.bids||[]],["resistance",book.asks||[]]] as const){const valid=levels.filter(x=>finite(x[0])&&finite(x[1])&&x[0]>0&&x[1]>0),median=valid.length?valid.map(x=>x[0]*x[1]).sort((a,b)=>a-b)[Math.floor(valid.length/2)]:0;for(const [p,q] of valid){const n=p*q;if(median>0&&n>=median*3)raw.push({price:p,low:p-range/2,high:p+range/2,strength:clamp(n/(median*8),0.25,1),touches:1,type:side,source:"orderbook",notional:n});}}}
 const merged:HeatZone[]=[];for(const z of raw.sort((a,b)=>b.strength-a.strength)){const hit=merged.find(x=>x.type===z.type&&Math.abs(x.price-z.price)<=range*2);if(hit){hit.strength=clamp(hit.strength+z.strength*0.25,0,1.5);hit.touches+=z.touches;if(z.source==="orderbook"){hit.source="orderbook";hit.notional=(hit.notional||0)+(z.notional||0);}hit.low=Math.min(hit.low,z.low);hit.high=Math.max(hit.high,z.high);}else merged.push({...z});}
 return merged.sort((a,b)=>b.strength-a.strength).slice(0,24);
}
export function calculatePositionPlan(input:{equity:number;entry:number;stop:number;leverage:number;riskPercent:number;maxMarginPercent?:number;compoundProfits?:boolean}){
 const equity=Math.max(0,input.equity),entry=input.entry,stop=input.stop,lev=clamp(input.leverage,1,125),riskPct=clamp(input.riskPercent,0.1,100),marginPct=clamp(input.maxMarginPercent??30,1,100);
 if(![equity,entry,stop].every(finite)||equity<=0||entry<=0||stop<=0||entry===stop)return {valid:false,reason:"invalid_sizing_inputs",equity,riskBudget:0,notional:0,margin:0,quantity:0,plannedLoss:0,actualRiskPercent:0,leverage:lev};
 const distance=Math.abs(entry-stop)/entry,side=stop<entry?"LONG":"SHORT";
 
 const riskBudget=equity*riskPct/100,maxMargin=equity*marginPct/100,maxNotional=maxMargin*lev;
 const targetNotional=riskBudget/distance,notional=Math.min(targetNotional,maxNotional),margin=notional/lev,plannedLoss=notional*distance;
 // Conservative liquidation proximity proxy. Actual exchange liquidation is contract/account-mode specific.
 const liqBufferPct=100/lev*0.75,stopDistancePct=distance*100;
 const liquidationSafe=stopDistancePct<liqBufferPct;
 return {valid:liquidationSafe&&notional>0,reason:!liquidationSafe?"stop_too_close_to_estimated_liquidation":targetNotional>maxNotional?"risk_target_capped_by_margin_limit":"sized",equity,riskBudget,notional,margin,quantity:notional/entry,plannedLoss,actualRiskPercent:plannedLoss/equity*100,leverage:lev,marginPercent:margin/equity*100,stopDistancePct,estimatedLiquidationBufferPct:liqBufferPct,liquidationSafe,side,compoundProfits:input.compoundProfits!==false};
}
export function compoundEquity(currentEquity:number,realizedPnl:number,compoundProfits=true){const base=Math.max(0,currentEquity);return round(Math.max(0,base+(compoundProfits?realizedPnl:Math.min(0,realizedPnl))),8);}
export function analyzeTradingStrategy(input:{symbol:string;venue?:string;market?:string;category?:string;candles:Candle[];candlesByTimeframe?:Record<string,Candle[]>;depth?:DepthBook|null;trades?:TradePrint[];risk?:Partial<StrategyRiskConfig>}){
 const rows=validCandles(input.candles||[]),tf=input.candlesByTimeframe||{},primary=timeframeSignals(rows),frames:Record<string,ReturnType<typeof timeframeSignals>>={};
 for(const [k,v] of Object.entries(tf))frames[k]=timeframeSignals(v);
 const flow=depthSignals(input.depth,input.trades||[]),zones=supportResistance(rows,input.depth);
 const scoreParts={trend:primary.trend*20,momentum:primary.momentum*15,volume:primary.volume*10,structure:primary.structure*15,orderflow:flow.available?(flow.deltaPct/100*8+flow.imbalance*7):0,volatility:primary.volatility>0?clamp((2-primary.volatility)/2,-1,1)*5:0,liquidity:flow.available?clamp(flow.imbalance*10,-1,1)*5:0};
 const total=Object.values(scoreParts).reduce((a,b)=>a+b,0),score=round(clamp(50+total,0,100),1);
 const bullish=score>=62&&primary.trend>0&&primary.momentum>=0, bearish=score<=38&&primary.trend<0&&primary.momentum<=0;
 const direction:SignalDirection=bullish?"LONG":bearish?"SHORT":"WAIT";
 const confidence=round(clamp(Math.abs(score-50)*2,0,100),1);
 const latest=rows[rows.length-1],atrValue=primary.indicators.atr14||0,entry=latest?.[4]||0;
 const stop=direction==="LONG"?entry-atrValue*1.5:direction==="SHORT"?entry+atrValue*1.5:0;
 const target1=direction==="LONG"?entry+atrValue*2.25:direction==="SHORT"?entry-atrValue*2.25:0;
 const risk={...DEFAULT_ETI_RISK,...input.risk};
 const position=direction!=="WAIT"&&entry>0&&stop>0?calculatePositionPlan({equity:risk.capital,entry,stop,leverage:risk.leverage,riskPercent:risk.riskPercent,maxMarginPercent:risk.maxMarginPercent,compoundProfits:risk.compoundProfits}):null;
 const tfVotes=Object.entries(frames).map(([timeframe,v])=>({timeframe,trend:v.trend,momentum:v.momentum,available:v.available}));
 const warnings:string[]=[];if(rows.length<200)warnings.push("Fewer than 200 candles: EMA200 and long-history context may be unavailable.");if(!flow.available)warnings.push("Order-book feed unavailable: liquidity confirmation is omitted.");if(flow.spreadBps!==null&&flow.spreadBps>15)warnings.push("Spread exceeds 15 bps; execution quality is poor.");if(direction!=="WAIT"&&position&&!position.valid)warnings.push("Signal sizing blocked: stop/liquidation or margin constraints failed.");if(direction!=="WAIT"&&confidence<35)warnings.push("Signal confidence is low.");
 return {schemaVersion:1,generatedAt:Date.now(),symbol:input.symbol.toUpperCase(),venue:input.venue||"bitget",market:input.market||"futures",category:input.category||"USDT-FUTURES",direction,score,confidence,regime:primary.volatility>3?"high_volatility":primary.trend>0.25?"uptrend":primary.trend< -0.25?"downtrend":"range_or_transition",entry,stop,target1,riskReward:atrValue?1.5:null,scoreParts,indicators:primary.indicators,orderFlow:flow,timeframes:tfVotes,supportResistanceHeatmap:zones,positionPlan:position,riskProfile:{...risk,riskBudget:risk.capital*risk.riskPercent/100,maxMargin:risk.capital*risk.maxMarginPercent/100,compounding:"Realized PnL updates the equity base for the next trade; unrealized PnL is excluded."},warnings,execution:"analysis_only",disclaimer:"Signals are analytical outputs, not guaranteed outcomes. Risk and liquidation estimates are conservative planning proxies; exchange liquidation depends on maintenance margin, fees, funding, account mode and position tiers."};
}
