/**
 * ETI execution gateway: paper/testnet by default; live is separately gated.
 * No withdrawal, transfer, funding or wallet-management endpoints are exposed.
 */
import { readinessForOrder } from "./readiness/api.ts";
import { authenticate, can, constantTimeEqual, rateLimit, type EnvScope } from "./auth/session.ts";
import { credentialReport, markInvalid } from "./auth/credentials.ts";
import { loadMinuteBars } from "./algo/market-inputs.ts";
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
  /** Cloudflare secret used to sign execution sessions (a random key is kept in KV when unset). */
  ETI_SESSION_SECRET?: string;
  ETI_SESSION_SECRET_PREVIOUS?: string;
  /** off | paper | paper_testnet (default). */
  ETI_AUTO_SESSIONS?: string;
  ETI_KEY_ROTATION_DAYS?: string;
  ETI_ROUND_TRIP_COST_BPS?: string;
}
export const EXEC_ENVIRONMENTS = ["internal_paper","exchange_testnet","live"] as const;
export type ExecEnvironment = typeof EXEC_ENVIRONMENTS[number];
export interface ExecDeps { now?: () => number; fetchImpl?: typeof fetch; priceOf?: (symbol: string) => Promise<number | null> }
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
async function secretEquals(a: string, b: string): Promise<boolean> {
  if(a.length!==b.length) return false;
  const [x,y]=await Promise.all([a,b].map(v=>crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))));
  return constantTimeEqual(new Uint8Array(x),new Uint8Array(y));
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
export async function handleExecution(req: Request, env: ExecutionEnv, deps: ExecDeps = {}): Promise<Response> {
  const url=new URL(req.url), now=(deps.now??Date.now)();
  if(url.pathname==="/api/execution/status" && req.method==="GET") {
    return reply({mode:"paper_testnet_default",live_trading_enabled:env.ETI_LIVE_TRADING_ENABLED==="true",paper_risk_gate_required:false,live_risk_gate_configured:!!(env.ETI_RISK_GATE_URL&&env.ETI_RISK_GATE_TOKEN),readiness_gate:["off","enforce"].includes((env.ETI_READINESS_GATE||"").toLowerCase())?(env.ETI_READINESS_GATE||"").toLowerCase():"advisory",live_activation_configured:!!env.ETI_LIVE_ACTIVATION_TOKEN,alpaca_paper_configured:!!(env.ALPACA_API_KEY&&env.ALPACA_SECRET_KEY),binance_testnet_configured:!!(env.BINANCE_API_KEY&&env.BINANCE_SECRET_KEY),live_credentials_configured:!!(env.ALPACA_LIVE_API_KEY&&env.ALPACA_LIVE_SECRET_KEY&&env.BINANCE_LIVE_API_KEY&&env.BINANCE_LIVE_SECRET_KEY),alpaca_live_configured:!!(env.ALPACA_LIVE_API_KEY&&env.ALPACA_LIVE_SECRET_KEY),binance_live_configured:!!(env.BINANCE_LIVE_API_KEY&&env.BINANCE_LIVE_SECRET_KEY),audit_log_configured:!!env.ETI_EXECUTION_LOG,kill_switch:env.ETI_KILL_SWITCH==="true",withdrawal_permissions:false,transfers:false,internal_paper_available:true,auto_sessions:(env.ETI_AUTO_SESSIONS||"paper_testnet")});
  }
  if(url.pathname==="/api/execution/history") {
    if(req.method!=="GET") return reply({error:"method_not_allowed"},405);
    const auth=await authenticate(req,env,now);
    if(!auth.master&&auth.scopes.size===0) return reply({error:"unauthorized"},401);
    if(!env.ETI_EXECUTION_LOG) return reply({error:"audit_log_not_configured"},503);
    // Separate records per environment. A session sees only its own environment; the master token may ask for any.
    const asked=url.searchParams.get("environment");
    const allowed:ExecEnvironment[]=auth.master?[...EXEC_ENVIRONMENTS]:[...(auth.scopes.has("paper")?["internal_paper" as const]:[]),...(auth.scopes.has("testnet")?["exchange_testnet" as const]:[])];
    const want:ExecEnvironment[]=asked&&(allowed as string[]).includes(asked)?[asked as ExecEnvironment]:allowed;
    const prefixes=want.map(e=>e==="internal_paper"?"exec:paper:rec:":e==="live"?"exec:live:rec:":"order:");
    const lists=await Promise.all(prefixes.map(prefix=>env.ETI_EXECUTION_LOG!.list({prefix,limit:100})));
    const records=await Promise.all(lists.flatMap(l=>l.keys).map(async key=>JSON.parse((await env.ETI_EXECUTION_LOG!.get(key.name))||"null")));
    const environmentOf=(r:any):ExecEnvironment=>r.environment||(r.mode==="live"?"live":r.mode==="internal_paper"?"internal_paper":"exchange_testnet");
    return reply({environments:want,records:records.filter(Boolean).filter((r:any)=>want.includes(environmentOf(r))).sort((a:any,b:any)=>b.executedAt.localeCompare(a.executedAt)).slice(0,100)});
  }
  if(url.pathname!=="/api/orders" && url.pathname!=="/api/orders/live") return reply({error:"not_found"},404);
  if(req.method!=="POST") return reply({error:"method_not_allowed"},405);
  if(env.ETI_KILL_SWITCH==="true") return reply({error:"execution_disabled",reason:"Emergency kill switch is active"},423);
  const auth=await authenticate(req,env,now);
  if(!auth.master&&auth.scopes.size===0) return reply({error:"unauthorized",message:"No valid ETI session or execution token. Open the dashboard to start an automatic session."},401);
  const requestedLive=url.pathname==="/api/orders/live";
  // Live is never reachable through a session: it needs the master token AND the activation secret AND the Worker live switch.
  if(requestedLive && !auth.master) return reply({error:"live_requires_master_credentials",message:"Sessions can never authorise live orders."},403);
  if(requestedLive) {
    const supplied=req.headers.get("x-eti-live-authorization")||"";
    const expected=env.ETI_LIVE_ACTIVATION_TOKEN||"";
    const same=!!expected&&await secretEquals(supplied,expected);
    if(env.ETI_LIVE_TRADING_ENABLED!=="true" || !expected || !same)
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
  if(!["alpaca","binance","eti_paper"].includes(broker) || (requestedLive&&broker==="eti_paper") || !/^[A-Z0-9._-]{2,24}$/.test(symbol) ||
    !["buy","sell"].includes(side) || !["market","limit"].includes(type) ||
    !Number.isFinite(quantity) || quantity<=0 || !safeOrderId(clientOrderId) || !riskConfirmed)
    return reply({error:"invalid_order",message:"Provide broker, symbol, buy/sell, market/limit, positive quantity, unique clientOrderId (8–36 safe characters), and riskConfirmed:true after user review."},400);
  const internal=broker==="eti_paper", needScope:EnvScope=internal?"paper":"testnet";
  if(!requestedLive && !can(auth,needScope)) return reply({error:"environment_scope_mismatch",required_session:needScope,message:internal?"Internal paper orders need an INTERNAL PAPER session.":"Exchange testnet orders need an EXCHANGE TESTNET session. Sessions are isolated per environment."},403);
  if(!auth.master){ const rl=await rateLimit(env,"order:"+(auth.refs[needScope]||"anon"),60,600,now); if(!rl.ok) return reply({error:"rate_limited",message:"Too many orders from this session; wait and retry."},429); }
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
      gateResponse=await (deps.fetchImpl??fetch)(gateUrl,{method:"POST",headers:{"content-type":"application/json","x-api-key":gateToken},body:JSON.stringify({
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
  const authRef:any={kind:auth.master?"master_token":"session",sessionRef:auth.master?null:(auth.refs[needScope]||null)};
  const execSource={actorType:source.actorType,actorId:source.actorId,sourceName:source.sourceName,strategyId:source.strategyId??null,signalId:source.signalId??null,triggerReason:source.triggerReason??null};
  /** ETI INTERNAL PAPER: simulated fill at the live public price. No exchange or broker is contacted and none is claimed. */
  const fillInternal=async(fallback:any):Promise<Response>=>{
    if(await env.ETI_EXECUTION_LOG!.get("exec:paper:id:"+clientOrderId)) return reply({error:"duplicate_client_order_id"},409);
    let px:number|null=null;
    try { px=deps.priceOf?await deps.priceOf(symbol):(await loadMinuteBars(env as any,symbol,null,now)).price; } catch { px=null; }
    if(!(typeof px==="number"&&px>0)) return reply({error:"price_unavailable",exchangeOrderPlaced:false,message:"No fresh public market price for "+symbol+". Internal paper fills need one (crypto symbols are supported)."},503);
    const half=(Number(env.ETI_ROUND_TRIP_COST_BPS??"10")||10)/2/10000;
    let fillPrice:number;
    if(type==="limit") {
      const lp=num(body.limitPrice);
      if(!(side==="buy"?lp>=px:lp<=px)) return reply({error:"limit_not_marketable",exchangeOrderPlaced:false,marketPrice:px,message:"Internal paper fills only marketable limit orders; resting orders are not simulated."},422);
      fillPrice=side==="buy"?Math.min(lp,px*(1+half)):Math.max(lp,px*(1-half));
    } else fillPrice=side==="buy"?px*(1+half):px*(1-half);
    const executedAt=new Date(now).toISOString();
    const rec={executedAt,broker:"eti_paper",environment:"internal_paper",mode:"internal_paper",simulated:true,exchangeOrderPlaced:false,symbol,side,type,quantity,clientOrderId,marketPrice:px,fillPrice,notionalUsd:fillPrice*quantity,costModelBps:half*2*10000,readiness:readinessEvidence,brokerOrderId:"paper-"+clientOrderId,fallback,executionSource:execSource,auth:authRef,riskGateEvidence};
    await env.ETI_EXECUTION_LOG!.put("exec:paper:rec:"+executedAt+":"+clientOrderId,JSON.stringify(rec),{expirationTtl:60*60*24*90});
    await env.ETI_EXECUTION_LOG!.put("exec:paper:id:"+clientOrderId,"1",{expirationTtl:60*60*24*90});
    return reply({ok:true,broker:"eti_paper",mode:"internal_paper",environment:"internal_paper",simulated:true,exchangeOrderPlaced:false,fill:{price:fillPrice,marketPrice:px,quantity,notionalUsd:fillPrice*quantity},fallback,
      notice:fallback?"Exchange credentials unavailable ("+fallback.reason+"): this order was filled in ETI INTERNAL PAPER mode. No exchange testnet order was placed.":"Simulated fill in ETI internal paper mode. No exchange was contacted.",executionSource:execSource,executedAt,live_trading:false,readiness:readinessEvidence},201);
  };
  if(internal) return fillInternal(null);
  // Sessions (and API clients that set fallbackToPaper:true) fall back to internal paper when exchange credentials are missing or rejected.
  const allowFallback=!requestedLive&&(!auth.master||body.fallbackToPaper===true);
  if(allowFallback) {
    const rep=await credentialReport(env as any,broker,{validate:true,fetchImpl:deps.fetchImpl,now});
    if(rep.status==="missing"||rep.status==="invalid") return fillInternal({from:rep.environment,reason:rep.status==="missing"?"exchange_credentials_missing":"exchange_credentials_invalid"});
  }
  try {
    let result:any, mode:string;
    if(broker==="alpaca") {
      const apiKey=requestedLive?env.ALPACA_LIVE_API_KEY:env.ALPACA_API_KEY;
      const secret=requestedLive?env.ALPACA_LIVE_SECRET_KEY:env.ALPACA_SECRET_KEY;
      if(!apiKey||!secret) return reply({error:"broker_not_configured",broker,mode:requestedLive?"live":"paper"},503);
      const payload:any={symbol,qty:String(quantity),side,type,time_in_force:body.timeInForce==="gtc"?"gtc":"day",client_order_id:clientOrderId};
      if(type==="limit") payload.limit_price=String(body.limitPrice);
      const r=await (deps.fetchImpl??fetch)(requestedLive?"https://api.alpaca.markets/v2/orders":"https://paper-api.alpaca.markets/v2/orders",{method:"POST",headers:{"content-type":"application/json","APCA-API-KEY-ID":apiKey,"APCA-API-SECRET-KEY":secret},body:JSON.stringify(payload)});
      const data=await r.json().catch(()=>({}));
      if(!r.ok&&allowFallback&&(r.status===401||r.status===403)){ await markInvalid(env as any,"alpaca",now); return fillInternal({from:"alpaca_paper",reason:"exchange_credentials_invalid"}); }
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
    const r=await (deps.fetchImpl??fetch)(requestedLive?"https://api.binance.com/api/v3/order":"https://testnet.binance.vision/api/v3/order",{method:"POST",headers:{"X-MBX-APIKEY":apiKey,"content-type":"application/x-www-form-urlencoded"},body:params.toString()});
    const data=await r.json().catch(()=>({}));
    if(!r.ok&&allowFallback&&(r.status===401||[-2014,-2015,-1022].includes(Number(data?.code)))){ await markInvalid(env as any,"binance",now); return fillInternal({from:"binance_testnet",reason:"exchange_credentials_invalid"}); }
    if(!r.ok) return reply({error:"broker_rejected",broker,status:r.status,detail:data,mode:requestedLive?"live":"testnet"},502);
    result=data; mode=requestedLive?"live":"testnet";
    }
    const record={executedAt:new Date(now).toISOString(),environment:requestedLive?"live":"exchange_testnet",simulated:false,exchangeOrderPlaced:true,auth:authRef,broker,mode,symbol,side,type,quantity,clientOrderId,readiness:readinessEvidence,brokerOrderId:result?.id??result?.orderId??null,executionSource:execSource,riskGateEvidence,order:result};
    await env.ETI_EXECUTION_LOG!.put((requestedLive?"exec:live:rec:":"order:")+record.executedAt+":"+clientOrderId,JSON.stringify(record),{expirationTtl:60*60*24*90});
    return reply({ok:true,broker,mode,order:result,executionSource:record.executionSource,executedAt:record.executedAt,live_trading:requestedLive,readiness:readinessEvidence},201);
  } catch(e) { return reply({error:"execution_upstream_error",message:e instanceof Error?e.message:"Unknown error"},502); }
}
