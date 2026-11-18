import type { Kline } from "../market.ts";

export type DivergenceKind = "regular_bullish" | "hidden_bullish" | "regular_bearish" | "hidden_bearish" | "none";
export interface DivergencePivot { index: number; time: number; price: number; rsi: number }
export interface DivergenceResult {
  status: "detected" | "none" | "insufficient_data";
  kind: DivergenceKind;
  direction: -1 | 0 | 1;
  strength: number;
  previous: DivergencePivot | null;
  current: DivergencePivot | null;
  note: string;
}
type PivotKind = "high" | "low";
const clamp = (n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
const empty = (status:DivergenceResult["status"],note:string):DivergenceResult=>({status,kind:"none",direction:0,strength:0,previous:null,current:null,note});

function pivots(rows:Kline[],rsi:number[],kind:PivotKind,left:number,right:number,lookback:number):DivergencePivot[]{
  const out:DivergencePivot[]=[];
  const start=Math.max(left,rows.length-lookback),end=rows.length-right;
  for(let i=start;i<end;i++){
    const price=kind==="high"?rows[i][2]:rows[i][3],osc=rsi[i];
    if(!Number.isFinite(price)||!Number.isFinite(osc))continue;
    let confirmed=true;
    for(let j=i-left;j<=i+right;j++){
      if(j===i)continue;
      const other=kind==="high"?rows[j][2]:rows[j][3];
      if(kind==="high"?other>=price:other<=price){confirmed=false;break;}
    }
    if(confirmed)out.push({index:i,time:rows[i][0],price,rsi:osc});
  }
  return out;
}

/** Uses only confirmed local pivots. The right-hand confirmation bars must already be closed. */
export function detectDivergence(rows:Kline[],rsi:number[],options:{left?:number;right?:number;lookback?:number;minimumPriceChangePct?:number;minimumRsiChange?:number}={}):DivergenceResult{
  if(!Array.isArray(rows)||!Array.isArray(rsi)||rows.length!==rsi.length||rows.length<30)return empty("insufficient_data","At least 30 aligned closed candles and RSI observations are required.");
  const left=Math.max(2,Math.min(8,Math.floor(options.left??3))),right=Math.max(2,Math.min(8,Math.floor(options.right??3)));
  const lookback=Math.max(30,Math.min(200,Math.floor(options.lookback??80))),minPrice=Math.max(0.01,options.minimumPriceChangePct??0.1),minRsi=Math.max(0.5,options.minimumRsiChange??2);
  const candidates:{kind:DivergenceKind;direction:-1|1;strength:number;previous:DivergencePivot;current:DivergencePivot}[]=[];
  for(const side of ["low","high"] as const){
    const ps=pivots(rows,rsi,side,left,right,lookback);
    if(ps.length<2)continue;
    const current=ps[ps.length-1],previous=[...ps].reverse().slice(1).find(p=>current.index-p.index>=5&&current.index-p.index<=50);
    if(!previous)continue;
    const priceChangePct=(current.price/previous.price-1)*100,rsiChange=current.rsi-previous.rsi;
    let kind:DivergenceKind="none",direction:-1|1=0;
    if(side==="low"&&priceChangePct<=-minPrice&&rsiChange>=minRsi){kind="regular_bullish";direction=1;}
    else if(side==="low"&&priceChangePct>=minPrice&&rsiChange<=-minRsi){kind="hidden_bullish";direction=1;}
    else if(side==="high"&&priceChangePct>=minPrice&&rsiChange<=-minRsi){kind="regular_bearish";direction=-1;}
    else if(side==="high"&&priceChangePct<=-minPrice&&rsiChange>=minRsi){kind="hidden_bearish";direction=-1;}
    if(kind!=="none")candidates.push({kind,direction,strength:Math.round(clamp(50+Math.abs(priceChangePct)*8+Math.abs(rsiChange)*0.7,0,95)),previous,current});
  }
  candidates.sort((a,b)=>b.current.index-a.current.index);
  const found=candidates[0];
  if(!found)return empty("none","No confirmed regular or hidden price/RSI divergence was found in the configured closed-candle window.");
  return {status:"detected",kind:found.kind,direction:found.direction,strength:found.strength,previous:found.previous,current:found.current,note:"Confirmed price swing and RSI swing disagreement. Divergence is context, not a reversal guarantee."};
}
