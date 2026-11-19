/** ETI multi-timeframe Smart Money Structure analysis. Pure candle analysis only; no orders. */
export interface Candle {time:number;open:number;high:number;low:number;close:number;volume?:number}
export type StructureEvent={kind:"BOS"|"CHoCH";direction:"bullish"|"bearish";price:number;time:number;level:number}
export type FairValueGap={direction:"bullish"|"bearish";top:number;bottom:number;mid:number;time:number;filled:boolean}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
export function validateCandles(input:unknown,max=500):Candle[] {
 if(!Array.isArray(input)||input.length<20||input.length>max)throw new Error("candles_require_20_to_500");
 const rows=input.map((c:any)=>({time:Number(c?.time),open:Number(c?.open),high:Number(c?.high),low:Number(c?.low),close:Number(c?.close),volume:c?.volume==null?undefined:Number(c.volume)}));
 for(const c of rows)if(![c.time,c.open,c.high,c.low,c.close].every(finite)||c.time<=0||c.low<=0||c.high<c.low||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||(c.volume!==undefined&&(!finite(c.volume)||c.volume<0)))throw new Error("invalid_candle");
 for(let i=1;i<rows.length;i++)if(rows[i].time<=rows[i-1].time)throw new Error("candles_not_chronological");
 return rows;
}
export function findSwingPoints(c:Candle[],strength=2){
 const highs:{index:number;price:number;time:number}[]=[],lows:{index:number;price:number;time:number}[]=[];
 for(let i=strength;i<c.length-strength;i++){
  let high=true,low=true;for(let j=i-strength;j<=i+strength;j++){if(j===i)continue;if(c[j].high>=c[i].high)high=false;if(c[j].low<=c[i].low)low=false;}
  if(high)highs.push({index:i,price:c[i].high,time:c[i].time});if(low)lows.push({index:i,price:c[i].low,time:c[i].time});
 }
 return {highs,lows};
}
export function detectStructure(c:Candle[],swings=findSwingPoints(c)){
 const events:StructureEvent[]=[];let lastHigh:typeof swings.highs[number]|null=null,lastLow:typeof swings.lows[number]|null=null,lastDirection:"bullish"|"bearish"|null=null;
 for(let i=0;i<c.length;i++){for(const s of swings.highs)if(s.index===i)lastHigh=s;for(const s of swings.lows)if(s.index===i)lastLow=s;
  const close=c[i].close;if(lastHigh&&close>lastHigh.price){events.push({kind:lastDirection==="bearish"?"CHoCH":"BOS",direction:"bullish",price:close,time:c[i].time,level:lastHigh.price});lastDirection="bullish";lastHigh=null;}
  else if(lastLow&&close<lastLow.price){events.push({kind:lastDirection==="bullish"?"CHoCH":"BOS",direction:"bearish",price:close,time:c[i].time,level:lastLow.price});lastDirection="bearish";lastLow=null;}
 }
 return {events,lastDirection,latest:events.at(-1)||null,swings};
}
export function detectFairValueGaps(c:Candle[]):FairValueGap[]{
 const gaps:FairValueGap[]=[];
 for(let i=2;i<c.length;i++){const a=c[i-2],z=c[i];if(z.low>a.high){const top=z.low,bottom=a.high;gaps.push({direction:"bullish",top,bottom,mid:(top+bottom)/2,time:c[i-1].time,filled:c.slice(i+1).some(x=>x.low<=top&&x.high>=bottom)});}else if(z.high<a.low){const top=a.low,bottom=z.high;gaps.push({direction:"bearish",top,bottom,mid:(top+bottom)/2,time:c[i-1].time,filled:c.slice(i+1).some(x=>x.low<=top&&x.high>=bottom)});}}
 return gaps.slice(-30);
}
export function analyzeTimeframe(input:unknown,timeframe:string){
 const c=validateCandles(input),swings=findSwingPoints(c),structure=detectStructure(c,swings),gaps=detectFairValueGaps(c),last=c.at(-1)!,prev=c.at(-2)!;
 const avgRange=c.slice(-20).reduce((s,x)=>s+(x.high-x.low),0)/20;
 const price=last.close,atrPct=price>0?avgRange/price*100:0;
 const activeGaps=gaps.filter(g=>!g.filled),nearestGap=[...activeGaps].sort((a,b)=>Math.abs(a.mid-price)-Math.abs(b.mid-price))[0]||null;
 const direction=structure.lastDirection??(last.close>prev.close?"bullish":"bearish");
 const recent=structure.events.at(-1),trend=recent?.direction||direction;
 const pivotHigh=swings.highs.at(-1)?.price??null,pivotLow=swings.lows.at(-1)?.price??null;
 const position=pivotHigh!==null&&pivotLow!==null&&pivotHigh>pivotLow?(price-pivotLow)/(pivotHigh-pivotLow):null;
 const zone=position===null?"unknown":position>=.5?"premium":"discount";
 const score=Math.min(100,Math.max(0,50+(trend==="bullish"?15:-15)+(recent?.kind==="BOS"?10:recent?.kind==="CHoCH"?5:0)+(nearestGap&&nearestGap.direction===trend?10:0)+(zone==="discount"&&trend==="bullish"?5:zone==="premium"&&trend==="bearish"?5:0)-(atrPct>5?10:0)));
 return {timeframe,lastPrice:price,trendBias:trend,structure:structure.events.slice(-8),latestStructure:recent,swings:{lastHigh:pivotHigh,lastLow:pivotLow},fairValueGaps:gaps,nearestUnfilledFvg:nearestGap,premiumDiscount:zone,rangePct:Number(atrPct.toFixed(3)),confidenceScore:Math.round(score),signal:recent&&score>=65?(trend==="bullish"?"bullish":"bearish"):"neutral",candleCount:c.length,asOf:last.time,notes:["Structure uses candle closes through detected swing levels.","FVGs use a three-candle imbalance heuristic; order-block identification is not claimed without validation.","Confidence score is a confluence heuristic, not a calibrated probability."]};
}
export function analyzeMultiTimeframe(input:Record<string,unknown>){
 const allowed=["1m","5m","15m","30m","1h","4h","1d"],entries=Object.entries(input).filter(([tf])=>allowed.includes(tf));
 if(entries.length<1||entries.length>allowed.length)throw new Error("timeframes_missing_or_invalid");
 const results=entries.map(([tf,c])=>analyzeTimeframe(c,tf));
 const bullish=results.filter(x=>x.signal==="bullish").length,bearish=results.filter(x=>x.signal==="bearish").length,neutral=results.length-bullish-bearish;
 const overall=bullish>bearish?"bullish":bearish>bullish?"bearish":"neutral",aligned=results.filter(x=>x.trendBias===overall&&overall!=="neutral").length;
 const score=Math.round(results.reduce((s,x)=>s+x.confidenceScore,0)/results.length);
 return {overallBias:overall,confluenceScore:score,alignmentPct:Math.round(aligned/results.length*100),bullishTimeframes:bullish,bearishTimeframes:bearish,neutralTimeframes:neutral,conflict:bullish>0&&bearish>0,timeframes:results,summary:overall==="neutral"?"Timeframes are mixed or lack sufficient structure. Wait for clearer confirmation.":aligned===results.length?"All submitted timeframes align; use execution-level confirmation and defined risk.":"Timeframes partially align; reduce confidence and wait for execution confirmation.",disclaimer:"Analytical signal only. Not financial advice and not an execution command."};
}
