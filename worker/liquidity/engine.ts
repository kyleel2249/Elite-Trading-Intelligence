export type BookLevel = [number, number];
export interface DepthBook { bids: BookLevel[]; asks: BookLevel[]; timestamp?: number }
export interface TradePrint { time?: number; price: number; qty: number; side?: "buy" | "sell"; isBuyerMaker?: boolean }
export type Candle = [number, number, number, number, number, number];
export interface LiquidityInput {
  symbol: string; venue: string; market: string; category?: string;
  depth: DepthBook; previousDepth?: DepthBook | null; history?: DepthBook[]; trades?: TradePrint[]; candles?: Candle[];
}
export interface LiquidityLevel { price: number; qty: number; notional: number; side: "bid" | "ask"; persistence: number; classification: string }
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n));
function cleanLevels(input:unknown,side:"bid"|"ask"):BookLevel[]{
  if(!Array.isArray(input))return [];
  return input.slice(0,200).map((r:any)=>[Number(r?.[0]),Number(r?.[1])] as BookLevel)
    .filter(([p,q])=>finite(p)&&finite(q)&&p>0&&q>0)
    .sort((a,b)=>side==="bid"?b[0]-a[0]:a[0]-b[0]);
}
function median(xs:number[]):number{
  if(!xs.length)return 0;const a=xs.slice().sort((x,y)=>x-y),m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function candleSignals(rows:Candle[]){
  const c=rows.filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(finite)&&r[1]>0&&r[2]>=Math.max(r[1],r[4])&&r[3]<=Math.min(r[1],r[4])).slice(-80);
  if(c.length<4)return {sweep:null,fvg:null,structure:"unavailable",range:null};
  const last=c[c.length-1],prior=c.slice(Math.max(0,c.length-21),c.length-1);
  const high=Math.max(...prior.map(x=>x[2])),low=Math.min(...prior.map(x=>x[3]));
  let sweep:null|{direction:"bullish"|"bearish";level:number;wick:number;time:number}=null;
  if(last[2]>high&&last[4]<high)sweep={direction:"bearish",level:high,wick:last[2],time:last[0]};
  else if(last[3]<low&&last[4]>low)sweep={direction:"bullish",level:low,wick:last[3],time:last[0]};
  const a=c[c.length-3],b=c[c.length-2],z=c[c.length-1];
  let fvg:null|{direction:"bullish"|"bearish";low:number;high:number;mid:number;time:number}=null;
  if(a[2]<z[3])fvg={direction:"bullish",low:a[2],high:z[3],mid:(a[2]+z[3])/2,time:z[0]};
  else if(a[3]>z[2])fvg={direction:"bearish",low:z[2],high:a[3],mid:(z[2]+a[3])/2,time:z[0]};
  const closes=c.slice(-8).map(x=>x[4]),up=closes[closes.length-1]>closes[0],structure=up?"bullish":"bearish";
  return {sweep,fvg,structure,range:{high,low}};
}
export function analyzeLiquidity(input:LiquidityInput){
  const bids=cleanLevels(input.depth?.bids,"bid"),asks=cleanLevels(input.depth?.asks,"ask");
  if(!bids.length||!asks.length)throw new Error("valid_bid_and_ask_depth_required");
  const bestBid=bids[0][0],bestAsk=asks[0][0];
  if(bestBid>=bestAsk)throw new Error("crossed_or_locked_order_book");
  const mid=(bestBid+bestAsk)/2,spreadBps=(bestAsk-bestBid)/mid*10000;
  const previous=input.previousDepth||null,prevBids=cleanLevels(previous?.bids,"bid"),prevAsks=cleanLevels(previous?.asks,"ask");
  const history=(input.history||[]).slice(-90),historyCounts=new Map<string,number>();
  history.forEach(snapshot=>{const seen=new Set<string>();[...cleanLevels(snapshot.bids,"bid").map(x=>[x[0],x[1],"bid"] as const),...cleanLevels(snapshot.asks,"ask").map(x=>[x[0],x[1],"ask"] as const)].forEach(([p,_q,side])=>seen.add(side+":"+Math.round(p/Math.max(mid*0.0001,Number.EPSILON))));seen.forEach(key=>historyCounts.set(key,(historyCounts.get(key)||0)+1));});
  const tolerance=Math.max(mid*0.000025,Number.EPSILON),bucket=Math.max(mid*0.0001,Number.EPSILON);
  const prevMap=new Map<string,number>();
  [...prevBids.map(x=>[x[0],x[1],"bid"] as const),...prevAsks.map(x=>[x[0],x[1],"ask"] as const)].forEach(([p,q,s])=>prevMap.set(s+":"+Math.round(p/bucket),p*q));
  const trades=(input.trades||[]).filter(t=>finite(t.price)&&finite(t.qty)&&t.price>0&&t.qty>0).slice(0,300);
  let buyNotional=0,sellNotional=0;
  trades.forEach(t=>{const side=t.side||(t.isBuyerMaker?"sell":"buy");if(side==="buy")buyNotional+=t.price*t.qty;else if(side==="sell")sellNotional+=t.price*t.qty;});
  const delta=buyNotional-sellNotional,tradeTotal=buyNotional+sellNotional,deltaPct=tradeTotal?delta/tradeTotal*100:0;
  const all=[...bids.map(([p,q])=>({price:p,qty:q,notional:p*q,side:"bid" as const})),...asks.map(([p,q])=>({price:p,qty:q,notional:p*q,side:"ask" as const}))];
  const typical=median(all.map(x=>x.notional)),threshold=Math.max(typical*2.25,mid*0.00002);
  const levels:LiquidityLevel[]=all.map(x=>{
    const key=x.side+":"+Math.round(x.price/bucket),old=prevMap.get(key),persistence=historyCounts.get(key)||0;
    const nearby=trades.filter(t=>Math.abs(t.price-x.price)<=Math.max(bucket*2,t.price*0.00005));
    const traded=nearby.reduce((s,t)=>s+t.price*t.qty,0);
    let classification="normal";
    if(x.notional>=threshold)classification="large";
    if(persistence>=Math.max(3,Math.ceil(history.length*.5)))classification="persistent";
    if(old!==undefined&&x.notional>=old*1.2)classification="replenished";
    if(old!==undefined&&x.notional<old*0.35)classification="pulled";
    if(old!==undefined&&traded>=old*0.35&&x.notional<old*0.8)classification="absorbed";
    return {...x,persistence,classification};
  }).sort((a,b)=>b.notional-a.notional).slice(0,80);
  const largeBids=levels.filter(x=>x.side==="bid"&&x.notional>=threshold).sort((a,b)=>b.notional-a.notional);
  const largeAsks=levels.filter(x=>x.side==="ask"&&x.notional>=threshold).sort((a,b)=>b.notional-a.notional);
  const behaviour={persistent:levels.filter(x=>x.classification==="persistent").length,pulled:levels.filter(x=>x.classification==="pulled").length,absorbed:levels.filter(x=>x.classification==="absorbed").length,replenished:levels.filter(x=>x.classification==="replenished").length};
  const candles=candleSignals(input.candles||[]);
  const imbalance=(bids.slice(0,20).reduce((s,x)=>s+x[0]*x[1],0)-asks.slice(0,20).reduce((s,x)=>s+x[0]*x[1],0))/(bids.slice(0,20).reduce((s,x)=>s+x[0]*x[1],0)+asks.slice(0,20).reduce((s,x)=>s+x[0]*x[1],0)||1);
  const buyAligned=deltaPct>8&&imbalance>0.08,bearAligned=deltaPct< -8&&imbalance< -0.08;
  const sweep=candles.sweep, sweepAligned=!!sweep&&((sweep.direction==="bullish"&&buyAligned)||(sweep.direction==="bearish"&&bearAligned));
  const fvgAligned=!!candles.fvg&&((candles.fvg.direction==="bullish"&&buyAligned)||(candles.fvg.direction==="bearish"&&bearAligned));
  const score=clamp(Math.round((Math.min(1,Math.abs(imbalance))*20)+(Math.min(1,Math.abs(deltaPct)/40)*20)+(sweepAligned?25:sweep?8:0)+(fvgAligned?15:candles.fvg?5:0)+(Math.min(1,(largeBids.length+largeAsks.length)/5)*10)+(Math.min(1,behaviour.absorbed/3)*10)),0,100);
  const direction=sweepAligned?(sweep!.direction==="bullish"?"BUY":"SELL"):fvgAligned?(candles.fvg!.direction==="bullish"?"BUY":"SELL"):"WAIT";
  const freshness=finite(input.depth.timestamp)?Math.max(0,Date.now()-input.depth.timestamp):null;
  const warnings:string[]=[];
  if(freshness!==null&&freshness>15000)warnings.push("Order-book snapshot is stale; treat all levels as historical.");
  if(spreadBps>15)warnings.push("Spread is elevated; execution costs may invalidate a setup.");
  if(!trades.length)warnings.push("No recent trade prints supplied; absorption and delta confirmation are incomplete.");
  if(!input.candles||input.candles.length<20)warnings.push("Insufficient candle history for reliable sweep and structure checks.");
  return {
    schemaVersion:1,generatedAt:Date.now(),symbol:input.symbol.toUpperCase(),venue:input.venue,market:input.market,category:input.category||null,
    source:"exchange order-book snapshot + recent executed trades",mid,spreadBps,depth:{bidCount:bids.length,askCount:asks.length,imbalance,levels},
    walls:{bids:largeBids.slice(0,8),asks:largeAsks.slice(0,8)},behaviour,orderFlow:{buyNotional,sellNotional,delta,deltaPct,tradeCount:trades.length},
    priceAction:candles,confluence:{score,direction,setup:direction==="WAIT"?"NO_CONFIRMED_SETUP":"LIQUIDITY_CONFLUENCE_WATCH",buyAligned,bearAligned,sweepAligned,fvgAligned},
    dataQuality:{freshnessMs:freshness,previousDepthAvailable:!!previous,historicalSnapshots:history.length,tradePrints:trades.length,candleCount:(input.candles||[]).length,warnings},
    disclaimer:"Research signal only. Order-book depth is exchange-specific and can be cancelled or spoofed. This analysis does not estimate actual liquidation locations and cannot guarantee execution or profit."
  };
}
