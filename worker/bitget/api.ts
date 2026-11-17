// Bitget account and history integration for spot, cross/isolated margin and all three futures product types.
// This module signs only allowlisted GET requests. Explicit live order placement is isolated in trading.ts; no transfer or withdrawal path is exposed.
import { authorized } from "../execution.ts";
import { bitgetAwareFetch, listBitgetMarginSymbols } from "../market.ts";

export type BitgetMarket = "spot" | "margin-crossed" | "margin-isolated" | "usdt-futures" | "usdc-futures" | "coin-futures";
export const BITGET_MARKETS: BitgetMarket[] = ["spot", "margin-crossed", "margin-isolated", "usdt-futures", "usdc-futures", "coin-futures"];
const BASE = "https://api.bitget.com";
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });

/** Env names accepted for each credential (names only are ever reported, never values). */
const NAMES = {
  key: ["BITGET_API_KEY", "BITGET_KEY", "BITGET_ACCESS_KEY"],
  secret: ["BITGET_API_SECRET", "BITGET_SECRET_KEY", "BITGET_SECRET"],
  passphrase: ["BITGET_API_PASSPHRASE", "BITGET_PASSPHRASE"],
};
const pick = (env: Record<string, any>, names: string[]) => { for (const n of names) if (typeof env[n] === "string" && env[n].trim()) return { name: n, value: env[n].trim() as string }; return null; };
export function bitgetCreds(env: Record<string, any>) {
  const k = pick(env, NAMES.key), s = pick(env, NAMES.secret), p = pick(env, NAMES.passphrase);
  return { key: k?.value, secret: s?.value, passphrase: p?.value, found: { key: k?.name ?? null, secret: s?.name ?? null, passphrase: p?.name ?? null },
    missing: [!k && NAMES.key[0], !s && NAMES.secret[0], !p && NAMES.passphrase[0]].filter(Boolean) as string[], complete: !!(k && s && p) };
}

// ----------------------------------------------------------------------------------------------------------------- signing
const b64 = (buf: ArrayBuffer) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
export async function bitgetSign(secret: string, timestamp: string, method: string, path: string, query: string, body = ""): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + method.toUpperCase() + path + (query ? "?" + query : "") + body)));
}

/** Allowlist: the only private endpoints this module can reach. All are GET. */
const ALLOWED = new Set([
  "/api/v2/spot/account/assets", "/api/v2/spot/trade/fills", "/api/v2/spot/trade/history-orders", "/api/v2/spot/trade/unfilled-orders",
  "/api/v2/margin/crossed/account/assets", "/api/v2/margin/crossed/fills", "/api/v2/margin/crossed/history-orders", "/api/v2/margin/crossed/open-orders",
  "/api/v2/margin/isolated/account/assets", "/api/v2/margin/isolated/fills", "/api/v2/margin/isolated/history-orders", "/api/v2/margin/isolated/open-orders",
  "/api/v2/mix/account/accounts", "/api/v2/mix/account/account", "/api/v2/mix/order/fills", "/api/v2/mix/order/orders-history", "/api/v2/mix/order/orders-pending", "/api/v2/mix/position/all-position",
]);

export class BitgetError extends Error {
  code: string; status: number | null;
  constructor(code: string, status: number | null, message: string) { super(message); this.code = code; this.status = status; }
}
export interface Deps { fetchImpl?: typeof fetch; now?: () => number }

export async function bitgetGetSigned(env: Record<string, any>, path: string, params: Record<string, string | number | undefined>, deps: Deps = {}): Promise<any> {
  if (!ALLOWED.has(path)) throw new BitgetError("path_not_allowed", null, "path is not on the read-only allowlist");
  const c = bitgetCreds(env);
  if (!c.complete) throw new BitgetError("credentials_missing", null, "missing: " + c.missing.join(", "));
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).sort().join("&");
  const ts = String((deps.now ?? Date.now)());
  const sign = await bitgetSign(c.secret!, ts, "GET", path, q);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${BASE}${path}${q ? "?" + q : ""}`, { method: "GET", headers: { "ACCESS-KEY": c.key!, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": c.passphrase!, "Content-Type": "application/json", locale: "en-US" }, signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new BitgetError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network_error", null, "request failed"); }
  let j: any = null;
  try { j = await res.json(); } catch { /* handled below */ }
  if (!j || typeof j !== "object") throw new BitgetError(res.status === 403 || res.status === 451 ? "geo_or_ip_blocked" : "invalid_payload", res.status, `HTTP ${res.status}`);
  if (j.code !== "00000") {
    // 40018/40017 = bad key / signature, 40014 = key lacks permission, 40019 = IP not whitelisted. Report Bitget's own code and message.
    throw new BitgetError("bitget_" + j.code, res.status, String(j.msg ?? "rejected").slice(0, 200));
  }
  return j.data;
}

// ----------------------------------------------------------------------------------------------------------------- normalisation
export interface Fill {
  id: string; market: BitgetMarket; symbol: string; orderId: string; side: "buy" | "sell" | string; price: number; qty: number; quoteQty: number;
  fee: number; feeCoin: string; role: string; ts: number; realizedPnl: number | null; tradeSide: string | null;
}
const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const feeOf = (d: any): { fee: number; coin: string } => {
  const a = Array.isArray(d) ? d : d && typeof d === "object" ? [d] : [];
  let fee = 0, coin = "";
  for (const f of a) { fee += Math.abs(num(f.totalFee ?? f.fee)); coin = coin || String(f.feeCoin ?? ""); }
  return { fee, coin };
};
export function normalizeFills(market: BitgetMarket, data: any): Fill[] {
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.fillList) ? data.fillList : Array.isArray(data?.fills) ? data.fills : [];
  const out: Fill[] = [];
  for (const x of list) {
    const id = String(x?.tradeId ?? "");
    if (!id) continue;
    const isMix = market.endsWith("futures");
    const price = num(isMix ? x.price : x.priceAvg ?? x.price), qty = num(isMix ? x.baseVolume : x.size);
    const f = feeOf(x.feeDetail);
    out.push({ id, market, symbol: String(x.symbol ?? ""), orderId: String(x.orderId ?? ""), side: String(x.side ?? "").toLowerCase(), price, qty,
      quoteQty: num(isMix ? x.quoteVolume : x.amount) || price * qty, fee: f.fee, feeCoin: f.coin, role: String(x.tradeScope ?? "").toLowerCase(),
      ts: num(x.cTime), realizedPnl: isMix && x.profit !== undefined ? num(x.profit) : null, tradeSide: x.tradeSide ? String(x.tradeSide) : null });
  }
  return out.filter((f) => f.ts > 0 && f.price > 0 && f.qty > 0);
}

// ----------------------------------------------------------------------------------------------------------------- per-market endpoints
const isFut = (m: BitgetMarket) => m.endsWith("futures");
const productTypeParam = (m: BitgetMarket) => m === "usdt-futures" ? "USDT-FUTURES" : m === "usdc-futures" ? "USDC-FUTURES" : "COIN-FUTURES";
const marginKind = (m: BitgetMarket) => (m === "margin-crossed" ? "crossed" : "isolated");
export function fillsRequest(market: BitgetMarket, p: { symbol?: string; startTime?: number; endTime?: number; limit?: number }) {
  const limit = Math.min(100, Math.max(1, p.limit ?? 100));
  if (market === "spot") return { path: "/api/v2/spot/trade/fills", params: { symbol: p.symbol, startTime: p.startTime, endTime: p.endTime, limit } };
  if (isFut(market)) return { path: "/api/v2/mix/order/fills", params: { productType: productTypeParam(market), symbol: p.symbol, startTime: p.startTime, endTime: p.endTime, limit } };
  return { path: `/api/v2/margin/${marginKind(market)}/fills`, params: { symbol: p.symbol, startTime: p.startTime ?? Date.now() - 7 * 86400_000, endTime: p.endTime, limit } };
}
export async function getFills(env: Record<string, any>, market: BitgetMarket, p: { symbol?: string; startTime?: number; endTime?: number; limit?: number }, deps: Deps = {}): Promise<Fill[]> {
  if (!isFut(market) && market !== "spot" && !p.symbol) throw new BitgetError("symbol_required", null, "Bitget margin fills need a symbol (e.g. BTCUSDT)");
  const r = fillsRequest(market, p);
  return normalizeFills(market, await bitgetGetSigned(env, r.path, r.params, deps));
}
export async function getAssets(env: Record<string, any>, market: BitgetMarket, deps: Deps = {}) {
  if (market === "spot") return bitgetGetSigned(env, "/api/v2/spot/account/assets", {}, deps);
  if (isFut(market)) return bitgetGetSigned(env, "/api/v2/mix/account/accounts", { productType: productTypeParam(market) }, deps);
  return bitgetGetSigned(env, `/api/v2/margin/${marginKind(market)}/account/assets`, {}, deps);
}
export async function getPositions(env: Record<string, any>, market: BitgetMarket, deps: Deps = {}) {
  if (!isFut(market)) throw new BitgetError("not_applicable", null, "positions exist only for futures markets");
  const marginCoin = market === "usdt-futures" ? "USDT" : market === "usdc-futures" ? "USDC" : undefined;
  return bitgetGetSigned(env, "/api/v2/mix/position/all-position", { productType: productTypeParam(market), marginCoin }, deps);
}
/** Read-only currently pending orders. Margin APIs are symbol-scoped, so symbols must be explicitly supplied. */
export async function getOpenOrders(env:Record<string,any>,market:BitgetMarket,symbols:string[]=[],deps:Deps={}):Promise<any[]> {
 const path=market==="spot"?"/api/v2/spot/trade/unfilled-orders":market.endsWith("futures")?"/api/v2/mix/order/orders-pending":`/api/v2/margin/${marginKind(market)}/open-orders`;
 const base:Record<string,string|number|undefined>=market==="spot"?{limit:100}:market.endsWith("futures")?{productType:productTypeParam(market),limit:100}:{limit:100};
 const targets=market.startsWith("margin-")?symbols.slice(0,20):[undefined];const out:any[]=[];
 for(const symbol of targets){const data=await bitgetGetSigned(env,path,{...base,symbol},deps),list=Array.isArray(data)?data:Array.isArray(data?.orderList)?data.orderList:Array.isArray(data?.list)?data.list:Array.isArray(data?.entrustedList)?data.entrustedList:[];for(const x of list){const orderId=String(x.orderId??x.orderID??"");if(!orderId)continue;out.push({orderId,clientOrderId:String(x.clientOid??x.clientOrderId??""),market,symbol:String(x.symbol??symbol??""),side:String(x.side??"").toLowerCase(),qty:Number(x.size??x.quantity??x.baseVolume??0),leavesQty:Number(x.size??x.quantity??x.baseVolume??0)-Number(x.filledQty??x.baseVolume??0),price:Number.isFinite(Number(x.price))?Number(x.price):null,status:String(x.status??"live"),updatedAt:Number(x.uTime??x.cTime??0)});}}
 return out;
}
export async function getOrders(env: Record<string, any>, market: BitgetMarket, p: { symbol?: string; startTime?: number; endTime?: number; limit?: number }, deps: Deps = {}) {
  const limit = Math.min(100, Math.max(1, p.limit ?? 50));
  if (market === "spot") return bitgetGetSigned(env, "/api/v2/spot/trade/history-orders", { symbol: p.symbol, startTime: p.startTime, endTime: p.endTime, limit }, deps);
  if (isFut(market)) return bitgetGetSigned(env, "/api/v2/mix/order/orders-history", { productType: productTypeParam(market), symbol: p.symbol, startTime: p.startTime, endTime: p.endTime, limit }, deps);
  if (!p.symbol) throw new BitgetError("symbol_required", null, "Bitget margin order history needs a symbol");
  return bitgetGetSigned(env, `/api/v2/margin/${marginKind(market)}/history-orders`, { symbol: p.symbol, startTime: p.startTime ?? Date.now() - 7 * 86400_000, endTime: p.endTime, limit }, deps);
}

// ----------------------------------------------------------------------------------------------------------------- trade sync (KV)
interface KV { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }
const MAX_STORED = 3000, MAX_PAGES = 5;
export async function readStoredFills(kv: KV, market: BitgetMarket): Promise<Fill[]> {
  try { const a = JSON.parse((await kv.get(`bitget:fills:${market}`)) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
}
/** Pulls new fills for one market, merges by fill id (so re-running never duplicates) and advances a time cursor. */
export async function syncMarket(env: Record<string, any>, kv: KV, market: BitgetMarket, symbols: string[], deps: Deps = {}) {
  const now = (deps.now ?? Date.now)();
  const days = Math.min(90, Math.max(1, Number(env.ETI_BITGET_BACKFILL_DAYS) || 7));
  const cursor = Number(await kv.get(`bitget:cursor:${market}`)) || now - days * 86400_000;
  const targets: (string | undefined)[] = isFut(market) || market === "spot" ? [undefined] : symbols;
  if (!targets.length) return { market, fetched: 0, added: 0, skipped: "no symbols configured (set ETI_BITGET_MARGIN_SYMBOLS, e.g. BTCUSDT,ETHUSDT)" };
  const have = await readStoredFills(kv, market), seen = new Set(have.map((f) => f.id));
  const fresh: Fill[] = [];
  let fetched = 0;
  for (const symbol of targets) {
    let end = now;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await getFills(env, market, { symbol, startTime: cursor + 1, endTime: end, limit: 100 }, deps);
      fetched += batch.length;
      for (const f of batch) if (!seen.has(f.id)) { seen.add(f.id); fresh.push(f); }
      if (batch.length < 100) break;
      end = Math.min(...batch.map((f) => f.ts)) - 1;
    }
  }
  const merged = [...fresh, ...have].sort((a, b) => b.ts - a.ts).slice(0, MAX_STORED);
  if (fresh.length) await kv.put(`bitget:fills:${market}`, JSON.stringify(merged));
  const newest = Math.max(cursor, ...fresh.map((f) => f.ts));
  await kv.put(`bitget:cursor:${market}`, String(newest));
  return { market, fetched, added: fresh.length, stored: merged.length, cursor: new Date(newest).toISOString() };
}
export async function syncAll(env: Record<string, any>, deps: Deps = {}, only?: BitgetMarket[]) {
  const kv = env.ETI_EXECUTION_LOG as KV | undefined;
  if (!kv) return { ok: false, error: "storage_not_configured", note: "bind the ETI_EXECUTION_LOG KV namespace" };
  if (!bitgetCreds(env).complete) return { ok: false, error: "credentials_missing", missing: bitgetCreds(env).missing };
  const symbols = String(env.ETI_BITGET_MARGIN_SYMBOLS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{5,20}$/.test(s)).slice(0, 20);
  const results: any[] = [];
  for (const m of only ?? BITGET_MARKETS) {
    try { results.push(await syncMarket(env, kv, m, symbols, deps)); }
    catch (e) { results.push({ market: m, error: e instanceof BitgetError ? e.code : "failed", message: e instanceof BitgetError ? e.message : undefined }); }
  }
  return { ok: results.every((r) => !r.error), results };
}

// ----------------------------------------------------------------------------------------------------------------- public margin pair list
export async function listMarginPairs(deps: Deps = {}) {
  try {
    const fetcher: typeof fetch = (input, init) => bitgetAwareFetch(input, init, deps.fetchImpl ?? fetch);
    const result = await listBitgetMarginSymbols(fetcher, deps.now ?? Date.now);
    return result.rows.map((x) => ({
      symbol: x.s, base: x.b, quote: x.q, status: "online",
      crossed: !!x.marginCrossed, isolated: !!x.marginIsolated,
      maxCrossedLeverage: x.maxCrossedLeverage ?? 0, maxIsolatedLeverage: x.maxIsolatedLeverage ?? 0,
      isCrossBorrowable: !!x.marginCrossBorrowable, isIsolatedBaseBorrowable: !!x.marginBaseBorrowable,
      isIsolatedQuoteBorrowable: !!x.marginQuoteBorrowable,
    }));
  } catch (e) {
    throw new BitgetError("margin_pairs_unavailable", e instanceof Error ? null : null, "Bitget margin instrument list unavailable");
  }
}

// ----------------------------------------------------------------------------------------------------------------- HTTP
const mkt = (v: string | null): BitgetMarket | null => (BITGET_MARKETS as string[]).includes(String(v)) ? (v as BitgetMarket) : null;
export async function handleBitget(req: Request, env: Record<string, any>, deps: Deps = {}): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  const sub = path.slice("/api/bitget".length) || "/";
  if (sub === "/margin-pairs" && req.method === "GET") {   // public data, no credentials
    try { const pairs = await listMarginPairs(deps); return reply({ venue: "bitget", market: "margin", count: pairs.length, pairs }); }
    catch (e) { return reply({ error: e instanceof BitgetError ? e.code : "failed", message: e instanceof BitgetError ? e.message : undefined }, 502); }
  }
  if (!(await authorized(req, env as any))) return reply({ error: "unauthorized" }, 401);
  const c = bitgetCreds(env);
  if (sub === "/status" && req.method === "GET") {
    return reply({ venue: "bitget", credentials: { complete: c.complete, found: c.found, missing: c.missing }, markets: BITGET_MARKETS, storage: !!env.ETI_EXECUTION_LOG,
      readOnly: false, liveTradingEnabled: env.ETI_BITGET_LIVE_ENABLED === "true", note: "Account and history reads use allowlisted GET endpoints. Live orders are accepted only through the master-authenticated /api/orders/live route; transfers and withdrawals are not exposed.",
      marginSymbols: String(env.ETI_BITGET_MARGIN_SYMBOLS ?? "") || null });
  }
  if (!c.complete) return reply({ error: "credentials_missing", missing: c.missing, hint: "Set these Worker secrets; names only are reported." }, 503);
  const market = mkt(url.searchParams.get("market") ?? "spot");
  if (!market) return reply({ error: "invalid_market", allowed: BITGET_MARKETS }, 400);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase() || undefined;
  if (symbol && !/^[A-Z0-9]{5,20}$/.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
  const fail = (e: unknown) => e instanceof BitgetError ? reply({ error: e.code, message: e.message, upstreamStatus: e.status }, e.code === "symbol_required" || e.code === "not_applicable" ? 400 : 502) : reply({ error: "failed" }, 500);
  try {
    if (sub === "/account" && req.method === "GET") return reply({ market, assets: await getAssets(env, market, deps) });
    if (sub === "/positions" && req.method === "GET") return reply({ market, positions: await getPositions(env, market, deps) });
    if (sub === "/orders" && req.method === "GET") return reply({ market, orders: await getOrders(env, market, { symbol, limit: Number(url.searchParams.get("limit")) || undefined }, deps) });
    if (sub === "/fills" && req.method === "GET") return reply({ market, fills: await getFills(env, market, { symbol, startTime: Number(url.searchParams.get("startTime")) || undefined, endTime: Number(url.searchParams.get("endTime")) || undefined, limit: Number(url.searchParams.get("limit")) || undefined }, deps) });
    if (sub === "/trades" && req.method === "GET") {   // stored history, written by the sync
      const kv = env.ETI_EXECUTION_LOG as KV | undefined;
      if (!kv) return reply({ error: "storage_not_configured" }, 503);
      let fills = await readStoredFills(kv, market);
      if (symbol) fills = fills.filter((f) => f.symbol === symbol);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const cursor = await kv.get(`bitget:cursor:${market}`);
      return reply({ market, total: fills.length, lastSyncedFillAt: cursor ? new Date(Number(cursor)).toISOString() : null, fills: fills.slice(0, limit) });
    }
    if (sub === "/sync" && req.method === "POST") {
      const only = url.searchParams.get("market") ? [market] : undefined;
      const r = await syncAll(env, deps, only);
      return reply(r, r.ok ? 200 : (r as any).error === "storage_not_configured" ? 503 : 502);
    }
  } catch (e) { return fail(e); }
  return reply({ error: "not_found" }, 404);
}
