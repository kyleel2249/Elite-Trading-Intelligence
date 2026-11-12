import test from "node:test";
import assert from "node:assert/strict";
import { runFuturesMonitor } from "./futures-monitor.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const pos = (o: any = {}) => ({ symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", markPrice: "100", liquidationPrice: "50", leverage: "3", marginType: "isolated", unRealizedProfit: "0", ...o });
const entry = (o: any = {}) => ({ executedAt: "2026-11-09T10:00:00.000Z", mode: "futures_testnet", symbol: "BTCUSDT", side: "buy", type: "limit", reduceOnly: false, stopPrice: 98, clientOrderId: "fut-test-0001", ...o });

function harness(o: { positions?: any[]; openOrders?: any[] | null; audit?: any[]; enabled?: boolean; kill?: boolean } = {}) {
  const calls: { m: string; u: string; body: string }[] = [], kv = new Map<string, string>();
  (o.audit ?? []).forEach((r, i) => kv.set("order:" + r.executedAt + ":id" + i, JSON.stringify(r)));
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  const stub = (async (input: any, init?: any) => {
    const u = String(input); calls.push({ m: init?.method ?? "GET", u: u.split("?")[0], body: String(init?.body ?? "") });
    if (u.includes("/fapi/v2/positionRisk")) return json(o.positions ?? []);
    if (u.includes("/fapi/v1/openOrders")) return o.openOrders === null ? json({}, 500) : json(o.openOrders ?? []);
    if (u.includes("/fapi/v1/order")) return json({ orderId: 9, status: "NEW" });
    return json({}, 404);
  }) as any;
  const env: any = { ETI_FUTURES_ENABLED: o.enabled === false ? "false" : "true", ETI_KILL_SWITCH: o.kill ? "true" : "false", BINANCE_FUTURES_API_KEY: "k", BINANCE_FUTURES_SECRET_KEY: "s", ETI_EXECUTION_LOG: { put: async (k: string, v: string) => { kv.set(k, v); }, get: async (k: string) => kv.get(k) ?? null, list: async (p: any) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(p?.prefix ?? "")).map((name) => ({ name })), list_complete: true }) } };
  const run = async () => { const real = globalThis.fetch; globalThis.fetch = stub; try { return await runFuturesMonitor(env, NOW); } finally { globalThis.fetch = real; } };
  return { calls, kv, run };
}
const orders = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.m === "POST" && c.u.endsWith("/fapi/v1/order"));

test("monitor places a protective STOP_MARKET for an unprotected ETI-opened long, using the audited stop", async () => {
  const h = harness({ positions: [pos()], audit: [entry()] }), r = await h.run();
  assert.equal(r.ran, true); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].ok, true); assert.equal(r.actions[0].stopPrice, 98);
  const o = orders(h); assert.equal(o.length, 1);
  for (const part of ["type=STOP_MARKET", "side=SELL", "closePosition=true", "stopPrice=98", "workingType=MARK_PRICE"]) assert.ok(o[0].body.includes(part), part);
  assert.ok(!o[0].body.includes("quantity"), "closePosition orders carry no quantity");
  assert.ok(h.calls.every((c) => c.u.startsWith("https://testnet.binancefuture.com")));
  assert.ok([...h.kv.keys()].some((k) => k.startsWith("order:") && JSON.parse(h.kv.get(k)!).intent === "PROTECT")); assert.ok(h.kv.has("futures:monitor"));
});

test("monitor protects shorts with a BUY stop and skips already-protected positions", async () => {
  const s = harness({ positions: [pos({ positionAmt: "-1" })], audit: [entry({ side: "sell", stopPrice: 102 })] }), r = await s.run();
  assert.equal(r.actions[0].stopPrice, 102); assert.ok(orders(s)[0].body.includes("side=BUY"));
  const p = harness({ positions: [pos()], audit: [entry()], openOrders: [{ symbol: "BTCUSDT", type: "STOP_MARKET", side: "SELL", closePosition: true }] }); await p.run();
  assert.equal(orders(p).length, 0);
});

test("monitor never invents a stop: no record, breached stop, unconfirmed orders, kill switch", async () => {
  let h = harness({ positions: [pos()], audit: [] }), r = await h.run();
  assert.equal(orders(h).length, 0); assert.ok(r.alerts.some((a) => a.code === "unprotected_no_stop_on_record" && a.level === "critical"));
  h = harness({ positions: [pos()], audit: [entry({ stopPrice: 101 })] }); r = await h.run();
  assert.equal(orders(h).length, 0); assert.ok(r.alerts.some((a) => a.code === "stop_already_breached"));
  h = harness({ positions: [pos()], audit: [entry()], openOrders: null }); r = await h.run();
  assert.equal(orders(h).length, 0); assert.ok(r.alerts.some((a) => a.code === "open_orders_unavailable"));
  h = harness({ positions: [pos()], audit: [entry()], kill: true }); r = await h.run();
  assert.equal(orders(h).length, 0); assert.ok(r.alerts.some((a) => a.code === "unprotected_kill_switch_active"));
  h = harness({ positions: [pos()], audit: [entry({ side: "sell" })] }); r = await h.run();
  assert.equal(orders(h).length, 0, "a short-side record must not protect a long");
});

test("monitor raises liquidation-distance alerts and is a no-op when disabled", async () => {
  const h = harness({ positions: [pos({ liquidationPrice: "95" })], audit: [entry()], openOrders: [{ symbol: "BTCUSDT", type: "STOP_MARKET", side: "SELL", closePosition: true }] }), r = await h.run();
  assert.ok(r.alerts.some((a) => a.code === "liquidation_distance" && a.level === "critical"));
  const d = harness({ positions: [pos()], enabled: false }), rd = await d.run();
  assert.equal(rd.ran, false); assert.equal(rd.reason, "futures_disabled"); assert.equal(d.calls.length, 0);
});
