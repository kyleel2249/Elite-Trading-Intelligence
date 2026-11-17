/** Durable, idempotent read-only synchronization of venue executions and currently open orders.
 * Exchange fills are retained as a separate activity journal: futures hedge/short and margin semantics are
 * not silently forced into ETI's long-only spot position fold.
 */
import { getBybitExecutions, getBybitOpenOrders } from "../bybit/account.ts";
import { BITGET_MARKETS, getFills, getOpenOrders, type BitgetMarket } from "../bitget/api.ts";
import { openStore, type KVL } from "./store.ts";
type Env = Record<string,any>;
type ActivityFill = { key:string; venue:"bybit"|"bitget"; market:string; id:string; orderId:string; clientOrderId:string; symbol:string; side:string; qty:number; price:number; fee:number|null; feeCoin:string|null; at:number; realizedPnl:number|null };
type ActivityOrder = { key:string; venue:"bybit"|"bitget"; market:string; orderId:string; clientOrderId:string; symbol:string; side:string; qty:number; leavesQty:number; price:number|null; status:string; updatedAt:number };
type ActivityState = { schema:"eti.exchange-activity/1"; syncedAt:number; fills:ActivityFill[]; openOrders:ActivityOrder[]; syncs:any[] };
const num=(v:unknown):number|null=>v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
const clean=(v:unknown)=>String(v??"").slice(0,120);
const rows=(v:any):any[]=>Array.isArray(v)?v:[];
const marginSymbols=(env:Env)=>String(env.ETI_BITGET_MARGIN_SYMBOLS??"").split(",").map(x=>x.trim().toUpperCase()).filter(x=>/^[A-Z0-9]{5,20}$/.test(x)).slice(0,20);
export async function syncExchangeActivity(env:Env,environment:"internal_paper"|"exchange_testnet",now:number,deps:{fetchImpl?:typeof fetch}={}){
 const st=openStore(env,environment);if(!st)throw new Error("portfolio_storage_unavailable");
 const previous=await st.kvGet<ActivityState>("exchange_activity",{schema:"eti.exchange-activity/1",syncedAt:0,fills:[],openOrders:[],syncs:[]});
 const fills=[...previous.fills],seen=new Set(fills.map(x=>x.key)),openOrders:ActivityOrder[]=[],results:any[]=[];
 const since=Math.max(0,now-7*86400_000),fetchDeps={now:()=>now,fetchImpl:deps.fetchImpl};
 const bybitConfigured=!!(env.BYBIT_API_KEY?.trim()&&env.BYBIT_API_SECRET?.trim());
 if(bybitConfigured){
  for(const category of ["spot","linear","inverse"] as const){
   try{
    const [trades,orders]=await Promise.all([getBybitExecutions(env,category,fetchDeps,since),getBybitOpenOrders(env,category,fetchDeps)]);
    let added=0;for(const f of trades){const key="bybit|"+category+"|"+f.id;if(seen.has(key))continue;seen.add(key);fills.push({key,venue:"bybit",market:category,id:f.id,orderId:f.orderId,clientOrderId:f.clientOrderId,symbol:f.symbol,side:f.side,qty:f.qty,price:f.price,fee:f.fee,feeCoin:f.feeCoin,at:f.at,realizedPnl:null});added++;}
    for(const o of orders)openOrders.push({key:"bybit|"+category+"|"+o.orderId,venue:"bybit",market:category,orderId:o.orderId,clientOrderId:o.clientOrderId,symbol:o.symbol,side:o.side,qty:o.qty,leavesQty:o.leavesQty,price:o.price,status:o.status,updatedAt:o.updatedAt});
    results.push({venue:"bybit",market:category,status:"connected",fillsFetched:trades.length,fillsAdded:added,openOrders:orders.length});
   }catch(e){results.push({venue:"bybit",market:category,status:"unavailable",error:e instanceof Error?e.message.slice(0,160):"sync_failed"});}
  }
 }else results.push({venue:"bybit",status:"credentials_missing"});
 const bitgetConfigured=!!(env.BITGET_API_KEY?.trim()||env.BITGET_KEY?.trim()||env.BITGET_ACCESS_KEY?.trim());
 if(bitgetConfigured){
  for(const market of BITGET_MARKETS as BitgetMarket[]){
   try{
    const symbols=market.startsWith("margin-")?marginSymbols(env):[];
    if(market.startsWith("margin-")&&!symbols.length){results.push({venue:"bitget",market,status:"partial",warning:"margin_symbols_not_configured"});continue;}
    const [trades,orders]=await Promise.all([market.startsWith("margin-")?Promise.all(symbols.map(symbol=>getFills(env,market,{symbol,startTime:since,endTime:now,limit:100},fetchDeps))).then(a=>a.flat()):getFills(env,market,{startTime:since,endTime:now,limit:100},fetchDeps),getOpenOrders(env,market,symbols,fetchDeps)]);
    let added=0;for(const f of trades){const key="bitget|"+market+"|"+f.id;if(seen.has(key))continue;seen.add(key);fills.push({key,venue:"bitget",market,id:f.id,orderId:f.orderId,clientOrderId:"",symbol:f.symbol,side:f.side,qty:f.qty,price:f.price,fee:f.fee,feeCoin:f.feeCoin||null,at:f.ts,realizedPnl:f.realizedPnl});added++;}
    for(const o of orders)openOrders.push({key:"bitget|"+market+"|"+o.orderId,venue:"bitget",market,orderId:o.orderId,clientOrderId:o.clientOrderId,symbol:o.symbol,side:o.side,qty:o.qty,leavesQty:o.leavesQty,price:o.price,status:o.status,updatedAt:o.updatedAt});
    results.push({venue:"bitget",market,status:"connected",fillsFetched:trades.length,fillsAdded:added,openOrders:orders.length});
   }catch(e){results.push({venue:"bitget",market,status:"unavailable",error:e instanceof Error?e.message.slice(0,160):"sync_failed"});}
  }
 }else results.push({venue:"bitget",status:"credentials_missing"});
 const ledger=await st.ledgerFast(now),orders=Object.values(ledger.ledger.orders);
 const matches=(f:ActivityFill)=>orders.some(o=>o.venue.toLowerCase().includes(f.venue)&&((o.brokerOrderId&&o.brokerOrderId===f.orderId)||(o.clientOrderId&&o.clientOrderId===f.clientOrderId)||(o.orderId===f.orderId)));
 const unmatchedFills=fills.filter(f=>!matches(f));
 const matchedOrders=openOrders.filter(x=>orders.some(o=>o.venue.toLowerCase().includes(x.venue)&&((o.brokerOrderId&&o.brokerOrderId===x.orderId)||(o.clientOrderId&&o.clientOrderId===x.clientOrderId)||(o.orderId===x.orderId))));
 const state:ActivityState={schema:"eti.exchange-activity/1",syncedAt:now,fills:fills.sort((a,b)=>a.at-b.at).slice(-12000),openOrders,syncs:[...previous.syncs,{at:now,results}].slice(-100)};
 await st.kvPut("exchange_activity",state);
 return {schema:state.schema,syncedAt:now,results,summary:{storedFills:state.fills.length,newFills:state.fills.length-previous.fills.length,openOrders:openOrders.length,matchedOpenOrders:matchedOrders.length,unmatchedOpenOrders:openOrders.length-matchedOrders.length,unmatchedExchangeFills:unmatchedFills.length},unmatchedFills:unmatchedFills.slice(-250),openOrders:state.openOrders,limitations:["The exchange activity journal is persisted separately from the ETI position ledger. It does not fabricate position-opening events from futures hedge-mode, reduce-only or margin fills.","Bitget margin fill retrieval requires ETI_BITGET_MARGIN_SYMBOLS to list the symbols to query.","Exchange APIs limit history windows and pagination; this sync backfills seven days per run and retains the newest 12,000 unique fills.","Open-order snapshots are current-state snapshots; they are replaced on each successful venue/market fetch."]};
}
export async function readExchangeActivity(env:Env,environment:"internal_paper"|"exchange_testnet",now:number){
 const st=openStore(env,environment);if(!st)throw new Error("portfolio_storage_unavailable");
 const state=await st.kvGet<ActivityState>("exchange_activity",{schema:"eti.exchange-activity/1",syncedAt:0,fills:[],openOrders:[],syncs:[]});
 const {ledger}=await st.ledgerFast(now),orders=Object.values(ledger.orders);
 const matches=(f:ActivityFill)=>orders.some(o=>o.venue.toLowerCase().includes(f.venue)&&((o.brokerOrderId&&o.brokerOrderId===f.orderId)||(o.clientOrderId&&o.clientOrderId===f.clientOrderId)||(o.orderId===f.orderId)));
 return {...state,ageMs:state.syncedAt?now-state.syncedAt:null,unmatchedFills:state.fills.filter(f=>!matches(f)).slice(-500)};
}
