/** Durable, idempotent read-only synchronization of venue executions and currently open orders.
 * Exchange fills are retained as a separate activity journal: futures hedge/short and margin semantics are
 * not silently forced into ETI's long-only spot position fold.
 */
import { getBybitExecutions, getBybitOpenOrders } from "../bybit/account.ts";
import { BITGET_MARKETS, getFills, getOpenOrders, type BitgetMarket } from "../bitget/api.ts";
import { openStore, type KVL } from "./store.ts";
type Env = Record<string,any>;
type ActivityFill = { key:string; venue:"bybit"|"bitget"; market:string; id:string; orderId:string; clientOrderId:string; symbol:string; side:string; qty:number; price:number; fee:number|null; feeCoin:string|null; at:number; realizedPnl:number|null };
type ActivityOrder = { key:string; venue:"bybit"|"bitget"; market:string; orderId:string; clientOrderId:string; symbol:string; side:string; qty:number; leavesQty:number; price:number|null; notionalUsd?:number|null; status:string; updatedAt:number };
type ActivityState = { schema:"eti.exchange-activity/1"; syncedAt:number; fills:ActivityFill[]; openOrders:ActivityOrder[]; syncs:any[] };
export function mergeActivityFills(existing:ActivityFill[],incoming:ActivityFill[]){
 const byKey=new Map<string,ActivityFill>();for(const f of existing)byKey.set(f.key,f);for(const f of incoming)if(!byKey.has(f.key))byKey.set(f.key,f);
 return [...byKey.values()].sort((a,b)=>a.at-b.at).slice(-12000);
}
export function matchActivityFills(fills:ActivityFill[],orders:any[]){
 const matched:ActivityFill[]=[],unmatched:ActivityFill[]=[];
 for(const f of fills){const hit=orders.some(o=>String(o.venue??"").toLowerCase().includes(f.venue)&&((o.brokerOrderId&&o.brokerOrderId===f.orderId)||(o.clientOrderId&&f.clientOrderId&&o.clientOrderId===f.clientOrderId)||(o.orderId===f.orderId)));(hit?matched:unmatched).push(f);}
 return {matched,unmatched};
}
const marginSymbols=(env:Env)=>String(env.ETI_BITGET_MARGIN_SYMBOLS??"").split(",").map(x=>x.trim().toUpperCase()).filter(x=>/^[A-Z0-9]{5,20}$/.test(x)).slice(0,20);
async function fetchBitgetWindow(env:Env,market:BitgetMarket,symbols:string[],since:number,now:number,deps:{fetchImpl?:typeof fetch}){
 const targets=market.startsWith("margin-")?symbols:[undefined],all:any[]=[],seen=new Set<string>();let truncated=false;
 for(const symbol of targets){let end=now;for(let page=0;page<5;page++){
  const batch=await getFills(env,market,{symbol,startTime:since,endTime:end,limit:100},{now:()=>now,fetchImpl:deps.fetchImpl});
  for(const f of batch)if(!seen.has(f.id)){seen.add(f.id);all.push(f);}
  if(batch.length<100)break;
  const earliest=Math.min(...batch.map(f=>f.ts));if(!Number.isFinite(earliest)||earliest>=end){truncated=true;break;}
  end=earliest-1;if(page===4)truncated=true;
 }}
 return {fills:all,truncated};
}

export async function syncExchangeActivity(env:Env,environment:"internal_paper"|"exchange_testnet",now:number,deps:{fetchImpl?:typeof fetch}={}){
 const st=openStore(env,environment);if(!st)throw new Error("portfolio_storage_unavailable");
 const previous=await st.kvGet<ActivityState>("exchange_activity",{schema:"eti.exchange-activity/1",syncedAt:0,fills:[],openOrders:[],syncs:[]});
 const incoming:ActivityFill[]=[],seen=new Set(previous.fills.map(x=>x.key)),openOrders:ActivityOrder[]=[],freshOrderScopes=new Set<string>(),results:any[]=[];
 const since=Math.max(0,now-7*86400_000),fetchDeps={now:()=>now,fetchImpl:deps.fetchImpl};
 const bybitConfigured=!!(env.BYBIT_API_KEY?.trim()&&env.BYBIT_API_SECRET?.trim());
 if(bybitConfigured){
  for(const category of ["spot","linear","inverse"] as const){
   try{
    const [tradeResult,orderResult]=await Promise.allSettled([getBybitExecutions(env,category,fetchDeps,since),getBybitOpenOrders(env,category,fetchDeps)]);
    if(tradeResult.status==="rejected"&&orderResult.status==="rejected")throw tradeResult.reason;
    const trades=tradeResult.status==="fulfilled"?tradeResult.value:[],orders=orderResult.status==="fulfilled"?orderResult.value:[];
    if(orderResult.status==="fulfilled")freshOrderScopes.add("bybit|"+category);
    let added=0;for(const f of trades){const key="bybit|"+category+"|"+f.id;if(seen.has(key))continue;seen.add(key);incoming.push({key,venue:"bybit",market:category,id:f.id,orderId:f.orderId,clientOrderId:f.clientOrderId,symbol:f.symbol,side:f.side,qty:f.qty,price:f.price,fee:f.fee,feeCoin:f.feeCoin,at:f.at,realizedPnl:null});added++;}
    for(const o of orders)openOrders.push({key:"bybit|"+category+"|"+o.orderId,venue:"bybit",market:category,orderId:o.orderId,clientOrderId:o.clientOrderId,symbol:o.symbol,side:o.side,qty:o.qty,leavesQty:o.leavesQty,price:o.price,notionalUsd:o.leavesValue,status:o.status,updatedAt:o.updatedAt});
    results.push({venue:"bybit",market:category,status:tradeResult.status==="fulfilled"&&orderResult.status==="fulfilled"?"connected":"partial",fillsFetched:trades.length,fillsAdded:added,openOrders:orders.length,errors:[tradeResult.status==="rejected"?"fills_unavailable":null,orderResult.status==="rejected"?"open_orders_unavailable":null].filter(Boolean)});
   }catch(e){results.push({venue:"bybit",market:category,status:"unavailable",error:e instanceof Error?e.message.slice(0,160):"sync_failed"});}
  }
 }else results.push({venue:"bybit",status:"credentials_missing"});
 const bitgetConfigured=!!(env.BITGET_API_KEY?.trim()||env.BITGET_KEY?.trim()||env.BITGET_ACCESS_KEY?.trim());
 if(bitgetConfigured){
  for(const market of BITGET_MARKETS as BitgetMarket[]){
   try{
    const symbols=market.startsWith("margin-")?marginSymbols(env):[];
    if(market.startsWith("margin-")&&!symbols.length){results.push({venue:"bitget",market,status:"partial",warning:"margin_symbols_not_configured"});continue;}
    const [tradeResult,orderResult]=await Promise.allSettled([fetchBitgetWindow(env,market,symbols,since,now,deps),getOpenOrders(env,market,symbols,fetchDeps)]);
    if(tradeResult.status==="rejected"&&orderResult.status==="rejected")throw tradeResult.reason;
    const tradeData=tradeResult.status==="fulfilled"?tradeResult.value:{fills:[],truncated:false},trades=tradeData.fills,orders=orderResult.status==="fulfilled"?orderResult.value:[];
    if(orderResult.status==="fulfilled")freshOrderScopes.add("bitget|"+market);
    let added=0;for(const f of trades){const key="bitget|"+market+"|"+f.id;if(seen.has(key))continue;seen.add(key);incoming.push({key,venue:"bitget",market,id:f.id,orderId:f.orderId,clientOrderId:"",symbol:f.symbol,side:f.side,qty:f.qty,price:f.price,fee:f.fee,feeCoin:f.feeCoin||null,at:f.ts,realizedPnl:f.realizedPnl});added++;}
    for(const o of orders)openOrders.push({key:"bitget|"+market+"|"+o.orderId,venue:"bitget",market,orderId:o.orderId,clientOrderId:o.clientOrderId,symbol:o.symbol,side:o.side,qty:o.qty,leavesQty:o.leavesQty,price:o.price,status:o.status,updatedAt:o.updatedAt});
    results.push({venue:"bitget",market,status:tradeResult.status==="fulfilled"&&orderResult.status==="fulfilled"?"connected":"partial",fillsFetched:trades.length,fillsAdded:added,openOrders:orders.length,historyTruncated:tradeData.truncated,errors:[tradeResult.status==="rejected"?"fills_unavailable":null,orderResult.status==="rejected"?"open_orders_unavailable":null].filter(Boolean)});
   }catch(e){results.push({venue:"bitget",market,status:"unavailable",error:e instanceof Error?e.message.slice(0,160):"sync_failed"});}
  }
 }else results.push({venue:"bitget",status:"credentials_missing"});
 const fills=mergeActivityFills(previous.fills,incoming);
 const retainedOrders=previous.openOrders.filter(o=>!freshOrderScopes.has(o.venue+"|"+o.market));
 const currentOrders=[...retainedOrders,...openOrders];
 const ledger=await st.ledgerFast(now),orders=Object.values(ledger.ledger.orders);
 const {unmatched:unmatchedFills}=matchActivityFills(fills,orders);
 const matchedOrders=currentOrders.filter(x=>orders.some(o=>o.venue.toLowerCase().includes(x.venue)&&((o.brokerOrderId&&o.brokerOrderId===x.orderId)||(o.clientOrderId&&o.clientOrderId===x.clientOrderId)||(o.orderId===x.orderId))));
 const state:ActivityState={schema:"eti.exchange-activity/1",syncedAt:now,fills,openOrders:currentOrders,syncs:[...previous.syncs,{at:now,results}].slice(-100)};
 await st.kvPut("exchange_activity",state);
 return {schema:state.schema,syncedAt:now,results,summary:{storedFills:state.fills.length,newFills:incoming.length,openOrders:currentOrders.length,matchedOpenOrders:matchedOrders.length,unmatchedOpenOrders:currentOrders.length-matchedOrders.length,staleOpenOrderScopes:previous.openOrders.filter(o=>!freshOrderScopes.has(o.venue+"|"+o.market)).map(o=>o.venue+"|"+o.market),unmatchedExchangeFills:unmatchedFills.length},unmatchedFills:unmatchedFills.slice(-250),openOrders:state.openOrders,staleOpenOrderScopes:previous.openOrders.filter(o=>!freshOrderScopes.has(o.venue+"|"+o.market)).map(o=>o.venue+"|"+o.market),limitations:["The exchange activity journal is persisted separately from the ETI position ledger. It does not fabricate position-opening events from futures hedge-mode, reduce-only or margin fills.","Bitget margin fill retrieval requires ETI_BITGET_MARGIN_SYMBOLS to list the symbols to query.","Exchange APIs limit history windows and pagination; this sync backfills seven days per run and retains the newest 12,000 unique fills.","Open-order snapshots are current-state snapshots; they are replaced on each successful venue/market fetch."]};
}
export async function readExchangeActivity(env:Env,environment:"internal_paper"|"exchange_testnet",now:number){
 const st=openStore(env,environment);if(!st)throw new Error("portfolio_storage_unavailable");
 const state=await st.kvGet<ActivityState>("exchange_activity",{schema:"eti.exchange-activity/1",syncedAt:0,fills:[],openOrders:[],syncs:[]});
 const {ledger}=await st.ledgerFast(now),orders=Object.values(ledger.orders);
 const {unmatched}=matchActivityFills(state.fills,orders);
 return {...state,totalFills:state.fills.length,fills:state.fills.slice(-600),ageMs:state.syncedAt?now-state.syncedAt:null,unmatchedFills:unmatched.slice(-500)};
}
