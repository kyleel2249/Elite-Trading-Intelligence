import {scoreWalletFlows} from "./whale-intelligence.ts";
const json=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
export function withWhaleIntel<E>(base:any):any{return {fetch(req:Request,env:E){if(new URL(req.url).pathname==="/api/intelligence/whales")return handleWhales(req);return base.fetch(req,env);}}}
export function handleWhales(req:Request):Response|Promise<Response>{if(req.method!=="POST")return json({error:"method_not_allowed"},405);return req.json().then((b:any)=>{try{return json({ok:true,analysis:scoreWalletFlows(b?.flows)});}catch(e){return json({error:e instanceof Error?e.message:"invalid_input"},400);}}).catch(()=>json({error:"malformed_json"},400));}
