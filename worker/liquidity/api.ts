import { analyzeLiquidity, type LiquidityInput } from "./engine.ts";
import { analyzeTradingStrategy, type StrategyRiskConfig } from "./strategy.ts";
const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers});}
export async function handleLiquidity(request:Request):Promise<Response>{
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{...headers,"access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"content-type"}});
 if(request.method!=="POST")return json({error:"method_not_allowed"},405);
 const length=Number(request.headers.get("content-length")||0);if(length>500000)return json({error:"payload_too_large"},413);
 let body:any;try{const raw=await request.text();if(new TextEncoder().encode(raw).length>500000)return json({error:"payload_too_large"},413);body=JSON.parse(raw);}catch{return json({error:"invalid_json"},400);}
 if(!body||typeof body!=="object"||typeof body.symbol!=="string"||!/^[A-Z0-9]{3,24}$/i.test(body.symbol))return json({error:"invalid_symbol"},400);
 const depth=body.depth,previousDepth=body.previousDepth||null;
 if(!depth||!Array.isArray(depth.bids)||!Array.isArray(depth.asks))return json({error:"depth_required"},400);
 if(depth.bids.length>200||depth.asks.length>200)return json({error:"depth_limit_exceeded"},413);
 const trades=Array.isArray(body.trades)?body.trades.slice(0,300):[];
 const history=Array.isArray(body.history)?body.history.slice(-90):[];
 if(history.some((x:any)=>!x||!Array.isArray(x.bids)||!Array.isArray(x.asks)||x.bids.length>200||x.asks.length>200))return json({error:"invalid_depth_history"},400);
 const candles=Array.isArray(body.candles)?body.candles.slice(-500):[];
 const candlesByTimeframe:Record<string,any[]>={};
 if(body.candlesByTimeframe&&typeof body.candlesByTimeframe==="object")for(const [tf,rows] of Object.entries(body.candlesByTimeframe).slice(0,12)){if(Array.isArray(rows))candlesByTimeframe[String(tf).slice(0,8)]=(rows as any[]).slice(-500);}
 try{
  const venue=String(body.venue||"bitget").slice(0,20),market=String(body.market||"futures").slice(0,20),category=body.category?String(body.category).slice(0,30):"USDT-FUTURES";
  const liquidity=analyzeLiquidity({symbol:body.symbol,venue,market,category,depth,previousDepth,history,trades,candles:candles.slice(-100)} as LiquidityInput);
  const riskInput=body.risk&&typeof body.risk==="object"?body.risk:{};
  const risk:Partial<StrategyRiskConfig>={capital:Number(riskInput.capital??74),leverage:Number(riskInput.leverage??20),riskPercent:Number(riskInput.riskPercent??30),maxMarginPercent:Number(riskInput.maxMarginPercent??30),compoundProfits:riskInput.compoundProfits!==false,maxDailyLossPercent:Number(riskInput.maxDailyLossPercent??30)};
  const strategy=analyzeTradingStrategy({symbol:body.symbol,venue,market,category,candles,candlesByTimeframe,depth,trades,risk});
  return json({...liquidity,strategy});
 }catch(e){return json({error:"liquidity_analysis_failed",detail:e instanceof Error?e.message:"invalid_market_data"},422);}
}
