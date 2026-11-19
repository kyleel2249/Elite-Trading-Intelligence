import { forecastScenarios, type ForecastHorizon } from "./forecast-engine.ts";
interface App<E>{fetch(request:Request,env:E):Promise<Response>|Response}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
export function withForecastEngine<E>(base:App<E>):App<E>{return {fetch(request,env){if(new URL(request.url).pathname==="/api/forecast/scenarios")return handleForecast(request);return base.fetch(request,env);}}}
export function handleForecast(request:Request):Response|Promise<Response>{
 if(request.method!=="POST")return json({error:"method_not_allowed",allowed:"POST"},405);
 return request.json().then((body:any)=>{
  if(!body||typeof body!=="object"||Array.isArray(body)||!Array.isArray(body.candles))return json({error:"invalid_payload",expected:{candles:"20-500 OHLCV candles",horizons:["1h","4h","1d"]}},400);
  const horizons=body.horizons===undefined?["1h","4h","1d"]:body.horizons;
  if(!Array.isArray(horizons)||horizons.length>3||horizons.some((h:string)=>!["1h","4h","1d"].includes(h)))return json({error:"invalid_horizons"},400);
  try{return json({ok:true,symbol:typeof body.symbol==="string"?body.symbol.slice(0,40):null,forecasts:forecastScenarios(body.candles,Date.now(),horizons as ForecastHorizon[]),disclaimer:"Heuristic scenarios, not calibrated probabilities or trade recommendations."});}
  catch(e){return json({error:e instanceof Error?e.message:"forecast_failed"},400);}
 }).catch(()=>json({error:"malformed_json"},400));
}
