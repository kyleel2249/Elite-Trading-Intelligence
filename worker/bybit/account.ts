/**
 * Bybit V5 private account snapshot. GET-only; never places, amends or cancels orders.
 * Credentials are read only from Worker secrets and are never included in responses.
 */
import { hmacHex } from "../auth/credentials.ts";

export interface BybitAccountEnv {
  BYBIT_API_KEY?: string; BYBIT_API_SECRET?: string; BYBIT_ACCOUNT_ENV?: string;
}
export interface BybitAccountDeps { fetchImpl?: typeof fetch; now?: () => number }
const BASE = "https://api.bybit.com";
const TESTNET = "https://api-testnet.bybit.com";
const RECV_WINDOW = "5000";
const num = (v: unknown): number | null => v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const safeText = (v: unknown) => typeof v === "string" ? v.slice(0, 100) : null;

async function signedGet(env: BybitAccountEnv, path: string, params: Record<string, string>, deps: BybitAccountDeps) {
  const key = env.BYBIT_API_KEY!.trim(), secret = env.BYBIT_API_SECRET!.trim();
  const query = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const timestamp = String((deps.now ?? Date.now)());
  const signature = await hmacHex(secret, timestamp + key + RECV_WINDOW + query);
  const host = env.BYBIT_ACCOUNT_ENV === "testnet" ? TESTNET : BASE;
  const response = await (deps.fetchImpl ?? fetch)(host + path + (query ? "?" + query : ""), {
    method: "GET",
    headers: { "X-BAPI-API-KEY": key, "X-BAPI-SIGN": signature, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": RECV_WINDOW },
    signal: AbortSignal.timeout(12000),
  });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload || Number(payload.retCode) !== 0) {
    const code = payload && payload.retCode !== undefined ? String(payload.retCode) : "http_" + response.status;
    throw new Error("bybit_" + code);
  }
  return payload.result ?? {};
}
function positionRows(rows: any[], category: string) {
  return rows.slice(0, 200).map(row => ({
    category, symbol: safeText(row.symbol), side: safeText(row.side),
    size: num(row.size), avgPrice: num(row.avgPrice), markPrice: num(row.markPrice),
    positionValue: num(row.positionValue), leverage: num(row.leverage),
    unrealizedPnl: num(row.unrealisedPnl), liquidationPrice: num(row.liqPrice),
    marginMode: safeText(row.tradeMode === 0 ? "cross" : row.tradeMode === 1 ? "isolated" : "unknown"),
  })).filter(row => row.symbol && (row.size ?? 0) > 0);
}
export async function loadBybitAccountSnapshot(env: BybitAccountEnv, deps: BybitAccountDeps = {}) {
  const checkedAt = (deps.now ?? Date.now)();
  if (!env.BYBIT_API_KEY?.trim() || !env.BYBIT_API_SECRET?.trim()) {
    return { venue: "bybit", configured: false, status: "credentials_missing", environment: env.BYBIT_ACCOUNT_ENV === "testnet" ? "testnet" : "mainnet", checkedAt, error: "bybit_credentials_missing", equityUsd: null, availableUsd: null, assets: [], positions: [], warnings: [] };
  }
  const [wallet, linear, inverse] = await Promise.allSettled([
    signedGet(env, "/v5/account/wallet-balance", { accountType: "UNIFIED" }, deps),
    signedGet(env, "/v5/position/list", { category: "linear", settleCoin: "USDT", limit: "200" }, deps),
    signedGet(env, "/v5/position/list", { category: "inverse", settleCoin: "BTC", limit: "200" }, deps),
  ]);
  const warnings: string[] = [], assets: any[] = [], positions: any[] = [];
  let equityUsd: number | null = null, availableUsd: number | null = null;
  if (wallet.status === "fulfilled") {
    const account = Array.isArray(wallet.value.list) ? wallet.value.list[0] : null;
    equityUsd = num(account?.totalEquity);
    availableUsd = num(account?.totalAvailableBalance);
    for (const coin of Array.isArray(account?.coin) ? account.coin.slice(0, 100) : []) {
      assets.push({ coin: safeText(coin.coin), walletBalance: num(coin.walletBalance), locked: num(coin.locked), availableToWithdraw: num(coin.availableToWithdraw), usdValue: num(coin.usdValue) });
    }
  } else warnings.push("wallet_balance_unavailable:" + wallet.reason.message);
  for (const [category, result] of [["linear", linear], ["inverse", inverse]] as const) {
    if (result.status === "fulfilled") {
      const rows = Array.isArray(result.value.list) ? result.value.list : [];
      positions.push(...positionRows(rows, category));
      if (result.value.nextPageCursor) warnings.push(category + "_positions_truncated_at_200");
    } else warnings.push(category + "_positions_unavailable:" + result.reason.message);
  }
  const failed = wallet.status === "rejected" && linear.status === "rejected" && inverse.status === "rejected";
  return {
    venue: "bybit", configured: true, status: failed ? "unavailable" : warnings.length ? "partial" : "connected",
    environment: env.BYBIT_ACCOUNT_ENV === "testnet" ? "testnet" : "mainnet",
    checkedAt, equityUsd, availableUsd, assets, positions, warnings,
    permissions: { readOnlySnapshot: true, orders: false, transfers: false, withdrawals: false },
  };
}

export interface BybitExecutionRow { id:string; orderId:string; clientOrderId:string; category:string; symbol:string; side:string; qty:number; price:number; fee:number|null; feeCoin:string|null; at:number; execType:string|null }
export interface BybitOpenOrderRow { orderId:string; clientOrderId:string; category:string; symbol:string; side:string; qty:number; leavesQty:number; price:number|null; status:string; updatedAt:number }
const rowNum=(v:unknown):number|null=>v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
/** Read-only execution history, paginated by Bybit cursor. */
export async function getBybitExecutions(env:BybitAccountEnv,category:"spot"|"linear"|"inverse",deps:BybitAccountDeps={},startTime?:number):Promise<BybitExecutionRow[]> {
 const out:BybitExecutionRow[]=[];let cursor:string|undefined;
 for(let page=0;page<5;page++){
  const p:Record<string,string>={category,limit:"100"};if(startTime)p.startTime=String(startTime);if(cursor)p.cursor=cursor;
  const data=await signedGet(env,"/v5/execution/list",p,deps),list=Array.isArray(data.list)?data.list:[];
  for(const x of list){const qty=rowNum(x.execQty),price=rowNum(x.execPrice),at=rowNum(x.execTime);if(!x.execId||!x.orderId||!x.symbol||qty===null||price===null||at===null||qty<=0||price<=0)continue;out.push({id:String(x.execId),orderId:String(x.orderId),clientOrderId:String(x.orderLinkId??""),category,symbol:String(x.symbol),side:String(x.side??"").toLowerCase(),qty,price,fee:rowNum(x.execFee),feeCoin:x.feeCurrency?String(x.feeCurrency):null,at,execType:x.execType?String(x.execType):null});}
  cursor=data.nextPageCursor?String(data.nextPageCursor):"";if(!cursor||list.length===0)break;
 }
 return out;
}
/** Current open orders are fetched independently for each supported category. */
export async function getBybitOpenOrders(env:BybitAccountEnv,category:"spot"|"linear"|"inverse",deps:BybitAccountDeps={}):Promise<BybitOpenOrderRow[]>{
 const out:BybitOpenOrderRow[]=[];let cursor:string|undefined;
 for(let page=0;page<5;page++){
  const p:Record<string,string>={category,openOnly:"0",limit:"100"};if(cursor)p.cursor=cursor;
  const data=await signedGet(env,"/v5/order/realtime",p,deps),list=Array.isArray(data.list)?data.list:[];
  for(const x of list){const qty=rowNum(x.qty),leaves=rowNum(x.leavesQty),updated=rowNum(x.updatedTime);if(!x.orderId||!x.symbol||qty===null)continue;out.push({orderId:String(x.orderId),clientOrderId:String(x.orderLinkId??""),category,symbol:String(x.symbol),side:String(x.side??"").toLowerCase(),qty,leavesQty:leaves??Math.max(0,qty-(rowNum(x.cumExecQty)??0)),price:rowNum(x.price),status:String(x.orderStatus??"unknown"),updatedAt:updated??0});}
  cursor=data.nextPageCursor?String(data.nextPageCursor):"";if(!cursor||list.length===0)break;
 }
 return out;
}
