/**
 * Explicitly confirmed Bitget live order adapter (Classic V2 account endpoints).
 * This module never handles transfers or withdrawals. All orders require master ETI auth,
 * the global kill switch to be off, a unique clientOid, and riskConfirmed=true.
 */
import { bitgetCreds, bitgetSign, bitgetGetSigned } from "./api.ts";
import { readOperationalConfig, isMarketDataFresh } from "../operational-config.ts";

type BitgetMarket = "spot" | "margin-crossed" | "margin-isolated" | "usdt-futures" | "usdc-futures" | "coin-futures";
const MARKETS: BitgetMarket[] = ["spot","margin-crossed","margin-isolated","usdt-futures","usdc-futures","coin-futures"];
const BASE = "https://api.bitget.com";
const num = (v: unknown) => v === null || v === undefined || v === "" ? NaN : Number(v);
const json = (x: unknown) => JSON.stringify(x);
const headers = { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" };

export interface BitgetLiveEnv {
  BITGET_API_KEY?: string; BITGET_API_SECRET?: string; BITGET_API_PASSPHRASE?: string;
  ETI_BITGET_LIVE_ENABLED?: string; ETI_BITGET_EGRESS_VERIFIED?: string; ETI_BITGET_MAX_LEVERAGE?: string; ETI_BITGET_MAX_NOTIONAL_USDT?: string; ETI_MAX_ORDER_QUANTITY?: string;
  ETI_KILL_SWITCH?: string; ETI_EXECUTION_LOG?: { get(k:string):Promise<string|null>; put(k:string,v:string,o?:any):Promise<void> };
}
export interface BitgetLiveDeps { fetchImpl?: typeof fetch; now?:()=>number }
type Sent = { ok:true; data:any } | { ok:false; definite:boolean; status:number; data:any };
async function post(env:BitgetLiveEnv,path:string,payload:Record<string,unknown>,deps:BitgetLiveDeps):Promise<Sent>{
  const c=bitgetCreds(env as any); if(!c.complete) return {ok:false,definite:true,status:503,data:{code:"credentials_missing",missing:c.missing}};
  const body=json(payload),ts=String((deps.now??Date.now)());
  const sign=await bitgetSign(c.secret!,ts,"POST",path,"",body);
  const requestHeaders={"ACCESS-KEY":c.key!,"ACCESS-SIGN":sign,"ACCESS-TIMESTAMP":ts,"ACCESS-PASSPHRASE":c.passphrase!,"Content-Type":"application/json","locale":"en-US"};
  const hosts=[BASE,"https://capi.bitget.com"];let last:Sent|null=null;
  for(const host of hosts){
    try {
      const r=await (deps.fetchImpl??fetch)(host+path,{method:"POST",headers:requestHeaders,body,signal:AbortSignal.timeout(12000)});
      const data=await r.json().catch(()=>({message:"Bitget returned invalid JSON"}));
      if(r.ok&&data?.code==="00000")return {ok:true,data:data.data??data};
      last={ok:false,definite:(r.status>=400&&r.status<500&&r.status!==408)||(r.ok&&data?.code!=="00000"&&String(data?.code)!=="40010"),status:r.status||502,data:{httpStatus:r.status,code:data?.code??"bitget_rejected",message:String(data?.msg??data?.message??"Bitget rejected the request").slice(0,240),data:data?.data??null}};
      if(!(r.status===403&&data?.cloudflare==="block"))return last;
    } catch(e) { return {ok:false,definite:false,status:0,data:{code:"network_outcome_unknown",message:e instanceof Error?e.message:"network failure"}}; }
  }
  return last??{ok:false,definite:false,status:502,data:{code:"network_outcome_unknown",message:"Bitget API hosts were unavailable"}};
}
const response=(body:unknown,status=200)=>new Response(json(body),{status,headers});
export async function placeBitgetLiveOrder(env:BitgetLiveEnv,body:any,deps:BitgetLiveDeps={}):Promise<Response>{
  const now=(deps.now??Date.now)(),at=new Date(now).toISOString(),kv=env.ETI_EXECUTION_LOG;
  const market=String(body?.bitgetMarket??body?.market??"spot") as BitgetMarket;
  const symbol=typeof body?.symbol==="string"?body.symbol.trim().toUpperCase():"";
  const side=String(body?.side??"").toLowerCase(),type=String(body?.type??"market").toLowerCase();
  const qty=num(body?.quantity),price=num(body?.limitPrice),clientOid=String(body?.clientOrderId??"");
  const source=body?.executionSource;
  const maxQty=num(env.ETI_MAX_ORDER_QUANTITY??"100");
  if(env.ETI_KILL_SWITCH==="true")return response({ok:false,error:"execution_disabled",broker_contacted:false},423);
  if(env.ETI_BITGET_LIVE_ENABLED!=="true")return response({ok:false,error:"bitget_live_disabled",message:"Set ETI_BITGET_LIVE_ENABLED=true after verifying the Bitget API key is trade-enabled and withdrawal-disabled."},423);
  if(env.ETI_BITGET_EGRESS_VERIFIED!=="true")return response({ok:false,error:"bitget_worker_egress_unverified",message:"Bitget live execution is fail-closed until private API connectivity from Cloudflare Workers is verified. Public market data uses the browser-direct adapter; never expose Bitget API secrets in the browser."},423);
  if(!kv)return response({ok:false,error:"audit_log_not_configured"},503);
  if(!bitgetCreds(env as any).complete)return response({ok:false,error:"credentials_missing",missing:bitgetCreds(env as any).missing},503);
  if(!(MARKETS as string[]).includes(market)||!/^[A-Z0-9]{5,24}$/.test(symbol)||!["buy","sell"].includes(side)||!["market","limit"].includes(type)||!Number.isFinite(qty)||qty<=0||!Number.isFinite(maxQty)||maxQty<=0||qty>maxQty||!/^eti[a-f0-9]{8,32}$/i.test(clientOid)||body?.riskConfirmed!==true)
    return response({ok:false,error:"invalid_order",message:"Provide a valid Bitget market, symbol, side, market/limit type, quantity within ETI_MAX_ORDER_QUANTITY, unique clientOrderId and riskConfirmed:true."},400);
  if(operationalConfig.dataQuality.requireFreshDataForLiveOrders && !isMarketDataFresh(referenceTimestamp,now,operationalConfig.dataQuality.maxAgeSeconds))
    return response({ok:false,error:"market_data_stale",brokerContacted:false,maxAgeSeconds:operationalConfig.dataQuality.maxAgeSeconds,message:"Live orders require a valid, non-future market-data timestamp within ETI configured freshness window."},409);
  if(type==="limit"&&!(Number.isFinite(price)&&price>0))return response({ok:false,error:"invalid_limit_price"},400);
  if(type==="market"&&body?.limitPrice!==undefined)return response({ok:false,error:"unexpected_limit_price"},400);
  if(!source||!["manual_user","strategy","system","automation"].includes(source.actorType)||typeof source.actorId!=="string"||!source.actorId.trim()||typeof source.sourceName!=="string"||!source.sourceName.trim())
    return response({ok:false,error:"execution_source_required"},400);
  const futures=market.endsWith("futures"),margin=market.startsWith("margin-");
  const lev=num(body?.leverage??1),maxLev=Math.min(150,Math.max(1,num(env.ETI_BITGET_MAX_LEVERAGE??"150")||150));
  if(futures&&(!Number.isInteger(lev)||lev<1||lev>maxLev))return response({ok:false,error:"invalid_leverage",message:"Leverage must be a whole number from 1x to "+maxLev+"x."},400);
  const marginMode=String(body?.marginMode??"isolated");
  if(futures&&!["crossed","isolated"].includes(marginMode))return response({ok:false,error:"invalid_margin_mode"},400);
  const productType=market==="usdt-futures"?"USDT-FUTURES":market==="usdc-futures"?"USDC-FUTURES":"COIN-FUTURES";
  const marginCoin=String(body?.marginCoin??(market==="usdt-futures"?"USDT":market==="usdc-futures"?"USDC":symbol.replace(/USD$/,""))).toUpperCase();
  const force=String(body?.timeInForce??"gtc").toLowerCase();
  if(!["gtc","ioc","fok","post_only"].includes(force))return response({ok:false,error:"invalid_time_in_force"},400);
  const tradeSide=String(body?.tradeSide??"open");
  if(futures&&!["open","close"].includes(tradeSide))return response({ok:false,error:"invalid_trade_side"},400);
  const reduceOnly=body?.reduceOnly===true;
  if(reduceOnly&&(!futures||tradeSide!=="close"))return response({ok:false,error:"invalid_reduce_only"},400);
  const quoteAmount=num(body?.quoteAmount);
  const referencePrice=num(body?.referencePrice);
  const operationalConfig=readOperationalConfig(env as any);
  const rawReferenceTimestamp=num(body?.referencePriceTimestamp);
  const referenceTimestamp=Number.isFinite(rawReferenceTimestamp)&&rawReferenceTimestamp>0
    ? (rawReferenceTimestamp<1e12?rawReferenceTimestamp*1000:rawReferenceTimestamp) : NaN;
  const stopPrice=num(body?.plan?.stop), takeProfit=num(body?.plan?.tp1);
  if(body?.plan&&!futures)return response({ok:false,error:"protective_levels_require_futures"},400);
  if(Number.isFinite(stopPrice)&&stopPrice>0&&(!(referencePrice>0)||(side==="buy"?stopPrice>=referencePrice:stopPrice<=referencePrice)))return response({ok:false,error:"invalid_stop_loss_direction",message:"For a long order, stop loss must be below entry; for a short order, it must be above entry."},400);
  if(Number.isFinite(takeProfit)&&takeProfit>0&&(!(referencePrice>0)||(side==="buy"?takeProfit<=referencePrice:takeProfit>=referencePrice)))return response({ok:false,error:"invalid_take_profit_direction",message:"For a long order, take profit must be above entry; for a short order, it must be below entry."},400);
  if((market==="spot"||margin)&&type==="market"&&side==="buy"&&!(quoteAmount>0))return response({ok:false,error:"quote_amount_required",message:"For Bitget market buys, send quoteAmount (the amount of quote currency to spend)."},400);
  const maxNotional=num(env.ETI_BITGET_MAX_NOTIONAL_USDT??"1000");
  const estimatedNotional=(market==="spot"||margin)&&type==="market"&&side==="buy"?quoteAmount:qty*(type==="limit"?price:referencePrice);
  if(!(Number.isFinite(maxNotional)&&maxNotional>0)||!(estimatedNotional>0)||estimatedNotional>maxNotional)return response({ok:false,error:"notional_limit",message:"Provide a valid reference price and keep estimated order notional within ETI_BITGET_MAX_NOTIONAL_USDT ("+maxNotional+").",estimatedNotional:Number.isFinite(estimatedNotional)?estimatedNotional:null,maxNotional},400);
  if(await kv.get("exec:live:id:"+clientOid))return response({ok:false,error:"duplicate_client_order_id",message:"This clientOrderId is already recorded; check Bitget order history before retrying."},409);
  const pending={outcome:"unknown",broker:"bitget",environment:"live",mode:"live",symbol,side,type,quantity:qty,referencePrice:Number.isFinite(referencePrice)?referencePrice:null,estimatedNotional,clientOrderId:clientOid,market,at,executionSource:source,stage:"pending",brokerContacted:false};
  // Reserve before any exchange call. Keep an indeterminate reservation if a network response is lost.
  await kv.put("exec:live:id:"+clientOid,"pending",{expirationTtl:90*86400});
  await kv.put("exec:live:rec:"+at+":"+clientOid,json(pending),{expirationTtl:90*86400});
  const record=async(outcome:string,extra:Record<string,unknown>)=>{
    const r={...pending,outcome,brokerContacted:true,...extra};
    await kv.put("exec:live:rec:"+at+":"+clientOid,json(r),{expirationTtl:90*86400});
    await kv.put("exec:live:id:"+clientOid,outcome,{expirationTtl:90*86400});
    return r;
  };
  // Futures account configuration is explicit and confirmed before the order call.
  if(futures){
    // Bitget refuses margin-mode changes while positions/orders exist. Read the current setting first and only mutate it when necessary.
    let current:any;
    try { current=await bitgetGetSigned(env as any,"/api/v2/mix/account/account",{symbol,productType,marginCoin},{fetchImpl:deps.fetchImpl,now:deps.now}); }
    catch(e) { await record("broker_rejected",{stage:"account_config",message:e instanceof Error?e.message:"account lookup failed"}); return response({ok:false,outcome:"broker_rejected",error:"futures_account_config_unavailable",message:"Could not verify the current Bitget futures margin mode; no order was placed."},502); }
    if(String(current?.marginMode??"").toLowerCase()!==marginMode){
      const modeSet=await post(env,"/api/v2/mix/account/set-margin-mode",{symbol,productType,marginCoin,marginMode},deps);
      if(!modeSet.ok){await record("broker_rejected",{stage:"margin_mode",brokerResponse:modeSet.data});return response({ok:false,outcome:"broker_rejected",error:"margin_mode_rejected",detail:modeSet.data,broker_contacted:true},502);}
    }
    const leveragePayload={symbol,productType,marginCoin,...(marginMode==="isolated"&&current?.posMode==="hedge_mode"?{longLeverage:String(lev),shortLeverage:String(lev)}:{leverage:String(lev)})};
    const levSet=await post(env,"/api/v2/mix/account/set-leverage",leveragePayload,deps);
    if(!levSet.ok){await record("broker_rejected",{stage:"leverage",brokerResponse:levSet.data});return response({ok:false,outcome:"broker_rejected",error:"leverage_rejected",detail:levSet.data,broker_contacted:true},502);}
  }
  let path:string,payload:Record<string,unknown>;
  if(market==="spot"){
    path="/api/v2/spot/trade/place-order";
    payload={symbol,side,orderType:type,force:type==="limit"?force:undefined,price:type==="limit"?String(price):undefined,size:String(type==="market"&&side==="buy"?quoteAmount:qty),clientOid};
  } else if(margin){
    const kind=market==="margin-crossed"?"crossed":"isolated";
    path="/api/v2/margin/"+kind+"/place-order";
    payload={symbol,side,orderType:type,loanType:["normal","autoLoan","autoRepay","autoLoanAndRepay"].includes(body?.loanType)?body.loanType:"normal",force:type==="limit"?force:undefined,price:type==="limit"?String(price):undefined,baseSize:type==="market"&&side==="buy"?undefined:String(qty),quoteSize:type==="market"&&side==="buy"?String(quoteAmount):undefined,clientOid};
  } else {
    path="/api/v2/mix/order/place-order";
    payload={symbol,productType,marginMode,marginCoin,size:String(qty),price:type==="limit"?String(price):undefined,side,tradeSide,orderType:type,force:type==="limit"?force:undefined,clientOid,reduceOnly:reduceOnly?"YES":"NO",
      presetStopLossPrice:body?.plan?.stop?String(body.plan.stop):undefined,presetStopSurplusPrice:body?.plan?.tp1?String(body.plan.tp1):undefined};
  }
  const sent=await post(env,path,payload,deps);
  if(!sent.ok){
    const result=await record(sent.definite?"broker_rejected":"unknown",{stage:"order",brokerResponse:sent.data,httpStatus:sent.status});
    return response({ok:false,outcome:result.outcome,error:sent.definite?"broker_rejected":"broker_outcome_unknown",detail:sent.data,broker:"bitget",broker_contacted:true,audit_recorded:true,message:sent.definite?"Bitget rejected this order.":"Bitget's response was not definitive. Check Bitget order history before retrying; the client order ID remains reserved."},502);
  }
  const result=await record("executed",{stage:"order",brokerOrderId:sent.data?.orderId??null,brokerStatus:"accepted",brokerResponse:sent.data});
  return response({ok:true,outcome:"executed",broker:"bitget",mode:"live",environment:"live",simulated:false,exchangeOrderPlaced:true,brokerOrderId:result.brokerOrderId,brokerStatus:"accepted",order:sent.data,market,symbol,side,type,quantity:qty,leverage:futures?lev:null,marginMode:futures?marginMode:null,executedAt:at,live_trading:true,audit_recorded:true,notice:"Bitget accepted the live order. Confirm final fill status in Bitget order history; an acknowledgement is not a guaranteed fill."},201);
}
