import { analyzeMultiTimeframe } from "./smc-multitimeframe.ts";
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
export function withAdvancedSmc<E>(base:App<E>):App<E>{return {fetch(request,env){if(new URL(request.url).pathname==="/api/advanced/smc")return handleAdvancedSmc(request);return base.fetch(request,env);}}}

const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
export function handleAdvancedSmc(request:Request):Response|Promise<Response>{
 const path=new URL(request.url).pathname;if(path!=="/api/advanced/smc")return new Response("Not found",{status:404});
 if(request.method!=="POST")return json({error:"method_not_allowed",allowed:"POST"},405);
 return request.json().then((body:any)=>{if(!body||typeof body!=="object"||Array.isArray(body)||!body.timeframes||typeof body.timeframes!=="object"||Array.isArray(body.timeframes))return json({error:"invalid_payload",expected:{timeframes:{"5m":"array of OHLCV candles","1h":"array of OHLCV candles"}}},400);
 const keys=Object.keys(body.timeframes);if(keys.length>7||keys.some(k=>!["1m","5m","15m","30m","1h","4h","1d"].includes(k)))return json({error:"unsupported_timeframe"},400);
 try{return json({ok:true,analysis:analyzeMultiTimeframe(body.timeframes)});}catch(e){const msg=e instanceof Error?e.message:"analysis_failed";return json({error:msg},400);}}).catch(()=>json({error:"malformed_json"},400));
}
