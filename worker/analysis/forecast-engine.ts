/**
 * ETI probabilistic forecast scenarios.
 * Statistical scenarios only; probabilities are heuristic, not calibrated trade odds.
 */
export interface ForecastCandle { time:number; open:number; high:number; low:number; close:number; volume?:number }
export type ForecastHorizon = "1h"|"4h"|"1d";
export interface ScenarioForecast {
  horizon: ForecastHorizon; horizonMs:number; asOf:number; expiresAt:number;
  referencePrice:number; expectedPrice:number; rangeLow:number; rangeHigh:number;
  upProbability:number; downProbability:number; neutralProbability:number;
  directionalBias:"bullish"|"bearish"|"neutral";
  confidence:number; confidenceLabel:"low"|"moderate"|"high";
  sampleCount:number; volatilityPct:number; driftPct:number; stale:boolean;
}
const HORIZONS:Record<ForecastHorizon,number>={"1h":3600000,"4h":14400000,"1d":86400000};
const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
const finite=(x:unknown):x is number=>typeof x==="number"&&Number.isFinite(x);
const normalCdf=(x:number)=>1/(1+Math.exp(-1.702*x));
export function validateForecastCandles(input:unknown):ForecastCandle[]{
 if(!Array.isArray(input)||input.length<20||input.length>500)throw new Error("candles_require_20_to_500");
 const out=input.map((x:any)=>({time:Number(x?.time),open:Number(x?.open),high:Number(x?.high),low:Number(x?.low),close:Number(x?.close),volume:x?.volume==null?undefined:Number(x.volume)}));
 for(const c of out)if(![c.time,c.open,c.high,c.low,c.close].every(finite)||c.time<=0||c.low<=0||c.high<c.low||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||(c.volume!==undefined&&(!finite(c.volume)||c.volume<0)))throw new Error("invalid_candle");
 for(let i=1;i<out.length;i++)if(out[i].time<=out[i-1].time)throw new Error("candles_not_chronological");
 return out;
}
export function forecastScenarios(input:unknown,now=Date.now(),horizons:ForecastHorizon[]=["1h","4h","1d"]):ScenarioForecast[]{
 const candles=validateForecastCandles(input),last=candles[candles.length-1];
 const returns=candles.slice(1).map((c,i)=>Math.log(c.close/candles[i].close)).filter(finite);
 const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
 const variance=returns.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,returns.length-1);
 const sigma=Math.sqrt(Math.max(variance,1e-12));
 const gaps=candles.slice(1).map((c,i)=>c.time-candles[i].time).sort((a,b)=>a-b);
 const interval=gaps[Math.floor(gaps.length/2)]||3600000;
 const staleAge=Math.max(0,now-last.time), stale=staleAge>interval*2.5;
 const sampleQuality=clamp(returns.length/120,0,1);
 const freshness=stale?0:clamp(1-staleAge/(interval*2.5),0,1);
 const volQuality=clamp(1-Math.abs(Math.log(Math.max(sigma,1e-6)/0.01))/5,0,1);
 return [...new Set(horizons)].filter(h=>h in HORIZONS).map(h=>{
  const ms=HORIZONS[h],steps=Math.max(1,ms/interval),drift=mean*steps,vol=sigma*Math.sqrt(steps);
  const expected=last.close*Math.exp(drift);
  const z=vol>0?drift/vol:0,up=normalCdf(z),down=1-up;
  const neutralBand=Math.min(0.35,Math.max(0.08,vol*0.25));
  const neutral=clamp(normalCdf((neutralBand-drift)/Math.max(vol,1e-9))-normalCdf((-neutralBand-drift)/Math.max(vol,1e-9)),0,1);
  const scale=1-neutral,upPct=clamp(up*scale,0,1),downPct=clamp(down*scale,0,1);
  const conf=clamp((25+40*sampleQuality+25*freshness+10*volQuality)*Math.exp(-ms/(72*3600000)),0,100);
  return {horizon:h,horizonMs:ms,asOf:last.time,expiresAt:now+Math.max(5*60000,Math.min(ms/3,4*3600000)),referencePrice:last.close,expectedPrice:expected,rangeLow:last.close*Math.exp(drift-1.28*vol),rangeHigh:last.close*Math.exp(drift+1.28*vol),upProbability:Math.round(upPct*100),downProbability:Math.round(downPct*100),neutralProbability:Math.round(neutral*100),directionalBias:Math.abs(upPct-downPct)<0.12?"neutral":upPct>downPct?"bullish":"bearish",confidence:Math.round(conf),confidenceLabel:conf>=70?"high":conf>=45?"moderate":"low",sampleCount:returns.length,volatilityPct:vol*100,driftPct:drift*100,stale};
 });
}
