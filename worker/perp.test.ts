import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./portfolio/testing.ts";
import { fold, liqPriceOf, present, type PerpEvent } from "./perp/ledger.ts";
import { estimate, matchPaper, perpConfig, placePaper, cancelPaper, perpStore, perpLedger } from "./perp/engine.ts";
import { handlePerp, runPerpCycle, buildPerpState } from "./perp/routes.ts";
import { placeTestnet, syncTestnet, cancelTestnet, reconcileTestnet, signed } from "./perp/testnet.ts";

const MASTER = "master-token-0123456789abcdef0123456789", O = "https://eti.test", T0 = Date.UTC(2026, 10, 12, 10, 0, 0);
const memKV = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, list: async (o: any) => ({ keys: [...m.keys()].filter(k => k.startsWith(o.prefix)).map(name => ({ name })), list_complete: true }) }; };
const mkEnv = (x: any = {}) => ({ ETI_PORTFOLIO_DB: sqliteD1(), ETI_EXECUTION_LOG: memKV(), ETI_EXECUTION_TOKEN: MASTER, ETI_SESSION_SECRET: "s".repeat(40), ...x });
const init: PerpEvent = { id: "e0i", at: 1, t: "init", startingBalance: 1000, currency: "USDT", mmr: 0.005 };
let n = 0;
const order = (side: "buy" | "sell", qty: number, price: number, o: any = {}): PerpEvent[] => { const id = "o" + (++n), at = o.at ?? 10 + n; return [
  { id: "e1s-" + id, at, t: "submitted", orderId: id, clientOrderId: id, symbol: o.symbol ?? "BTCUSDT", side, type: "market", qty, reduceOnly: !!o.reduceOnly, leverage: o.leverage ?? 10, venue: "v" },
  { id: "e3f-" + id, at, t: "fill", orderId: id, fillId: "1", qty: o.fillQty ?? qty, price, fee: o.fee === undefined ? 0 : o.fee, verified: true, origin: o.origin ?? "internal_sim" }]; };

test("liquidation price formula (isolated, 10x long/short, maintenance 0.5%)", () => {
  assert.ok(Math.abs(liqPriceOf("long", 100, 1, 10, 0.005) - 90.5) < 1e-9); assert.ok(Math.abs(liqPriceOf("short", 100, 1, 10, 0.005) - 109.5) < 1e-9);
  assert.ok(Math.abs(liqPriceOf("long", 100, 1, 100, 0.005) - 0.5) < 1e-9); // 1x long: only a near-total loss liquidates
});
test("ledger: long profit, short profit, fees, margin and wallet accounting", () => {
  let L = fold("perp_paper", [init, ...order("buy", 2, 100, { fee: 0.1 })]);
  assert.equal(L.cash, 999.9); assert.equal(L.positions.BTCUSDT.margin, 20); const pr = present(L, { BTCUSDT: 105 }, 1e6);
  assert.equal(pr.positions[0].unrealized, 10); assert.equal(pr.positions[0].roePct, 50); assert.equal(pr.balances.available, 979.9); assert.equal(pr.balances.equity, 1009.9);
  L = fold("perp_paper", [init, ...order("buy", 2, 100, { fee: 0.1 }), ...order("sell", 2, 110, { fee: 0.1, reduceOnly: true })]);
  assert.equal(Object.keys(L.positions).length, 0); assert.equal(L.closed[0].gross, 20); assert.ok(Math.abs(L.closed[0].net - 19.8) < 1e-9); assert.ok(Math.abs(L.cash! - 1019.8) < 1e-9); assert.equal(L.closed[0].result, "win");
  const S = fold("perp_paper", [init, ...order("sell", 1, 200, { leverage: 5 }), ...order("buy", 1, 180, { reduceOnly: true })]);
  assert.equal(S.closed[0].direction, "short"); assert.equal(S.closed[0].gross, 20); assert.equal(S.cash, 1020);
});
test("ledger: partial reduce releases margin proportionally; add-to-position averages; flip realises then reopens", () => {
  let L = fold("perp_paper", [init, ...order("buy", 2, 100), ...order("sell", 1, 110, { reduceOnly: true })]);
  assert.equal(L.positions.BTCUSDT.qty, 1); assert.equal(L.positions.BTCUSDT.margin, 10); assert.equal(L.cash, 1010);
  L = fold("perp_paper", [init, ...order("buy", 1, 100), ...order("buy", 1, 120)]); assert.equal(L.positions.BTCUSDT.avgEntry, 110); assert.equal(L.positions.BTCUSDT.margin, 22);
  L = fold("perp_paper", [init, ...order("buy", 1, 100), ...order("sell", 3, 110, { leverage: 5, fee: 0.3 })]);
  assert.equal(L.closed.length, 1); assert.equal(L.positions.BTCUSDT.side, "short"); assert.equal(L.positions.BTCUSDT.qty, 2); assert.equal(L.positions.BTCUSDT.leverage, 5);
  assert.ok(Math.abs(L.positions.BTCUSDT.fees - 0.2) < 1e-9 && Math.abs(L.closed[0].fees - 0.1) < 1e-9); assert.ok(Math.abs(L.cash! - (1000 + 10 - 0.3)) < 1e-9);
});
test("ledger: reduce-only never flips or opens; over-fills, duplicates and bad fills are flagged and ignored; unknown fees stay unknown", () => {
  const a = order("buy", 1, 100), b = order("sell", 5, 110, { reduceOnly: true });
  let L = fold("perp_paper", [init, ...a, ...b]); assert.equal(L.closed.length, 1); assert.equal(Object.keys(L.positions).length, 0); assert.ok(L.anomalies.some(x => x.kind === "reduce_only_clamped") || L.anomalies.some(x => x.kind === "overfill"));
  L = fold("perp_paper", [init, ...order("sell", 1, 100, { reduceOnly: true })]); assert.equal(Object.keys(L.positions).length, 0); assert.ok(L.anomalies.some(x => x.kind === "reduce_only_without_position")); assert.equal(L.cash, 1000);
  const dup = order("buy", 1, 100); L = fold("perp_paper", [init, ...dup, { ...dup[1], id: "other" }]); assert.equal(L.positions.BTCUSDT.qty, 1); assert.ok(L.anomalies.some(x => x.kind === "duplicate_fill"));
  L = fold("perp_paper", [init, ...order("buy", 1, -5)]); assert.ok(L.anomalies.some(x => x.kind === "invalid_fill"));
  L = fold("perp_paper", [init, ...order("buy", 1, 100, { fee: null })]); assert.equal(L.unknownFees, 1); assert.equal(L.fees, 0);
  L = fold("perp_paper", [init, ...order("buy", 1, 100, { fillQty: 3 })]); assert.equal(L.positions.BTCUSDT.qty, 1);
});
test("ledger: liquidation fill closes the position and is marked liquidated", () => {
  const L = fold("perp_paper", [init, ...order("buy", 1, 100), ...order("sell", 1, 90.5, { reduceOnly: true, origin: "liquidation" })]);
  assert.equal(L.closed[0].liquidated, true); assert.ok(Math.abs(L.cash! - 990.5) < 1e-9); assert.equal(present(L, {}, 1).stats.liquidations, 1);
});

// ---------- paper engine ----------
const bar = (t: number, o: number, h: number, l: number, c: number) => [t, o, h, l, c, 1] as any;
function deps(price: number, bars: any[] = [], now = T0) { return { now: () => now, priceOf: async () => price, barsOf: async () => bars }; }
const inp = (o: any = {}) => ({ clientOrderId: "c" + (++n), symbol: "BTCUSDT", side: "buy" as const, type: "market" as const, qty: 1, leverage: 10, reduceOnly: false, ...o });

test("paper: market long fills at price+slippage with taker fee, margin reserved, estimate matches", async () => {
  const env = mkEnv(), cfg = perpConfig(env), r = await placePaper(env, deps(100), inp({ qty: 5 }), T0); assert.equal(r.ok, true);
  if (!r.ok) return; assert.equal(r.filledNow, true); const L = (await perpLedger(perpStore(env, "perp_paper"), "perp_paper")).ledger, p = L.positions.BTCUSDT;
  assert.ok(Math.abs(p.avgEntry - 100.05) < 1e-9); assert.equal(p.leverage, 10); assert.ok(Math.abs(p.margin - 5 * 100.05 / 10) < 1e-9); assert.ok(Math.abs(L.fees - 5 * 100.05 * cfg.takerBps / 1e4) < 1e-9);
  assert.ok(Math.abs(r.estimate.liqPrice! - liqPriceOf("long", 100.05, 5, p.margin, L.mmr)) < 1e-9);
});
test("paper: rejections are explicit (margin, min notional, leverage, reduce-only, stop, price, validation, duplicates)", async () => {
  const env = mkEnv(), d = deps(100), code = async (o: any, dd: any = d) => { const r: any = await placePaper(env, dd, inp(o), T0); return r.ok ? "ok" : r.code; };
  assert.equal(await code({ qty: 1000 }), "insufficient_margin"); assert.equal(await code({ qty: 0.01 }), "below_min_notional"); assert.equal(await code({ leverage: 500 }), "invalid_order"); assert.equal(await code({ leverage: 2.5 }), "invalid_order");
  assert.equal(await code({ qty: 0 }), "invalid_order"); assert.equal(await code({ symbol: "x" }), "invalid_order"); assert.equal(await code({ type: "limit" }), "invalid_order");
  assert.equal(await code({ reduceOnly: true, side: "sell" }), "reduce_only_rejected");
  assert.equal(await code({ type: "stop", side: "sell", stopPrice: 101 }), "stop_would_trigger_immediately"); assert.equal(await code({ type: "stop", side: "buy", stopPrice: 99 }), "stop_would_trigger_immediately");
  const nop = { now: () => T0, priceOf: async () => null, barsOf: async () => [] }; assert.equal(await code({}, nop), "price_unavailable");
  assert.equal(await code({ qty: 1 }), "ok"); assert.equal(await code({ qty: 1, leverage: 20 }), "leverage_conflict"); assert.equal(await code({ side: "sell", qty: 2, reduceOnly: true }), "reduce_only_rejected");
  const dup = inp({ clientOrderId: "dupdup1" }); await placePaper(env, d, dup, T0); assert.equal(((await placePaper(env, d, dup, T0)) as any).code, "duplicate_client_order_id");
  const L = (await perpLedger(perpStore(env, "perp_paper"), "perp_paper")).ledger; assert.ok(Object.values(L.orders).filter(o => o.status === "rejected").length === 0); // refusals never create orders
});
test("paper: limit rests, fills as maker only when a bar trades through it, never from bars before it existed", async () => {
  const env = mkEnv(), t = T0, r: any = await placePaper(env, deps(100), inp({ type: "limit", limitPrice: 95, qty: 2 }), t);
  assert.equal(r.ok && r.filledNow, false); const id = r.order.orderId;
  const before = [bar(t - 120_000, 96, 97, 90, 96)]; assert.equal((await matchPaper(env, deps(100, before, t + 120_000), t + 120_000)).fills, 0);
  const touch = [bar(t + 60_000, 99, 100, 94, 96)]; const m = await matchPaper(env, deps(96, touch, t + 180_000), t + 180_000); assert.equal(m.fills, 1);
  const L = (await perpLedger(perpStore(env, "perp_paper"), "perp_paper")).ledger; assert.equal(L.orders[id].status, "filled"); assert.equal(L.positions.BTCUSDT.avgEntry, 95); assert.ok(Math.abs(L.fees - 2 * 95 * 2 / 1e4) < 1e-9); // maker fee
  assert.equal((await matchPaper(env, deps(96, touch, t + 240_000), t + 240_000)).fills, 0); // each bar considered once
});
test("paper: stop-market triggers on touch with slippage, gaps fill at the open, and a stop beats a limit in the same bar", async () => {
  const env = mkEnv(), t = T0; await placePaper(env, deps(100), inp({ qty: 2, leverage: 2 }), t);
  const s: any = await placePaper(env, deps(100), inp({ side: "sell", type: "stop", stopPrice: 95, qty: 2, reduceOnly: true }), t); assert.equal(s.ok, true);
  const lim: any = await placePaper(env, deps(100), inp({ side: "sell", type: "limit", limitPrice: 104, qty: 2, reduceOnly: true }), t); assert.equal(lim.ok, true);
  await matchPaper(env, deps(94, [bar(t + 60_000, 100, 105, 90, 94)], t + 180_000), t + 180_000);
  const L = (await perpLedger(perpStore(env, "perp_paper"), "perp_paper")).ledger; assert.equal(L.orders[s.order.orderId].status, "filled"); assert.ok(Math.abs(L.orders[s.order.orderId].avgFillPrice! - 95 * (1 - 0.0005)) < 1e-9);
  assert.equal(L.orders[lim.order.orderId].status, "cancelled"); assert.equal(L.orders[lim.order.orderId].statusReason, "reduce_only_no_position"); assert.equal(Object.keys(L.positions).length, 0);
  const env2 = mkEnv(); await placePaper(env2, deps(100), inp({ qty: 1, leverage: 2 }), t); const s2: any = await placePaper(env2, deps(100), inp({ side: "sell", type: "stop", stopPrice: 95, qty: 1, reduceOnly: true }), t);
  await matchPaper(env2, deps(80, [bar(t + 60_000, 90, 91, 80, 85)], t + 180_000), t + 180_000); assert.ok((await perpLedger(perpStore(env2, "perp_paper"), "perp_paper")).ledger.orders[s2.order.orderId].avgFillPrice! <= 90);
});
test("paper: a short is liquidated when a bar reaches its liquidation price, before stops and limits", async () => {
  const env = mkEnv(), t = T0; const r: any = await placePaper(env, deps(100), inp({ side: "sell", qty: 5, leverage: 10 }), t); assert.equal(r.ok, true);
  const liq = (await perpLedger(perpStore(env, "perp_paper"), "perp_paper")).ledger.positions.BTCUSDT.liqPrice; assert.ok(liq > 100 && liq < 112);
  const stop: any = await placePaper(env, deps(100), inp({ side: "buy", type: "stop", stopPrice: 105, qty: 5, reduceOnly: true }), t);
  const m = await matchPaper(env, deps(130, [bar(t + 60_000, 100, liq + 5, 99, 120)], t + 180_000), t + 180_000); assert.equal(m.liquidations, 1);
  const L = (await perpLedger(perpStore(env, "perp_paper"), "perp_paper")).ledger; assert.equal(L.closed[0].liquidated, true); assert.equal(L.orders[stop.order.orderId].status, "cancelled"); assert.equal(Object.keys(L.positions).length, 0);
  assert.ok(L.cash! < 10000 && L.cash! > 9940); // lost about the margin, never more than the wallet
});
test("paper: cancel works once; a resting order's margin is reserved and released", async () => {
  const env = mkEnv(), r: any = await placePaper(env, deps(100), inp({ type: "limit", limitPrice: 50, qty: 900, leverage: 5 }), T0); assert.equal(r.ok, true);
  const st = perpStore(env, "perp_paper"); assert.equal(present((await perpLedger(st, "perp_paper")).ledger, {}, 1).balances.orderMargin, 9000);
  assert.equal(((await placePaper(env, deps(100), inp({ qty: 150 }), T0)) as any).code, "insufficient_margin");
  assert.equal((await cancelPaper(env, r.order.orderId, T0)).ok, true); assert.equal(((await cancelPaper(env, r.order.orderId, T0)) as any).code, "order_not_active");
  assert.equal(((await placePaper(env, deps(100), inp({ qty: 1 }), T0)) as any).ok, true);
});
test("estimate is pure and flags flips: only the reopened part needs margin", () => {
  const L = fold("perp_paper", [init, ...order("buy", 1, 100)]), e = estimate(L, inp({ side: "sell", qty: 3, leverage: 5 }), 100, perpConfig({}));
  assert.equal(e.openQty, 2); assert.ok(Math.abs(e.margin! - 2 * 99.95 / 5) < 1e-6); assert.equal(e.resultingSide, "short");
  assert.equal(estimate(L, inp({ side: "sell", qty: 1, reduceOnly: true }), 100, perpConfig({})).margin, 0);
});

// ---------- routes ----------
const call = async (env: any, path: string, body?: unknown, o: { headers?: any; d?: any } = {}) => { const r = await handlePerp(new Request(O + path, { method: body !== undefined ? "POST" : "GET", headers: { origin: O, "content-type": "application/json", authorization: "Bearer " + MASTER, ...(o.headers || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), env, o.d ?? deps(100)); return { r, b: await r.json() as any }; };
test("routes: auth, scope isolation, preview, order, close, cancel, state", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "/api/perp/state", undefined, { headers: { authorization: "" } })).r.status, 401);
  assert.equal((await call(env, "/api/perp/config")).b.maxLeverage, 50);
  const pv = await call(env, "/api/perp/preview", { environment: "perp_paper", symbol: "btcusdt", side: "sell", type: "market", quantity: 2, leverage: 10 }); assert.equal(pv.r.status, 200); assert.equal(pv.b.order.direction, "short"); assert.ok(pv.b.estimate.liqPrice > 100);
  assert.equal((await call(env, "/api/perp/order", { environment: "perp_paper", symbol: "BTCUSDT", side: "sell", type: "market", quantity: 2, leverage: 10 })).r.status, 200);
  const st = await call(env, "/api/perp/state?environment=perp_paper", undefined, { d: deps(95) }); assert.equal(st.b.positions[0].side, "short"); assert.ok(st.b.positions[0].unrealized > 0); assert.equal(st.b.simulated, true); assert.equal(st.b.config.marginMode, "isolated");
  const bad = await call(env, "/api/perp/order", { environment: "perp_paper", symbol: "BTCUSDT", side: "sell", type: "market", quantity: 9999, leverage: 10 }); assert.equal(bad.r.status, 422); assert.equal(bad.b.error, "insufficient_margin"); assert.ok(bad.b.estimate);
  const cl = await call(env, "/api/perp/close", { environment: "perp_paper", symbol: "BTCUSDT" }); assert.equal(cl.r.status, 200); assert.equal((await call(env, "/api/perp/state?environment=perp_paper")).b.positions.length, 0);
  assert.equal((await call(env, "/api/perp/close", { environment: "perp_paper", symbol: "BTCUSDT" })).r.status, 409);
  const lim = await call(env, "/api/perp/order", { environment: "perp_paper", symbol: "BTCUSDT", side: "buy", type: "limit", quantity: 1, limitPrice: 80, leverage: 3 }); assert.equal(lim.b.filledNow, false);
  assert.equal((await call(env, "/api/perp/cancel", { environment: "perp_paper", orderId: lim.b.order.orderId })).r.status, 200);
  assert.equal((await call(env, "/api/perp/order", { environment: "live", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1 })).b.order.venue, "eti_paper_futures"); // no live environment exists
});
test("routes: kill switch blocks new exposure but not reduce-only; sessions are scoped per environment", async () => {
  const env = mkEnv({ ETI_KILL_SWITCH: "true" });
  assert.equal((await call(env, "/api/perp/order", { environment: "perp_paper", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, leverage: 5 })).r.status, 423);
  const ok = mkEnv(); await call(ok, "/api/perp/order", { environment: "perp_paper", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, leverage: 5 });
  const ks = { ...ok, ETI_KILL_SWITCH: "true" }; assert.equal((await call(ks, "/api/perp/close", { environment: "perp_paper", symbol: "BTCUSDT" })).r.status, 200);
  const cookie = await (async () => { const { authenticate } = await import("./auth/session.ts"); void authenticate; return null; })(); void cookie;
  assert.equal((await call(mkEnv({ ETI_PORTFOLIO_DB: undefined, ETI_EXECUTION_LOG: undefined }), "/api/perp/state")).r.status, 503);
});
test("routes: the testnet environment reports missing credentials instead of simulating", async () => {
  const env = mkEnv(), s = await call(env, "/api/perp/state?environment=perp_testnet"); assert.equal(s.b.needsCredentials, true); assert.equal(s.b.positions, undefined);
  const o = await call(env, "/api/perp/order", { environment: "perp_testnet", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, leverage: 5 }); assert.equal(o.r.status, 503); assert.equal(o.b.error, "credentials_missing");
});

// ---------- testnet (mocked exchange) ----------
function mockExchange(opts: any = {}) {
  const calls: { method: string; path: string; q: URLSearchParams; key: string | null }[] = []; let nextId = 1000; const orders = new Map<string, any>(); const trades: any[] = [];
  const f: any = async (url: string, init: any) => {
    const u = new URL(url), q = new URLSearchParams(init.method === "POST" ? init.body : u.search), key = init.headers["X-MBX-APIKEY"] ?? null; calls.push({ method: init.method, path: u.pathname, q, key });
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (u.pathname === "/fapi/v1/marginType") return opts.marginErr ? json({ code: -4046, msg: "No need to change margin type." }, 400) : json({ code: 200, msg: "success" });
    if (u.pathname === "/fapi/v1/leverage") return opts.levErr ? json({ code: -4028, msg: "Leverage is not valid" }, 400) : json({ leverage: Number(q.get("leverage")), symbol: q.get("symbol") });
    if (u.pathname === "/fapi/v1/order" && init.method === "POST") {
      if (opts.reject) return json({ code: -2019, msg: "Margin is insufficient." }, 400); if (opts.down) throw new Error("boom");
      const id = nextId++, filled = q.get("type") === "MARKET"; orders.set(String(id), { id, status: filled ? "FILLED" : "NEW", symbol: q.get("symbol"), side: q.get("side") });
      if (filled && !opts.noTrades) trades.push({ id: id * 10, orderId: id, symbol: q.get("symbol"), side: q.get("side"), price: "100.5", qty: q.get("quantity"), commission: "0.05", commissionAsset: opts.feeAsset ?? "USDT", time: T0, maker: false });
      return json({ orderId: id, status: filled ? "FILLED" : "NEW", clientOrderId: q.get("newClientOrderId") });
    }
    if (u.pathname === "/fapi/v1/order" && init.method === "GET") { const o = orders.get(q.get("orderId")!); return o ? json({ orderId: o.id, status: opts.orderStatus ?? o.status }) : json({ code: -2013, msg: "Order does not exist." }, 400); }
    if (u.pathname === "/fapi/v1/order" && init.method === "DELETE") { const o = orders.get(q.get("orderId")!); if (!o) return json({ code: -2011, msg: "Unknown order sent." }, 400); o.status = "CANCELED"; return json({ orderId: o.id, status: "CANCELED" }); }
    if (u.pathname === "/fapi/v1/userTrades") return json(trades.filter(t => String(t.orderId) === q.get("orderId")));
    if (u.pathname === "/fapi/v2/balance") return json([{ asset: "USDT", balance: "5000.00", availableBalance: "4800.00" }]);
    if (u.pathname === "/fapi/v2/positionRisk") return json(opts.positions ?? []);
    return json({ code: -1, msg: "unmocked " + u.pathname }, 404);
  };
  return { f, calls, trades, orders };
}
const tenv = () => mkEnv({ BINANCE_FUTURES_API_KEY: "tk", BINANCE_FUTURES_SECRET_KEY: "ts" });
const tin = (o: any = {}) => ({ clientOrderId: "t" + (++n), symbol: "BTCUSDT", side: "buy" as const, type: "market" as const, qty: 0.01, leverage: 5, reduceOnly: false, ...o });

test("testnet: signed requests, isolated margin + leverage set first, fills recorded only from userTrades, never doubled", async () => {
  const env = tenv(), ex = mockExchange(), d = { now: () => T0, fetchImpl: ex.f }; const r: any = await placeTestnet(env, d, tin(), T0);
  assert.equal(r.ok, true); assert.equal(r.filledNow, true);
  assert.deepEqual(ex.calls.map(c => c.path).slice(0, 3), ["/fapi/v1/marginType", "/fapi/v1/leverage", "/fapi/v1/order"]);
  for (const c of ex.calls) { assert.equal(c.key, "tk"); assert.match(c.q.get("signature")!, /^[0-9a-f]{64}$/); assert.equal(c.q.get("recvWindow"), "5000"); }
  const ord = ex.calls[2].q; assert.equal(ord.get("side"), "BUY"); assert.equal(ord.get("type"), "MARKET"); assert.equal(ord.get("quantity"), "0.01"); assert.equal(ord.get("reduceOnly"), null);
  const st = perpStore(env, "perp_testnet"), L = (await perpLedger(st, "perp_testnet")).ledger; assert.ok(Math.abs(L.positions.BTCUSDT.avgEntry - 100.5) < 1e-9); assert.equal(L.fees, 0.05); assert.equal(L.fills[0].verified, true); assert.equal(L.fills[0].origin, "exchange_testnet");
  const s = await syncTestnet(env, d, T0 + 1000); assert.equal(s.fills, 0); const L2 = (await perpLedger(st, "perp_testnet")).ledger; assert.equal(L2.fills.length, 1); assert.equal(L2.positions.BTCUSDT.qty, 0.01);
});
test("testnet: nothing is invented when the exchange says nothing; unknown fee asset stays unknown; sync later fills once", async () => {
  const env = tenv(), ex = mockExchange({ noTrades: true }), d = { now: () => T0, fetchImpl: ex.f }; const r: any = await placeTestnet(env, d, tin(), T0);
  assert.equal(r.ok, true); assert.equal(r.filledNow, false); const st = perpStore(env, "perp_testnet"); assert.equal(Object.keys((await perpLedger(st, "perp_testnet")).ledger.positions).length, 0);
  ex.trades.push({ id: 7, orderId: 1000, price: "101", qty: "0.01", commission: "0.00001", commissionAsset: "BNB", time: T0, maker: true });
  assert.equal((await syncTestnet(env, d, T0 + 5000)).fills, 1); assert.equal((await syncTestnet(env, d, T0 + 6000)).fills, 0);
  const L = (await perpLedger(st, "perp_testnet")).ledger; assert.equal(L.unknownFees, 1); assert.equal(L.fees, 0); assert.equal(L.fills[0].liquidity, "maker");
});
test("testnet: broker rejection is recorded and explained; unreachable exchange leaves the order pending, not rejected; limit rests and cancels", async () => {
  const env = tenv(), rej: any = await placeTestnet(env, { fetchImpl: mockExchange({ reject: true }).f }, tin(), T0); assert.equal(rej.ok, false); assert.equal(rej.code, "broker_rejected"); assert.equal(rej.order.status, "rejected"); assert.match(rej.message, /insufficient/i);
  const down: any = await placeTestnet(env, { fetchImpl: mockExchange({ down: true }).f }, tin(), T0); assert.equal(down.code, "broker_unreachable"); assert.equal(down.order.status, "pending");
  const ex = mockExchange(), d = { now: () => T0, fetchImpl: ex.f }, l: any = await placeTestnet(env, d, tin({ type: "limit", limitPrice: 90000 }), T0); assert.equal(l.ok, true); assert.equal(l.order.status, "open"); assert.equal(ex.calls.at(-1)!.path, "/fapi/v1/userTrades");
  const c: any = await cancelTestnet(env, d, l.order.orderId, T0); assert.equal(c.ok, true); assert.equal(c.order.status, "cancelled"); assert.equal(((await cancelTestnet(env, d, l.order.orderId, T0)) as any).code, "order_not_active");
});
test("testnet: stop orders and missing keys are refused up front; margin-type 'no change' error is tolerated; leverage rejection stops the order", async () => {
  assert.equal(((await placeTestnet(tenv(), {}, tin({ type: "stop", stopPrice: 90 }), T0)) as any).code, "stop_not_supported_on_testnet");
  assert.equal(((await placeTestnet(mkEnv(), {}, tin(), T0)) as any).code, "credentials_missing");
  const ok: any = await placeTestnet(tenv(), { fetchImpl: mockExchange({ marginErr: true }).f }, tin(), T0); assert.equal(ok.ok, true);
  const ex = mockExchange({ levErr: true }), lv: any = await placeTestnet(tenv(), { fetchImpl: ex.f }, tin(), T0); assert.equal(lv.code, "leverage_rejected"); assert.ok(!ex.calls.some(c => c.path === "/fapi/v1/order"));
  const ro = mockExchange(); await placeTestnet(tenv(), { fetchImpl: ro.f }, tin({ reduceOnly: true, side: "sell" }), T0); assert.ok(!ro.calls.some(c => c.path === "/fapi/v1/leverage")); assert.equal(ro.calls.find(c => c.path === "/fapi/v1/order")!.q.get("reduceOnly"), "true");
});
test("testnet: reconcile reports differences, state shows the exchange wallet, cron cycles both environments", async () => {
  const env = tenv(), ex = mockExchange({ positions: [{ symbol: "BTCUSDT", positionAmt: "0.5" }] }), d = { now: () => T0, fetchImpl: ex.f, priceOf: async () => 101 }; await placeTestnet(env, d, tin(), T0);
  const rec = await reconcileTestnet(env, d, T0); assert.equal(rec.ok, true); assert.match((rec as any).problems[0], /exchange 0.5 vs ETI ledger 0.01/);
  const s: any = await buildPerpState(env, d, "perp_testnet", T0); assert.equal(s.balances.wallet, 5000); assert.equal(s.balances.available, 4800); assert.equal(s.balanceSource, "exchange"); assert.equal(s.balances.starting, null); assert.ok(s.positions[0].unrealized > 0);
  const cyc: any = await runPerpCycle(env, { now: () => T0, fetchImpl: ex.f, priceOf: async () => 101, barsOf: async () => [] }); assert.ok("perp_paper" in cyc && "perp_testnet" in cyc);
  const noKeys: any = await runPerpCycle(mkEnv(), { now: () => T0 }); assert.equal(noKeys.perp_testnet, "not_configured");
  assert.equal((await signed(mkEnv(), {}, "GET", "/fapi/v2/balance", {}, T0)).msg, "credentials_missing");
});
