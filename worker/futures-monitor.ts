/**
 * Futures protective-stop monitor (Binance USD-M TESTNET). Runs from a Cron Trigger (every minute) or on demand.
 * Policy: a stop is placed ONLY for a position that ETI itself opened, using the stopPrice recorded in its audited order.
 * It never opens, increases, closes or transfers anything; it only adds a STOP_MARKET closePosition order and raises alerts.
 */
import { FUTURES_BASE } from "./futures.ts";
import type { FuturesEnv } from "./futures.ts";

export interface MonitorAlert { level: "warning" | "critical"; symbol: string; code: string; detail: string }
export interface MonitorAction { symbol: string; action: "place_protective_stop"; stopPrice: number; ok: boolean; detail?: string }
export interface MonitorResult { schema: "eti.futures.monitor/1"; at: string; ran: boolean; reason?: string; positions: Record<string, unknown>[]; alerts: MonitorAlert[]; actions: MonitorAction[] }

async function hmacHex(secret: string, q: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(q)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function signedReq(env: FuturesEnv, method: "GET" | "POST", path: string, params: Record<string, string>): Promise<Response> {
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" });
  q.set("signature", await hmacHex(env.BINANCE_FUTURES_SECRET_KEY as string, q.toString()));
  const headers = { "X-MBX-APIKEY": env.BINANCE_FUTURES_API_KEY as string };
  return method === "GET"
    ? fetch(FUTURES_BASE + path + "?" + q.toString(), { headers, signal: AbortSignal.timeout(6000) })
    : fetch(FUTURES_BASE + path, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: q.toString(), signal: AbortSignal.timeout(6000) });
}
const fmt = (n: number) => { const s = String(n); return /e/i.test(s) ? n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") : s; };

export async function runFuturesMonitor(env: FuturesEnv, now = Date.now()): Promise<MonitorResult> {
  const out: MonitorResult = { schema: "eti.futures.monitor/1", at: new Date(now).toISOString(), ran: false, positions: [], alerts: [], actions: [] };
  if (env.ETI_FUTURES_ENABLED !== "true") return { ...out, reason: "futures_disabled" };
  if (!env.BINANCE_FUTURES_API_KEY || !env.BINANCE_FUTURES_SECRET_KEY || !env.ETI_EXECUTION_LOG) return { ...out, reason: "not_configured" };
  const kv = env.ETI_EXECUTION_LOG;
  try {
    const pr = await signedReq(env, "GET", "/fapi/v2/positionRisk", {});
    if (!pr.ok) return { ...out, reason: "positions_unavailable" };
    const rows = ((await pr.json()) as any[]).filter((x) => Number(x.positionAmt) !== 0);
    out.ran = true;
    const oo = await signedReq(env, "GET", "/fapi/v1/openOrders", {}).catch(() => null);
    const open: any[] | null = oo && oo.ok ? ((await oo.json()) as any[]) : null;
    if (rows.length && !open) out.alerts.push({ level: "warning", symbol: "*", code: "open_orders_unavailable", detail: "Could not confirm existing stops; no stop was placed to avoid duplicates." });

    const recs: any[] = [];
    if (rows.length) {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const l: any = await kv.list({ prefix: "order:", limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const k of l.keys) { try { const r = JSON.parse((await kv.get(k.name)) || "null"); if (r && r.mode === "futures_testnet") recs.push(r); } catch { /* skip */ } }
        if (l.list_complete !== false || !l.cursor) break; cursor = l.cursor;
      }
      recs.sort((a, b) => String(b.executedAt).localeCompare(String(a.executedAt)));
    }
    for (const x of rows) {
      const sym = String(x.symbol), amt = Number(x.positionAmt), mark = Number(x.markPrice), liq = Number(x.liquidationPrice), long = amt > 0;
      const dist = liq > 0 && mark > 0 ? (Math.abs(mark - liq) / mark) * 100 : null;
      out.positions.push({ symbol: sym, direction: long ? "long" : "short", positionAmt: amt, entryPrice: Number(x.entryPrice), markPrice: mark, liquidationPrice: liq || null, liquidationDistancePct: dist, leverage: Number(x.leverage), marginType: x.marginType });
      if (dist !== null && dist < 15) out.alerts.push({ level: dist < 8 ? "critical" : "warning", symbol: sym, code: "liquidation_distance", detail: `Liquidation is ${dist.toFixed(1)}% from mark.` });
      if (!open) continue;
      const protectedAlready = open.some((o) => o.symbol === sym && o.type === "STOP_MARKET" && (o.closePosition === true || o.reduceOnly === true) && o.side === (long ? "SELL" : "BUY"));
      if (protectedAlready) continue;
      const rec = recs.find((r) => r.symbol === sym && r.type === "limit" && r.reduceOnly === false && r.side === (long ? "buy" : "sell") && typeof r.stopPrice === "number" && r.stopPrice > 0);
      if (!rec) { out.alerts.push({ level: "critical", symbol: sym, code: "unprotected_no_stop_on_record", detail: "Open position has no protective stop and no audited ETI order with a stopPrice; manage it manually." }); continue; }
      const stop = Number(rec.stopPrice);
      if (long ? stop >= mark : stop <= mark) { out.alerts.push({ level: "critical", symbol: sym, code: "stop_already_breached", detail: `Recorded stop ${stop} is already beyond mark ${mark}; no automatic action taken. Decide manually.` }); continue; }
      if (env.ETI_KILL_SWITCH === "true") { out.alerts.push({ level: "critical", symbol: sym, code: "unprotected_kill_switch_active", detail: "Position is unprotected and the kill switch blocks automatic stop placement." }); continue; }
      const clientOrderId = "stop-" + now.toString(36) + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const params = { symbol: sym, side: long ? "SELL" : "BUY", type: "STOP_MARKET", stopPrice: fmt(stop), closePosition: "true", workingType: "MARK_PRICE", newClientOrderId: clientOrderId };
      const r = await signedReq(env, "POST", "/fapi/v1/order", params).catch(() => null), data: any = r ? await r.json().catch(() => ({})) : {};
      const ok = !!r && r.ok;
      out.actions.push({ symbol: sym, action: "place_protective_stop", stopPrice: stop, ok, ...(ok ? {} : { detail: data?.msg ?? "request_failed" }) });
      if (ok) {
        const executedAt = new Date().toISOString();
        await kv.put("order:" + executedAt + ":" + clientOrderId, JSON.stringify({ executedAt, broker: "binance", mode: "futures_testnet", symbol: sym, side: params.side.toLowerCase(), type: "stop_market", quantity: null, stopPrice: stop, intent: "PROTECT", reduceOnly: true, closePosition: true, clientOrderId, brokerOrderId: data?.orderId ?? null, executionSource: { actorType: "system", actorId: "eti-futures-monitor", sourceName: "ETI Futures Protective Stop Monitor", strategyId: null, signalId: rec.clientOrderId ?? null, triggerReason: "Position without protective stop; stop from audited entry order" }, order: data }), { expirationTtl: 60 * 60 * 24 * 90 });
      } else out.alerts.push({ level: "critical", symbol: sym, code: "protective_stop_failed", detail: String(data?.msg ?? "Exchange rejected the stop order") });
    }
    await kv.put("futures:monitor", JSON.stringify(out), { expirationTtl: 60 * 60 * 24 });
    return out;
  } catch (e) { return { ...out, reason: "monitor_error:" + (e instanceof Error ? e.name : "unknown") }; }
}
