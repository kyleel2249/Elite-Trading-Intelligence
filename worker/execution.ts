/**
 * ETI paper/testnet execution gateway.
 * Live endpoints are deliberately impossible in this module: Alpaca always uses
 * paper-api and Binance always uses Spot Testnet. No withdrawal/transfer APIs.
 */
export interface ExecutionEnv {
  ETI_EXECUTION_TOKEN?: string;
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  ETI_MAX_ORDER_QUANTITY?: string;
  ETI_KILL_SWITCH?: string;
}
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers});
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : NaN;
async function authorized(req: Request, env: ExecutionEnv): Promise<boolean> {
  const token=env.ETI_EXECUTION_TOKEN;
  const supplied=req.headers.get("authorization")?.replace(/^Bearer\\s+/i,"");
  if(!token||!supplied||supplied.length!==token.length) return false;
  const [a,b]=await Promise.all([token,supplied].map(v=>crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))));
  const aa=new Uint8Array(a),bb=new Uint8Array(b);let diff=0;
  for(let i=0;i<aa.length;i++) diff|=aa[i]^bb[i];
  return diff===0;
}
async function hmac(secret: string, query: string) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(query));
  return [...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function safeOrderId(value: unknown) {
  return typeof value==="string" && /^[A-Za-z0-9_-]{8,36}$/.test(value);
}
export async function handleExecution(req: Request, env: ExecutionEnv): Promise<Response> {
  const url=new URL(req.url);
  if(url.pathname==="/api/execution/status" && req.method==="GET") {
    return reply({mode:"paper_testnet_only",live_trading:false,alpaca_configured:!!(env.ALPACA_API_KEY&&env.ALPACA_SECRET_KEY),binance_configured:!!(env.BINANCE_API_KEY&&env.BINANCE_SECRET_KEY),kill_switch:env.ETI_KILL_SWITCH==="true",withdrawal_permissions:false});
  }
  if(url.pathname!=="/api/orders") return reply({error:"not_found"},404);
  if(req.method!=="POST") return reply({error:"method_not_allowed"},405);
  if(env.ETI_KILL_SWITCH==="true") return reply({error:"execution_disabled",reason:"Emergency kill switch is active"},423);
  if(!await authorized(req,env)) return reply({error:"unauthorized"},401);
  let body:any;
  try { body=await req.json(); } catch { return reply({error:"invalid_json"},400); }
  const broker=body?.broker, symbol=typeof body?.symbol==="string"?body.symbol.toUpperCase():"";
  const side=body?.side, type=body?.type??"market", quantity=num(body?.quantity);
  const clientOrderId=body?.clientOrderId;
  if(!["alpaca","binance"].includes(broker) || !/^[A-Z0-9._-]{2,24}$/.test(symbol) ||
    !["buy","sell"].includes(side) || !["market","limit"].includes(type) ||
    !Number.isFinite(quantity) || quantity<=0 || !safeOrderId(clientOrderId))
    return reply({error:"invalid_order",message:"Provide broker, symbol, buy/sell, market/limit, positive quantity and unique clientOrderId (8–36 safe characters)."},400);
  const maxQty=Number(env.ETI_MAX_ORDER_QUANTITY??"100");
  if(!Number.isFinite(maxQty)||maxQty<=0||quantity>maxQty) return reply({error:"risk_limit_exceeded",limit:"max_quantity",max:maxQty},403);
  if(type==="limit" && (!Number.isFinite(num(body.limitPrice)) || num(body.limitPrice)<=0))
    return reply({error:"invalid_limit_price"},400);
  if(type==="market" && body.limitPrice!==undefined) return reply({error:"unexpected_limit_price"},400);
  try {
    if(broker==="alpaca") {
      if(!env.ALPACA_API_KEY||!env.ALPACA_SECRET_KEY) return reply({error:"broker_not_configured",broker},503);
      const payload:any={symbol,qty:String(quantity),side,type,time_in_force:body.timeInForce==="gtc"?"gtc":"day",client_order_id:clientOrderId};
      if(type==="limit") payload.limit_price=String(body.limitPrice);
      const r=await fetch("https://paper-api.alpaca.markets/v2/orders",{method:"POST",headers:{"content-type":"application/json","APCA-API-KEY-ID":env.ALPACA_API_KEY,"APCA-API-SECRET-KEY":env.ALPACA_SECRET_KEY},body:JSON.stringify(payload)});
      const data=await r.json().catch(()=>({}));
      if(!r.ok) return reply({error:"broker_rejected",broker,status:r.status,detail:data,mode:"paper"},502);
      return reply({ok:true,broker,mode:"paper",order:data,live_trading:false},201);
    }
    if(!env.BINANCE_API_KEY||!env.BINANCE_SECRET_KEY) return reply({error:"broker_not_configured",broker},503);
    const params=new URLSearchParams({symbol,side:side.toUpperCase(),type:type.toUpperCase(),quantity:String(quantity),newClientOrderId:clientOrderId,timestamp:String(Date.now()),recvWindow:"5000"});
    if(type==="limit"){params.set("price",String(body.limitPrice));params.set("timeInForce",body.timeInForce==="ioc"?"IOC":"GTC");}
    const signature=await hmac(env.BINANCE_SECRET_KEY,params.toString());
    params.set("signature",signature);
    const r=await fetch("https://testnet.binance.vision/api/v3/order",{method:"POST",headers:{"X-MBX-APIKEY":env.BINANCE_API_KEY,"content-type":"application/x-www-form-urlencoded"},body:params.toString()});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) return reply({error:"broker_rejected",broker,status:r.status,detail:data,mode:"testnet"},502);
    return reply({ok:true,broker,mode:"testnet",order:data,live_trading:false},201);
  } catch(e) { return reply({error:"execution_upstream_error",message:e instanceof Error?e.message:"Unknown error"},502); }
}
