/**
 * ETI execution gateway: paper/testnet by default; live is separately gated.
 * No withdrawal, transfer, funding or wallet-management endpoints are exposed.
 */
import { readinessForOrder } from "./readiness/api.ts";
/** off | advisory (default: readiness is recorded on every order, never blocks) | enforce (AVOID TRADING and HIGH RISK block paper and live orders; a readiness failure blocks too) */
export type ReadinessGateMode = "off" | "advisory" | "enforce";
export interface ExecutionEnv {
  ETI_READINESS_GATE?: string;
  ETI_EXECUTION_TOKEN?: string;
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  ETI_MAX_ORDER_QUANTITY?: string;
  ETI_KILL_SWITCH?: string;
  ETI_LIVE_TRADING_ENABLED?: string;
  ETI_LIVE_ACTIVATION_TOKEN?: string;
  ETI_LIVE_MAX_NOTIONAL_USD?: string;
  ETI_LIVE_MAX_ORDER_QUANTITY?: string;
  ETI_RISK_GATE_URL?: string;
  ETI_RISK_GATE_TOKEN?: string;
  ALPACA_LIVE_API_KEY?: string;
  ALPACA_LIVE_SECRET_KEY?: string;
  BINANCE_LIVE_API_KEY?: string;
  BINANCE_LIVE_SECRET_KEY?: string;
  ETI_EXECUTION_LOG?: KVNamespace;
}
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers});
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : NaN;
export async function authorized(req: Request, env: ExecutionEnv): Promise<boolean> {
  const token=env.ETI_EXECUTION_TOKEN;
  const supplied=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
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

/**
 * Fail-closed guard for live orders. Live market orders are intentionally
 * disallowed: only a user-reviewed limit order has a deterministic price cap.
 * Both caps must be explicitly configured as Worker variables.
 */
export function validateLiveOrderLimits(input: {
  type: unknown; quantity: number; limitPrice: number; env: ExecutionEnv;
}): { ok: true; notionalUsd: number } | { ok: false; reason: string } {
  if (input.type !== "limit") return { ok: false, reason: "live_limit_orders_only" };
  const maxNotional = Number(input.env.ETI_LIVE_MAX_NOTIONAL_USD ?? "");
  const maxQuantity = Number(input.env.ETI_LIVE_MAX_ORDER_QUANTITY ?? "");
  if (!Number.isFinite(maxNotional) || maxNotional <= 0)
    return { ok: false, reason: "live_notional_cap_not_configured" };
  if (!Number.isFinite(maxQuantity) || maxQuantity <= 0)
    return { ok: false, reason: "live_quantity_cap_not_configured" };
  if (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > maxQuantity)
    return { ok: false, reason: "live_quantity_limit_exceeded" };
  if (!Number.isFinite(input.limitPrice) || input.limitPrice <= 0)
    return { ok: false, reason: "live_limit_price_required" };
  const notionalUsd = input.quantity * input.limitPrice;
  if (!Number.isFinite(notionalUsd) || notionalUsd > maxNotional)
    return { ok: false, reason: "live_notional_limit_exceeded" };
  return { ok: true, notionalUsd };
}
export async function handleExecution(req: Request, env: ExecutionEnv): Promise<Response> {
  const url=new URL(req.url);
  if(url.pathname==="/api/execution/status" && req.method==="GET") {
    return reply({mode:"paper_testnet_default",live_trading_enabled:env.ETI_LIVE_TRADING_ENABLED==="true",paper_risk_gate_required:false,live_risk_gate_configured:!!(env.ETI_RISK_GATE_URL&&env.ETI_RISK_GATE_TOKEN),readiness_gate:["off","enforce"].includes((env.ETI_READINESS_GATE||"").toLowerCase())?(env.ETI_READINESS_GATE||"").toLowerCase():"advisory",live_activation_configured:!!env.ETI_LIVE_ACTIVATION_TOKEN,alpaca_paper_configured:!!(env.ALPACA_API_KEY&&env.ALPACA_SECRET_KEY),binance_testnet_configured:!!(env.BINANCE_API_KEY&&env.BINANCE_SECRET_KEY),live_credentials_configured:!!(env.ALPACA_LIVE_API_KEY&&env.ALPACA_LIVE_SECRET_KEY&&env.BINANCE_LIVE_API_KEY&&env.BINANCE_LIVE_SECRET_KEY),alpaca_live_configured:!!(env.ALPACA_LIVE_API_KEY&&env.ALPACA_LIVE_SECRET_KEY),binance_live_configured:!!(env.BINANCE_LIVE_API_KEY&&env.BINANCE_LIVE_SECRET_KEY),audit_log_configured:!!env.ETI_EXECUTION_LOG,kill_switch:env.ETI_KILL_SWITCH==="true",withdrawal_permissions:false});
  }
  if(url.pathname==="/api/execution/history") {
    if(req.method!=="GET") return reply({error:"method_not_allowed"},405);
    if(!await authorized(req,env)) return reply({error:"unauthorized"},401);
    if(!env.ETI_EXECUTION_LOG) return reply({error:"audit_log_not_configured"},503);
    const listed=await env.ETI_EXECUTION_LOG.list({prefix:"order:",limit:100});
    const records=await Promise.all(listed.keys.map(async key=>JSON.parse((await env.ETI_EXECUTION_LOG!.get(key.name))||"null")));
    return reply({records:records.filter(Boolean).sort((a,b)=>b.executedAt.localeCompare(a.executedAt))});
  }
  if(url.pathname!=="/api/orders" && url.pathname!=="/api/orders/live") return reply({error:"not_found"},404);
  if(req.method!=="POST") return reply({error:"method_not_allowed"},405);
  if(env.ETI_KILL_SWITCH==="true") return reply({error:"execution_disabled",reason:"Emergency kill switch is active"},423);
  if(!await authorized(req,env)) return reply({error:"unauthorized"},401);
  const requestedLive=url.pathname==="/api/orders/live";
  if(requestedLive) {
    const supplied=req.headers.get("x-eti-live-authorization")||"";
    const expected=env.ETI_LIVE_ACTIVATION_TOKEN||"";
    if(env.ETI_LIVE_TRADING_ENABLED!=="true" || !expected || supplied!==expected)
      return reply({error:"live_trading_locked",message:"Live trading requires the Worker live switch, separate live credentials, and the live activation secret."},423);
  }
  if(!env.ETI_EXECUTION_LOG) return reply({error:"audit_log_not_configured",message:"Configure the ETI_EXECUTION_LOG KV binding before submitting orders."},503);
  let body:any;
  try { body=await req.json(); } catch { return reply({error:"invalid_json"},400); }
  const broker=body?.broker, symbol=typeof body?.symbol==="string"?body.symbol.toUpperCase():"";
  const side=body?.side, type=body?.type??"market", quantity=num(body?.quantity);
  const clientOrderId=body?.clientOrderId;
  const riskConfirmed=body?.riskConfirmed===true;
  if(requestedLive && body?.liveConfirmed!==true) return reply({error:"live_order_confirmation_required",message:"Every live order requires liveConfirmed:true after reviewing the order preview."},400);
  const source=body?.executionSource;
  const sourceTypes=["manual_user","strategy","system","automation"];
  if(!source || !sourceTypes.includes(source.actorType) || typeof source.actorId!=="string" || !source.actorId.trim() || typeof source.sourceName!=="string" || !source.sourceName.trim())
    return reply({error:"execution_source_required",message:"Identify who or what initiated the order using executionSource.actorType, actorId and sourceName."},400);
  if(!["alpaca","binance"].includes(broker) || !/^[A-Z0-9._-]{2,24}$/.test(symbol) ||
    !["buy","sell"].includes(side) || !["market","limit"].includes(type) ||
    !Number.isFinite(quantity) || quantity<=0 || !safeOrderId(clientOrderId) || !riskConfirmed)
    return reply({error:"invalid_order",message:"Provide broker, symbol, buy/sell, market/limit, positive quantity, unique clientOrderId (8–36 safe characters), and riskConfirmed:true after user review."},400);
  const maxQty=Number(env.ETI_MAX_ORDER_QUANTITY??"100");
  if(!Number.isFinite(maxQty)||maxQty<=0||quantity>maxQty) return reply({error:"risk_limit_exceeded",limit:"max_quantity",max:maxQty},403);
  if(type==="limit" && (!Number.isFinite(num(body.limitPrice)) || num(body.limitPrice)<=0))
    return reply({error:"invalid_limit_price"},400);
  if(type==="market" && body.limitPrice!==undefined) return reply({error:"unexpected_limit_price"},400);
  if(requestedLive) {
    const liveLimits = validateLiveOrderLimits({
      type, quantity, limitPrice: num(body.limitPrice), env,
    });
    if(!liveLimits.ok) return reply({
      error: "live_risk_limit_rejected",
      reason: liveLimits.reason,
      message: "Live orders require configured server-side quantity and USD notional caps, and limit orders only.",
    }, 403);
  }
  // Paper/testnet orders do not depend on the separately hosted portfolio risk gateway.
  // Live orders remain fail-closed and still require explicit external risk approval.
  let riskGateEvidence:any = requestedLive ? null : {
    decision: "PAPER_MODE_EXTERNAL_GATE_BYPASSED",
    note: "Paper/testnet execution; no live funds are used.",
  };
  if(requestedLive) {
    const gateUrl=env.ETI_RISK_GATE_URL||"";
    const gateToken=env.ETI_RISK_GATE_TOKEN||"";
    if(!gateUrl || !gateToken)
      return reply({error:"risk_gate_not_configured",message:"Live order submission requires the ETI server-side portfolio risk preflight service."},503);
    let gateResponse:Response;
    try {
      gateResponse=await fetch(gateUrl,{method:"POST",headers:{"content-type":"application/json","x-api-key":gateToken},body:JSON.stringify({
        provider:broker,environment:"live",symbol,side,quantity,order_type:type,limit_price:body.limitPrice??null
      })});
    } catch {
      return reply({error:"risk_gate_unavailable",message:"Live order submission was blocked because ETI risk preflight could not be reached."},503);
    }
    const gateBody:any=await gateResponse.json().catch(()=>({}));
    if(!gateResponse.ok || gateBody?.approved!==true)
      return reply({error:"risk_gate_rejected",status:gateResponse.status,reasons:Array.isArray(gateBody?.reasons)?gateBody.reasons:["Server-side risk approval unavailable"]},403);
    riskGateEvidence={decision:gateBody.decision,market:gateBody.market,risk_inputs:gateBody.risk_inputs,market_research:gateBody.market_research?{council_action:gateBody.market_research.council_action,confidence:gateBody.market_research.confidence,risk_veto:gateBody.market_research.risk_veto,data_quality:gateBody.market_research.data_quality}:null,disclosure_context:{
      matched_count:gateBody.disclosure_context?.matched_count??0,
      high_impact_verified_count:gateBody.disclosure_context?.high_impact_verified_count??0
    }};
  }
  let readinessEvidence:any = null;
  {
    const raw=(env.ETI_READINESS_GATE||"advisory").toLowerCase(), gate:ReadinessGateMode=raw==="off"||raw==="enforce"?raw:"advisory";
    if(gate!=="off") {
      try {
        const r=await readinessForOrder(env as any,broker==="binance"?"crypto":"equities",symbol);
        readinessEvidence={gate,status:r.status,reasons:r.reasons,evaluated:r.evaluated,notEvaluated:r.notEvaluated,generatedAt:r.generatedAt};
        if(gate==="enforce" && (r.status==="AVOID_TRADING"||r.status==="HIGH_RISK"))
          return reply({error:"readiness_gate_rejected",message:"The ETI Market Readiness Engine advises against opening new positions now.",readiness:{status:r.status,recommendation:r.recommendation,reasons:r.reasons,blockers:r.blockers}},403);
      } catch {
        if(gate==="enforce") return reply({error:"readiness_unavailable",message:"Order blocked because the readiness check could not be completed (ETI_READINESS_GATE=enforce)."},503);
        readinessEvidence={gate,status:"unavailable"};
      }
    }
  }
  try {
    let result:any, mode:string;
    if(broker==="alpaca") {
      const apiKey=requestedLive?env.ALPACA_LIVE_API_KEY:env.ALPACA_API_KEY;
      const secret=requestedLive?env.ALPACA_LIVE_SECRET_KEY:env.ALPACA_SECRET_KEY;
      if(!apiKey||!secret) return reply({error:"broker_not_configured",broker,mode:requestedLive?"live":"paper"},503);
      const payload:any={symbol,qty:String(quantity),side,type,time_in_force:body.timeInForce==="gtc"?"gtc":"day",client_order_id:clientOrderId};
      if(type==="limit") payload.limit_price=String(body.limitPrice);
      const r=await fetch(requestedLive?"https://api.alpaca.markets/v2/orders":"https://paper-api.alpaca.markets/v2/orders",{method:"POST",headers:{"content-type":"application/json","APCA-API-KEY-ID":apiKey,"APCA-API-SECRET-KEY":secret},body:JSON.stringify(payload)});
      const data=await r.json().catch(()=>({}));
      if(!r.ok) return reply({error:"broker_rejected",broker,status:r.status,detail:data,mode:requestedLive?"live":"paper"},502);
      result=data; mode=requestedLive?"live":"paper";
    } else {
    const apiKey=requestedLive?env.BINANCE_LIVE_API_KEY:env.BINANCE_API_KEY;
    const secret=requestedLive?env.BINANCE_LIVE_SECRET_KEY:env.BINANCE_SECRET_KEY;
    if(!apiKey||!secret) return reply({error:"broker_not_configured",broker,mode:requestedLive?"live":"testnet"},503);
    const params=new URLSearchParams({symbol,side:side.toUpperCase(),type:type.toUpperCase(),quantity:String(quantity),newClientOrderId:clientOrderId,timestamp:String(Date.now()),recvWindow:"5000"});
    if(type==="limit"){params.set("price",String(body.limitPrice));params.set("timeInForce",body.timeInForce==="ioc"?"IOC":"GTC");}
    const signature=await hmac(secret,params.toString());
    params.set("signature",signature);
    const r=await fetch(requestedLive?"https://api.binance.com/api/v3/order":"https://testnet.binance.vision/api/v3/order",{method:"POST",headers:{"X-MBX-APIKEY":apiKey,"content-type":"application/x-www-form-urlencoded"},body:params.toString()});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) return reply({error:"broker_rejected",broker,status:r.status,detail:data,mode:requestedLive?"live":"testnet"},502);
    result=data; mode=requestedLive?"live":"testnet";
    }
    const record={executedAt:new Date().toISOString(),broker,mode,symbol,side,type,quantity,clientOrderId,readiness:readinessEvidence,brokerOrderId:result?.id??result?.orderId??null,executionSource:{actorType:source.actorType,actorId:source.actorId,sourceName:source.sourceName,strategyId:source.strategyId??null,signalId:source.signalId??null,triggerReason:source.triggerReason??null},riskGateEvidence,order:result};
    await env.ETI_EXECUTION_LOG!.put("order:"+record.executedAt+":"+clientOrderId,JSON.stringify(record),{expirationTtl:60*60*24*90});
    return reply({ok:true,broker,mode,order:result,executionSource:record.executionSource,executedAt:record.executedAt,live_trading:requestedLive,readiness:readinessEvidence},201);
  } catch(e) { return reply({error:"execution_upstream_error",message:e instanceof Error?e.message:"Unknown error"},502); }
}
