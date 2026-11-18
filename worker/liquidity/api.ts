import { analyzeLiquidity, type LiquidityInput } from "./engine.ts";
const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers});}
export async function handleLiquidity(request:Request):Promise<Response>{
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{...headers,"access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"content-type"}});
 if(request.method!=="POST")return json({error:"method_not_allowed"},405);
 const length=Number(request.headers.get("content-length")||0);if(length>500000)return json({error:"payload_too_large"},413);
 let body:any;try{body=await request.json();}catch{return json({error:"invalid_json"},400);}
 if(!body||typeof body!=="object"||typeof body.symbol!=="string"||!/^[A-Z0-9]{3,24}$/i.test(body.symbol))return json({error:"invalid_symbol"},400);
 const depth=body.depth,previousDepth=body.previousDepth||null;
 if(!depth||!Array.isArray(depth.bids)||!Array.isArray(depth.asks))return json({error:"depth_required"},400);
 if(depth.bids.length>200||depth.asks.length>200)return json({error:"depth_limit_exceeded"},413);
 const trades=Array.isArray(body.trades)?body.trades.slice(0,300):[];
 const candles=Array.isArray(body.candles)?body.candles.slice(-100):[];
 try{
  const result=analyzeLiquidity({symbol:body.symbol,venue:String(body.venue||"unknown").slice(0,20),market:String(body.market||"spot").slice(0,20),category:body.category?String(body.category).slice(0,30):undefined,depth,previousDepth,trades,candles} as LiquidityInput);
  return json(result);
 }catch(e){return json({error:"liquidity_analysis_failed",detail:e instanceof Error?e.message:"invalid_market_data"},422);}
}
