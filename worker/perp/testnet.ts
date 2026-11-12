/**
 * Binance USDT-M futures TESTNET (perp_testnet). ETI never simulates here: events are written only from what the exchange reported
 * (order response, order query, userTrades). Testnet keys are separate from spot testnet keys: BINANCE_FUTURES_API_KEY / BINANCE_FUTURES_SECRET_KEY.
 * Supported: market and limit orders, reduce-only, isolated margin, per-symbol leverage. Stop orders are not offered on testnet (Binance moved
 * conditional orders to a separate algo endpoint that this connector does not implement). Fills are recorded from userTrades only, so a fill is
 * never counted twice. Not verified against the live testnet from the build environment; the request and response handling is covered by mocked tests.
 */
import { hmacHex } from "../auth/credentials.ts";
import { ID, perpLedger, perpStore, validateInput, type PerpDeps, type PerpEnv, type PerpOrderInput } from "./engine.ts";
import { isActive, type Order, type PerpEvent } from "./ledger.ts";

export const FUTURES_TESTNET_BASE = "https://testnet.binancefuture.com";
const credsOf = (env: PerpEnv) => env.BINANCE_FUTURES_API_KEY && env.BINANCE_FUTURES_SECRET_KEY ? { key: env.BINANCE_FUTURES_API_KEY, secret: env.BINANCE_FUTURES_SECRET_KEY } : null;
export const testnetConfigured = (env: PerpEnv) => !!credsOf(env);
export interface Broker { ok: boolean; status: number | null; code: number | null; msg: string | null; data: any }

export async function signed(env: PerpEnv, deps: PerpDeps, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | boolean | undefined>, now: number): Promise<Broker> {
  const c = credsOf(env); if (!c) return { ok: false, status: null, code: null, msg: "credentials_missing", data: null };
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  q.set("recvWindow", "5000"); q.set("timestamp", String(now)); q.set("signature", await hmacHex(c.secret, q.toString()));
  try {
    const r = await (deps.fetchImpl ?? fetch)(FUTURES_TESTNET_BASE + path + (method === "POST" ? "" : "?" + q.toString()), { method, headers: { "X-MBX-APIKEY": c.key, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: method === "POST" ? q.toString() : undefined, signal: AbortSignal.timeout(10_000) });
    const text = await r.text(); let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) return { ok: false, status: r.status, code: typeof data?.code === "number" ? data.code : null, msg: typeof data?.msg === "string" ? data.msg.slice(0, 200) : "http_" + r.status, data };
    return { ok: true, status: r.status, code: null, msg: null, data };
  } catch (e) { return { ok: false, status: null, code: null, msg: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error", data: null }; }
}

const feeOf = (t: any): number | null => (t?.commissionAsset === "USDT" || t?.commissionAsset === "BUSD" || t?.commissionAsset === "USDC") && Number.isFinite(Number(t.commission)) && Number(t.commission) >= 0 ? Number(t.commission) : null;
/** Record any not-yet-recorded fills of one order from userTrades. Returns how many were new. */
async function pullFills(env: PerpEnv, deps: PerpDeps, st: ReturnType<typeof perpStore>, o: Order, now: number): Promise<number> {
  if (!o.brokerOrderId) return 0;
  const r = await signed(env, deps, "GET", "/fapi/v1/userTrades", { symbol: o.symbol, orderId: o.brokerOrderId, limit: 100 }, now); if (!r.ok || !Array.isArray(r.data)) return 0;
  let n = 0;
  for (const t of r.data) {
    const qty = Number(t.qty), price = Number(t.price); if (!(qty > 0) || !(price > 0) || t.id === undefined) continue;
    const ev: PerpEvent = { id: ID.fill + o.orderId + "-" + t.id, at: Math.max(Number(t.time) || now, o.createdAt + 1), t: "fill", orderId: o.orderId, fillId: String(t.id), qty, price, fee: feeOf(t), liquidity: t.maker ? "maker" : "taker", verified: true, origin: "exchange_testnet" };
    if (await st.append(ev as any, { idempotent: true })) n++;
  }
  return n;
}

export async function placeTestnet(env: PerpEnv, deps: PerpDeps, inp: PerpOrderInput, now: number) {
  const bad = validateInput(inp, 125);
  if (bad) return { ok: false as const, status: 400, code: "invalid_order", message: bad };
  if (inp.type === "stop") return { ok: false as const, status: 400, code: "stop_not_supported_on_testnet", message: "Stop orders are not offered on the futures testnet. Use a market or limit order, or the internal paper environment." };
  if (!credsOf(env)) return { ok: false as const, status: 503, code: "credentials_missing", message: "Set the BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_SECRET_KEY Worker secrets (futures testnet keys, separate from spot testnet keys)." };
  const st = perpStore(env, "perp_testnet"), orderId = "tperp-" + inp.clientOrderId, { ledger: L0 } = await perpLedger(st, "perp_testnet");
  if (L0.orders[orderId]) return { ok: false as const, status: 409, code: "duplicate_client_order_id", message: "This clientOrderId was already used." };
  if (!inp.reduceOnly) {   // isolated margin and leverage are set on the exchange before the order; a rejected setting stops the order
    const mt = await signed(env, deps, "POST", "/fapi/v1/marginType", { symbol: inp.symbol, marginType: "ISOLATED" }, now);
    if (!mt.ok && mt.code !== -4046) return { ok: false as const, status: 502, code: "margin_type_rejected", message: "Binance refused to set isolated margin: " + (mt.msg ?? "unknown") };
    const lv = await signed(env, deps, "POST", "/fapi/v1/leverage", { symbol: inp.symbol, leverage: inp.leverage }, now);
    if (!lv.ok) return { ok: false as const, status: 502, code: "leverage_rejected", message: "Binance refused the leverage setting: " + (lv.msg ?? "unknown") };
  }
  await st.append({ id: ID.init + "start", at: now, t: "init", startingBalance: 0, currency: "USDT", mmr: 0.005 } as any, { idempotent: true });
  await st.append({ id: ID.sub + orderId, at: now, t: "submitted", orderId, clientOrderId: inp.clientOrderId, symbol: inp.symbol, side: inp.side, type: inp.type, qty: inp.qty, limitPrice: inp.limitPrice ?? null, stopPrice: null, reduceOnly: inp.reduceOnly, leverage: inp.leverage, venue: "binance_futures_testnet", source: inp.source ?? "dashboard" } as any);
  const r = await signed(env, deps, "POST", "/fapi/v1/order", { symbol: inp.symbol, side: inp.side.toUpperCase(), type: inp.type === "market" ? "MARKET" : "LIMIT", quantity: inp.qty, price: inp.type === "limit" ? inp.limitPrice! : undefined, timeInForce: inp.type === "limit" ? "GTC" : undefined, reduceOnly: inp.reduceOnly ? "true" : undefined, newClientOrderId: orderId.slice(0, 36), newOrderRespType: "RESULT" }, now);
  if (!r.ok) {
    const definite = r.status !== null && r.status >= 400 && r.status < 500;
    if (definite) await st.append({ id: ID.end + orderId, at: now, t: "rejected", orderId, reason: "broker_rejected:" + (r.code ?? r.status) } as any, { idempotent: true });
    return { ok: false as const, status: definite ? 422 : 502, code: definite ? "broker_rejected" : "broker_unreachable", message: definite ? "Binance rejected the order: " + (r.msg ?? "unknown") : "The exchange did not answer. The order may or may not exist; it stays pending until a sync confirms it.", order: (await perpLedger(st, "perp_testnet")).ledger.orders[orderId] };
  }
  await st.append({ id: ID.acc + orderId, at: now, t: "accepted", orderId, brokerOrderId: String(r.data.orderId), status: "open" } as any, { idempotent: true });
  const fills = await pullFills(env, deps, st, { ...(await perpLedger(st, "perp_testnet")).ledger.orders[orderId] }, now);
  const status = String(r.data.status || "");
  if (["CANCELED", "EXPIRED", "REJECTED"].includes(status)) await st.append({ id: ID.end + orderId, at: now, t: status === "REJECTED" ? "rejected" : status === "EXPIRED" ? "expired" : "cancelled", orderId, reason: "broker_" + status.toLowerCase() } as any, { idempotent: true });
  return { ok: true as const, order: (await perpLedger(st, "perp_testnet")).ledger.orders[orderId], filledNow: fills > 0, brokerStatus: status };
}

export async function cancelTestnet(env: PerpEnv, deps: PerpDeps, orderId: string, now: number) {
  const st = perpStore(env, "perp_testnet"), o = (await perpLedger(st, "perp_testnet")).ledger.orders[orderId];
  if (!o) return { ok: false as const, status: 404, code: "order_not_found", message: "No such order." };
  if (!isActive(o)) return { ok: false as const, status: 409, code: "order_not_active", message: "The order is already " + o.status + "." };
  if (!o.brokerOrderId) return { ok: false as const, status: 409, code: "not_confirmed", message: "The exchange has not confirmed this order yet; sync first." };
  const r = await signed(env, deps, "DELETE", "/fapi/v1/order", { symbol: o.symbol, orderId: o.brokerOrderId }, now);
  if (!r.ok && r.code !== -2011) return { ok: false as const, status: 502, code: "broker_error", message: r.msg ?? "cancel failed" };
  await pullFills(env, deps, st, o, now);
  await st.append({ id: ID.end + orderId, at: now, t: "cancelled", orderId, reason: "user_cancelled" } as any, { idempotent: true });
  return { ok: true as const, order: (await perpLedger(st, "perp_testnet")).ledger.orders[orderId] };
}

/** Pull exchange state for every active order and record only what Binance reports. */
export async function syncTestnet(env: PerpEnv, deps: PerpDeps = {}, now = (deps.now ?? Date.now)()) {
  const out = { checked: 0, fills: 0, closed: 0, idle: true, error: null as string | null };
  if (!credsOf(env)) { out.error = "credentials_missing"; return out; }
  const st = perpStore(env, "perp_testnet"), { ledger: L } = await perpLedger(st, "perp_testnet");
  for (const o of Object.values(L.orders).filter(isActive)) {
    out.idle = false; out.checked++;
    if (!o.brokerOrderId) { if (now - o.createdAt > 120_000) { await st.append({ id: ID.end + o.orderId, at: now, t: "expired", orderId: o.orderId, reason: "never_confirmed" } as any, { idempotent: true }); out.closed++; } continue; }
    const r = await signed(env, deps, "GET", "/fapi/v1/order", { symbol: o.symbol, orderId: o.brokerOrderId }, now);
    if (!r.ok) { if (r.code === -2013) { await st.append({ id: ID.end + o.orderId, at: now, t: "rejected", orderId: o.orderId, reason: "unknown_to_broker" } as any, { idempotent: true }); out.closed++; } else out.error = r.msg; continue; }
    out.fills += await pullFills(env, deps, st, o, now);
    const s = String(r.data?.status || "");
    if (["CANCELED", "EXPIRED", "REJECTED"].includes(s)) { await st.append({ id: ID.end + o.orderId, at: now, t: s === "REJECTED" ? "rejected" : s === "EXPIRED" ? "expired" : "cancelled", orderId: o.orderId, reason: "broker_" + s.toLowerCase() } as any, { idempotent: true }); out.closed++; }
  }
  return out;
}

/** Compare the ledger with the exchange's own position report. Differences are reported, never silently corrected. */
export async function reconcileTestnet(env: PerpEnv, deps: PerpDeps, now: number) {
  const r = await signed(env, deps, "GET", "/fapi/v2/positionRisk", {}, now); if (!r.ok || !Array.isArray(r.data)) return { ok: false as const, problems: ["could not read positionRisk: " + (r.msg ?? "unknown")] };
  const { ledger: L } = await perpLedger(perpStore(env, "perp_testnet"), "perp_testnet"), problems: string[] = [], seen = new Set<string>();
  for (const x of r.data) { const amt = Number(x.positionAmt); if (!amt) continue; seen.add(x.symbol); const p = L.positions[x.symbol], mine = p ? (p.side === "long" ? p.qty : -p.qty) : 0; if (Math.abs(mine - amt) > 1e-9) problems.push(x.symbol + ": exchange " + amt + " vs ETI ledger " + mine); }
  for (const p of Object.values(L.positions)) if (!seen.has(p.symbol)) problems.push(p.symbol + ": ETI ledger shows " + p.side + " " + p.qty + " but the exchange reports none");
  return { ok: true as const, problems, checkedAt: now };
}
