import test from "node:test";
import assert from "node:assert/strict";
import { handleAuth } from "./auth/routes.ts";
import { handleExecution } from "./execution.ts";
import { handlePortfolio, filterClosed, closedCsv, runPortfolioCycle } from "./portfolio/routes.ts";
import { openStore } from "./portfolio/store.ts";
import { sqliteD1 } from "./portfolio/testing.ts";
import { fold, present, openOrders, type LedgerEvent } from "./portfolio/ledger.ts";
import { applyBrokerView, cancelInternal, matchInternal, parseAlpacaOrder, parseBinanceOrder, placeInternal, reconcile, recordExchangeOrder, selfCheck, setPlan, syncExchange, validateLevels, type EngineDeps } from "./portfolio/engine.ts";

const ORIGIN = "https://eti.test", T0 = 1_800_000_000_000, MIN = 60_000;
class MemKV { m = new Map<string, string>(); lists = 0;
  async get(k: string) { return this.m.get(k) ?? null; } async put(k: string, v: string) { this.m.set(k, v); } async delete(k: string) { this.m.delete(k); }
  async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) { this.lists++; return { keys: [...this.m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })) }; } }
const D1 = process.env.PF_BACKEND === "d1";
const mk = (extra: Record<string, unknown> = {}) => ({ ETI_EXECUTION_LOG: new MemKV(), ...(D1 ? { ETI_PORTFOLIO_DB: sqliteD1() } : {}), ETI_READINESS_GATE: "off", ETI_EXECUTION_TOKEN: "master-token-value-0123456789", ETI_PAPER_START_BALANCE: "100000", ETI_PAPER_FEE_BPS: "10", ETI_PAPER_SLIPPAGE_BPS: "0", ...extra }) as any;
let price = 50_000, clock = T0, bars: [number, number, number, number, number, number][] = [];
const deps = (): EngineDeps => ({ now: () => clock, priceOf: async () => price, barsOf: async () => bars });
const bar = (i: number, o: number, h: number, l: number, c: number): [number, number, number, number, number, number] => [T0 + i * MIN, o, h, l, c, 1];
const buy = (over: Record<string, unknown> = {}) => ({ clientOrderId: "c" + Math.random().toString(36).slice(2, 12), symbol: "BTCUSDT", side: "buy" as const, type: "market" as const, qty: 1, ...over });
const L = async (env: any, e: any = "internal_paper") => (await openStore(env, e)!.ledger()).ledger;
const reset = () => { price = 50_000; clock = T0; bars = []; };

test("lifecycle: BUY -> fill -> holding -> partial SELLs -> realized P&L -> full close -> closed trade -> persistence", async () => {
  reset(); const env = mk();
  const r = await placeInternal(env, deps(), buy({ plan: { stop: 49_000, tp: [52_000, 54_000, 56_000] }, strategy: "momentum", signalId: "sig-1" }), clock);
  assert.ok(r.ok && r.order.status === "filled" && r.order.filledQty === 1);
  let l = await L(env), p = l.positions.BTCUSDT;
  assert.equal(openOrders(l).length, 0, "a filled order is no longer open");
  assert.equal(p.qty, 1); assert.equal(p.avgEntry, 50_000); assert.deepEqual(p.levels.tp, [52_000, 54_000, 56_000]); assert.equal(p.levels.stop, 49_000);
  assert.equal(l.cash!, 100_000 - 50_000 - 50, "cash = start - cost - fee");
  // live unrealized from a mark price
  price = 52_000; clock += MIN;
  let v = present(l, { BTCUSDT: 52_000 }, clock);
  assert.equal(v.positions[0].unrealized, 2_000); assert.ok(Math.abs(v.positions[0].unrealizedPct! - 4) < 1e-9);
  // partial sell 0.4
  const s1 = await placeInternal(env, deps(), buy({ side: "sell", qty: 0.4 }), clock); assert.ok(s1.ok);
  l = await L(env); p = l.positions.BTCUSDT; assert.ok(Math.abs(p.qty - 0.6) < 1e-12); assert.ok(Math.abs(p.realizedGross - 800) < 1e-9);
  assert.equal(l.closed.length, 0, "still open after a partial exit");
  price = 53_000; clock += MIN;
  const s2 = await placeInternal(env, deps(), buy({ side: "sell", qty: 0.6 }), clock); assert.ok(s2.ok);
  l = await L(env); assert.equal(Object.keys(l.positions).length, 0); assert.equal(l.closed.length, 1);
  const t = l.closed[0]; assert.equal(t.entryPrice, 50_000); assert.ok(Math.abs(t.exitPrice - (0.4 * 52_000 + 0.6 * 53_000)) < 1e-6);
  assert.ok(Math.abs(t.gross - 2_600) < 1e-6); assert.ok(Math.abs(t.fees - 102.6) < 1e-6); assert.ok(Math.abs(t.net - 2_497.4) < 1e-6); assert.equal(t.result, "win"); assert.equal(t.strategy, "momentum"); assert.equal(t.fills.length, 3);
  assert.ok(Math.abs(l.cash! - 102_497.4) < 1e-6, "balance equals start + net P&L");
  v = present(l, {}, clock); assert.equal(v.stats.winRate, 1); assert.ok(Math.abs(v.pnl.total! - 2_497.4) < 1e-6); assert.equal(v.pnl.unrealized, 0);
  assert.equal(selfCheck(l, clock).ok, true, JSON.stringify(selfCheck(l, clock)));
  // persistence: a brand-new store instance over the same KV rebuilds the identical state ("refresh")
  const again = await L(env); assert.deepEqual(again.closed.map(c => c.net), l.closed.map(c => c.net)); assert.equal(again.cash, l.cash);
});

test("orders are not holdings: a resting limit buy reserves cash but creates no position until a bar trades through it", async () => {
  reset(); const env = mk();
  const r = await placeInternal(env, deps(), buy({ type: "limit", limitPrice: 49_000, qty: 2, plan: { stop: 48_000, tp: [50_000, 51_000, 52_000] } }), clock);
  assert.ok(r.ok && !r.filledNow && r.order.status === "open");
  let l = await L(env); assert.equal(Object.keys(l.positions).length, 0); assert.equal(openOrders(l).length, 1);
  const v = present(l, {}, clock); assert.equal(v.balances.reservedForOrders, 2 * 49_000); assert.equal(v.balances.available, 100_000 - 98_000);
  bars = [bar(-1, 50_100, 50_200, 48_000, 50_000), bar(1, 49_500, 49_600, 49_100, 49_200)]; clock = T0 + 3 * MIN;
  await matchInternal(env, deps(), clock); l = await L(env); assert.equal(Object.keys(l.positions).length, 0, "the bar before the order existed, and one that never touched the limit, do nothing");
  bars.push(bar(2, 49_300, 49_400, 48_900, 49_000)); clock = T0 + 4 * MIN;
  const m = await matchInternal(env, deps(), clock); assert.equal(m.fills, 1);
  l = await L(env); assert.equal(l.positions.BTCUSDT.qty, 2); assert.equal(l.positions.BTCUSDT.avgEntry, 49_000); assert.equal(l.positions.BTCUSDT.levels.stop, 48_000, "plan stored with the pending order is applied on fill");
  assert.equal(l.orders[Object.keys(l.orders)[0]].status, "filled");
  await matchInternal(env, deps(), clock); assert.equal((await L(env)).fills.length, 1, "matching is idempotent: a bar is never applied twice");
});

test("automatic exits: TP1/TP2/TP3 scale out 40/30/30 and the stop wins when one bar touches both", async () => {
  reset(); const env = mk();
  await placeInternal(env, deps(), buy({ qty: 1, plan: { stop: 49_000, tp: [50_500, 51_000, 52_000] } }), clock);
  bars = [bar(1, 50_000, 50_600, 49_900, 50_500)]; clock = T0 + 2 * MIN; await matchInternal(env, deps(), clock);
  let l = await L(env), p = l.positions.BTCUSDT; assert.ok(Math.abs(p.qty - 0.6) < 1e-9); assert.deepEqual(p.levels.hit, [true, false, false]);
  bars.push(bar(2, 50_500, 52_100, 50_400, 52_000)); clock = T0 + 3 * MIN; await matchInternal(env, deps(), clock);
  l = await L(env); assert.equal(Object.keys(l.positions).length, 0, "TP2 and TP3 hit in one bar close the rest"); assert.equal(l.closed.length, 1); assert.equal(l.closed[0].result, "win");
  assert.equal(l.fills.filter(f => f.side === "sell").length, 3);
  // stop first
  reset(); const env2 = mk(); await placeInternal(env2, deps(), buy({ plan: { stop: 49_000, tp: [50_500, null, null] } }), clock);
  bars = [bar(1, 50_000, 51_000, 48_000, 50_000)]; clock = T0 + 2 * MIN; await matchInternal(env2, deps(), clock);
  const l2 = await L(env2); assert.equal(l2.closed.length, 1); assert.equal(l2.closed[0].result, "loss"); assert.ok(l2.closed[0].exitPrice <= 49_000 + 1e-9); assert.ok(l2.closed[0].net < 0);
});

test("cancel frees reserved cash; rejects; duplicates; day and IOC expiry", async () => {
  reset(); const env = mk();
  const r = await placeInternal(env, deps(), buy({ type: "limit", limitPrice: 40_000, qty: 1 }), clock); assert.ok(r.ok);
  const c = await cancelInternal(env, (r as any).order.orderId, clock + 1000, "tester"); assert.ok(c.ok && c.order.status === "cancelled");
  assert.equal(present(await L(env), {}, clock).balances.reservedForOrders, 0);
  assert.equal((await cancelInternal(env, (r as any).order.orderId, clock, "t")).ok, false, "already cancelled"); assert.equal((await cancelInternal(env, "nope-123", clock, "t")).status, 404);
  const big = await placeInternal(env, deps(), buy({ qty: 5 }), clock); assert.ok(!big.ok && big.code === "insufficient_balance" && big.order?.status === "rejected");
  assert.equal(Object.keys((await L(env)).positions).length, 0, "a rejected order never creates a holding");
  const sell = await placeInternal(env, deps(), buy({ side: "sell" }), clock); assert.ok(!sell.ok && sell.code === "insufficient_holdings");
  const dup = buy(); assert.ok((await placeInternal(env, deps(), dup, clock)).ok); const again = await placeInternal(env, deps(), dup, clock); assert.ok(!again.ok && again.status === 409);
  assert.equal((await L(env)).fills.length, 1, "the duplicate produced no second fill");
  const ioc = await placeInternal(env, deps(), buy({ type: "limit", limitPrice: 30_000, tif: "ioc" }), clock); assert.ok(ioc.ok && ioc.order.status === "expired");
  const day = await placeInternal(env, deps(), buy({ type: "limit", limitPrice: 30_000, tif: "day" }), clock); assert.ok(day.ok && day.order.expiresAt! > clock);
  await matchInternal(env, deps(), day.ok ? day.order.expiresAt! + MIN : 0); assert.equal((await L(env)).orders[(day as any).order.orderId].status, "expired");
});

test("sell stop-loss orders rest and trigger; a sell above the market is refused, not faked", async () => {
  reset(); const env = mk(); await placeInternal(env, deps(), buy({ qty: 1 }), clock);
  const bad = await placeInternal(env, deps(), buy({ side: "sell", type: "stop", stopPrice: 51_000, qty: 1 }), clock); assert.ok(!bad.ok && bad.code === "stop_already_triggered");
  const st = await placeInternal(env, deps(), buy({ side: "sell", type: "stop", stopPrice: 48_000, qty: 1 }), clock); assert.ok(st.ok && st.order.status === "open");
  assert.equal((await placeInternal(env, deps(), buy({ side: "sell", qty: 0.5 }), clock)).ok, false, "quantity reserved by the resting stop cannot be sold twice");
  bars = [bar(1, 49_000, 49_100, 47_500, 47_800)]; clock = T0 + 2 * MIN; await matchInternal(env, deps(), clock);
  const l = await L(env); assert.equal(l.closed.length, 1); assert.ok(l.closed[0].exitPrice <= 48_000 && l.closed[0].net < 0);
  assert.equal(await (async () => (await placeInternal(env, deps(), buy({ side: "buy", type: "stop", stopPrice: 1 }), clock)).ok)(), false, "buy stops are not supported");
});

test("level validation", () => {
  assert.equal(validateLevels({ stop: 49, tp: [51, 52, 53] }, 50), null);
  assert.match(validateLevels({ stop: 51 }, 50)!, /below/); assert.match(validateLevels({ tp: [52, 51] }, 50)!, /rise/); assert.match(validateLevels({ stop: -1 }, 50)!, /positive/);
});

test("ledger rejects bad data instead of absorbing it: duplicates, orphans, overfills, sells with no position", () => {
  const sub = (id: string, orderId: string, side: "buy" | "sell", qty = 1): LedgerEvent => ({ id, at: 1, t: "submitted", orderId, clientOrderId: orderId, symbol: "X", side, type: "market", qty, venue: "v" });
  const fill = (id: string, orderId: string, fillId: string, qty: number, price = 10, at = 2): LedgerEvent => ({ id, at, t: "fill", orderId, fillId, qty, price, fee: 0, verified: true, origin: "exchange_reported" });
  const evs: LedgerEvent[] = [{ id: "i", at: 0, t: "init", startingBalance: 1000, currency: "USDT" }, sub("s1", "o1", "buy"), fill("f1", "o1", "a", 0.5), fill("f1", "o1", "a", 0.5), fill("f2", "o1", "a", 0.5), fill("f3", "o1", "b", 5), fill("f4", "ghost", "z", 1), sub("s2", "o2", "sell"), fill("f5", "o2", "q", 1, 11, 3)];
  const l = fold("internal_paper", evs); const kinds = l.anomalies.map(a => a.kind);
  for (const k of ["duplicate_event", "duplicate_fill", "overfill", "orphan_event"]) assert.ok(kinds.includes(k), k);
  assert.equal(l.orders.o1.filledQty, 1, "never more than the order quantity"); assert.equal(l.orders.o1.status, "filled");
  assert.equal(l.closed.length, 1, "the o2 sell closes the o1 position it belongs to");
  const lone = fold("exchange_testnet", [sub("s", "o9", "sell"), fill("f", "o9", "x", 1)]); assert.ok(lone.anomalies.some(a => a.kind === "sell_without_position")); assert.equal(lone.closed.length, 0); assert.equal(lone.realizedGross, 0, "no P&L invented for a balance ETI did not buy");
  assert.equal(lone.cash, null, "no balance is invented when none is known");
});

// ---------------- exchange testnet ----------------
const binFills = [{ price: "50000.00", qty: "0.4", commission: "0.0004", commissionAsset: "BTC", tradeId: 11 }, { price: "50010.00", qty: "0.2", commission: "0.0001", commissionAsset: "BNB", tradeId: 12 }];
test("exchange testnet: ledger is written only from broker evidence; partial fills, unknown fees, rejections", async () => {
  reset(); const env = mk(); const inp = { broker: "binance" as const, clientOrderId: "bn-client-0001", symbol: "BTCUSDT", side: "buy" as const, type: "market" as const, qty: 1, plan: { stop: 48_000, tp: [52_000, null, null] } };
  await recordExchangeOrder(env, inp, { orderId: 900, status: "PARTIALLY_FILLED", executedQty: "0.6", cummulativeQuoteQty: "30004", fills: binFills }, true, clock);
  let l = await L(env, "exchange_testnet"); const o = l.orders["bn-bn-client-0001"];
  assert.equal(o.status, "partially_filled"); assert.ok(Math.abs(o.filledQty - 0.6) < 1e-12); assert.equal(o.brokerOrderId, "900"); assert.ok(Math.abs(l.positions.BTCUSDT.qty - 0.6) < 1e-12);
  assert.equal(l.fills[0].fee, 0.0004 * 50_000, "base-asset fee converted at the fill price"); assert.equal(l.fills[1].fee, null, "BNB fee has no trustworthy rate: stays unknown");
  assert.equal(l.cash, null); assert.equal(l.unknownFees, 1); assert.equal(openOrders(l).length, 1, "a partially filled order is still open");
  assert.equal(Object.keys((await L(env, "internal_paper")).orders).length, 0, "testnet records never leak into internal paper");
  // sync: broker now reports FILLED with a third trade
  const fetchImpl: any = async (u: any) => { const url = String(u); const j = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes("/api/v3/order?")) return j({ orderId: 900, status: "FILLED", executedQty: "1", cummulativeQuoteQty: "50020" });
    if (url.includes("/api/v3/myTrades")) return j([...binFills.map(f => ({ id: f.tradeId, price: f.price, qty: f.qty, commission: f.commission, commissionAsset: f.commissionAsset, time: clock })), { id: 13, price: "50050", qty: "0.4", commission: "20", commissionAsset: "USDT", time: clock + 5 }]);
    return j({}); };
  const e2 = { ...env, BINANCE_API_KEY: "k", BINANCE_SECRET_KEY: "s" };
  const s = await syncExchange(e2, { ...deps(), fetchImpl }, clock + 10_000); assert.equal(s.checked, 1); assert.equal(s.written >= 1, true);
  l = await L(env, "exchange_testnet"); assert.equal(l.orders["bn-bn-client-0001"].status, "filled"); assert.equal(l.positions.BTCUSDT.qty, 1); assert.equal(l.fills.length, 3, "known trades were not duplicated");
  await syncExchange(e2, { ...deps(), fetchImpl }, clock + 20_000); assert.equal((await L(env, "exchange_testnet")).fills.length, 3, "re-sync is idempotent");
  // rejection keeps the broker's reason and no holding
  await recordExchangeOrder(env, { ...inp, clientOrderId: "bn-client-0002" }, { code: -2010, msg: "Account has insufficient balance" }, false, clock);
  l = await L(env, "exchange_testnet"); assert.equal(l.orders["bn-bn-client-0002"].status, "rejected"); assert.match(l.orders["bn-bn-client-0002"].statusReason!, /insufficient balance/);
});

test("exchange testnet: Alpaca aggregates become delta fills; cancel path; broker view parsers", async () => {
  reset(); const env = mk({ ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" }); const inp = { broker: "alpaca" as const, clientOrderId: "al-client-0001", symbol: "BTCUSD", side: "buy" as const, type: "limit" as const, qty: 10, limitPrice: 100 };
  await recordExchangeOrder(env, inp, { id: "alp-1", status: "partially_filled", filled_qty: "4", filled_avg_price: "99.5" }, true, clock);
  let l = await L(env, "exchange_testnet"); assert.equal(l.orders["ap-al-client-0001"].filledQty, 4); assert.equal(l.fills[0].fee, null);
  const st = openStore(env, "exchange_testnet")!;
  await applyBrokerView(st, "ap-al-client-0001", parseAlpacaOrder({ id: "alp-1", status: "partially_filled", filled_qty: "7", filled_avg_price: "99.8" }), clock + 1000);
  l = await L(env, "exchange_testnet"); assert.equal(l.orders["ap-al-client-0001"].filledQty, 7); assert.ok(Math.abs(l.orders["ap-al-client-0001"].avgFillPrice! - 99.8) < 1e-9, "delta price keeps the broker's average");
  const calls: string[] = []; const fetchImpl: any = async (u: any, init: any) => { calls.push((init?.method || "GET") + " " + u); return new Response(init?.method === "DELETE" ? null : JSON.stringify({ id: "alp-1", status: "canceled", filled_qty: "7", filled_avg_price: "99.8" }), { status: init?.method === "DELETE" ? 204 : 200 }); };
  const { cancelExchange } = await import("./portfolio/engine.ts");
  const c = await cancelExchange(env, { ...deps(), fetchImpl }, "ap-al-client-0001", clock + 2000); assert.ok(c.ok && c.order.status === "cancelled" && c.order.filledQty === 7, "partial fill kept, remainder cancelled"); assert.ok(calls[0].startsWith("DELETE"));
  assert.equal(parseBinanceOrder("ETHUSDT", { status: "EXPIRED" }).status, "expired"); assert.equal(parseAlpacaOrder({ status: "rejected" }).status, "rejected");
});

test("reconcile: internal self-check and exchange comparison flag differences instead of hiding them", async () => {
  reset(); const env = mk({ BINANCE_API_KEY: "k", BINANCE_SECRET_KEY: "s" });
  await placeInternal(env, deps(), buy({ qty: 1 }), clock); assert.equal((await reconcile(env, deps(), "internal_paper", clock)).ok, true);
  await recordExchangeOrder(env, { broker: "binance", clientOrderId: "bn-recon-0001", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1 }, { orderId: 5, status: "FILLED", executedQty: "1", cummulativeQuoteQty: "50000", fills: [{ price: "50000", qty: "1", commission: "10", commissionAsset: "USDT", tradeId: 1 }] }, true, clock);
  const mkFetch = (btc: string) => (async () => new Response(JSON.stringify({ canTrade: true, balances: [{ asset: "BTC", free: btc, locked: "0" }, { asset: "USDT", free: "9000", locked: "0" }] }))) as any;
  const good = await reconcile(env, { ...deps(), fetchImpl: mkFetch("1.0") }, "exchange_testnet", clock); assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.source, "binance_testnet");
  const bad = await reconcile(env, { ...deps(), fetchImpl: mkFetch("0.7") }, "exchange_testnet", clock); assert.equal(bad.ok, false); assert.ok(bad.diffs[0].delta! > 0.29);
  const none = await reconcile(mk(), deps(), "exchange_testnet", clock); assert.equal(none.ok, false); assert.match(none.problems[0], /credentials/);
});

test("setPlan updates levels of an open position, validated against the average entry", async () => {
  reset(); const env = mk(); assert.equal((await setPlan(env, "internal_paper", "BTCUSDT", { stop: 1 }, clock)).ok, false);
  await placeInternal(env, deps(), buy(), clock);
  assert.equal((await setPlan(env, "internal_paper", "BTCUSDT", { stop: 51_000 }, clock + 1)).ok, false); const ok = await setPlan(env, "internal_paper", "BTCUSDT", { stop: 49_500, tp: [51_000, 52_000, 53_000] }, clock + 2); assert.ok(ok.ok);
  assert.equal((await L(env)).positions.BTCUSDT.levels.stop, 49_500);
});

// ---------------- HTTP surface ----------------
const jar = (res: Response) => { const o: Record<string, string> = {}; for (const c of (res.headers as any).getSetCookie?.() ?? []) { const [kv] = c.split(";"), i = kv.indexOf("="); o[kv.slice(0, i)] = kv.slice(i + 1); } return o; };
const cookieOf = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => k + "=" + v).join("; ");
const H = (c: Record<string, string> = {}) => ({ origin: ORIGIN, "content-type": "application/json", ...(Object.keys(c).length ? { cookie: cookieOf(c) } : {}) });
const sess = async (env: any, environment: string) => { const r = await handleAuth(new Request(ORIGIN + "/api/auth/session", { method: "POST", headers: H(), body: JSON.stringify({ environment }) }), env, { now: () => clock }); return jar(r); };
const api = async (env: any, path: string, init: { method?: string; body?: unknown; cookies?: Record<string, string>; token?: string } = {}) => { const headers: any = H(init.cookies); if (init.token) headers.authorization = "Bearer " + init.token; const r = await handlePortfolio(new Request(ORIGIN + path, { method: init.method || "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined }), env, deps()); return { r, body: await r.clone().json().catch(() => null) as any, text: await r.text() }; };
const order = (over: Record<string, unknown> = {}) => ({ broker: "eti_paper", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1, clientOrderId: "web" + Math.random().toString(36).slice(2, 12) + "abcd", riskConfirmed: true, executionSource: { actorType: "manual_user", actorId: "tester", sourceName: "test", strategyId: "trend" }, ...over });
const place = async (env: any, body: unknown, cookies: Record<string, string>) => { const r = await handleExecution(new Request(ORIGIN + "/api/orders", { method: "POST", headers: H(cookies), body: JSON.stringify(body) }), env, { now: () => clock, priceOf: async () => price, fetchImpl: (async () => new Response("{}", { status: 404 })) as any }); return { r, body: await r.json() as any }; };

test("API: the full UI lifecycle through /api/orders and /api/portfolio, per-environment auth, live disabled", async () => {
  reset(); const env = mk({ BINANCE_API_KEY: "bk", BINANCE_SECRET_KEY: "bs" }); const paper = await sess(env, "paper"), testnet = await sess(env, "testnet");
  assert.ok(testnet.eti_testnet, "a genuine testnet session needs credentials");
  assert.equal((await api(env, "/api/portfolio/state")).r.status, 401);
  assert.equal((await api(env, "/api/portfolio/state?environment=exchange_testnet", { cookies: paper })).r.status, 403, "a paper session cannot read the testnet portfolio");
  assert.equal((await api(env, "/api/portfolio/state?environment=internal_paper", { cookies: testnet })).r.status, 403);
  const live = await api(env, "/api/portfolio/state?environment=live", { token: env.ETI_EXECUTION_TOKEN }); assert.equal(live.body.disabled, true);
  assert.equal((await api(env, "/api/portfolio/cancel", { method: "POST", body: { environment: "live", orderId: "abcd" }, token: env.ETI_EXECUTION_TOKEN })).r.status, 423);
  // 1-3 BUY with levels, then it is a holding with TP/SL
  const b = await place(env, order({ quantity: 1, plan: { stop: 49_000, tp1: 52_000, tp2: 54_000, tp3: 56_000 } }), paper); assert.equal(b.r.status, 201); assert.equal(b.body.order.status, "filled");
  const rest = await place(env, order({ type: "limit", limitPrice: 45_000, quantity: 0.5 }), paper); assert.equal(rest.r.status, 202); assert.equal(rest.body.fill, null);
  let st = (await api(env, "/api/portfolio/state?environment=internal_paper", { cookies: paper })).body;
  assert.equal(st.openOrders.length, 1); assert.equal(st.openOrders[0].status, "open"); assert.equal(st.positions.length, 1); assert.equal(st.positions[0].levels.tp[2], 56_000); assert.equal(st.simulated, true); assert.equal(st.positions[0].markPrice, 50_000);
  assert.equal(st.balances.reservedForOrders, 0.5 * 45_000);
  price = 51_000; st = (await api(env, "/api/portfolio/state?environment=internal_paper", { cookies: paper })).body; clock += 20_000;
  // cancel through the API
  const cx = await api(env, "/api/portfolio/cancel", { method: "POST", body: { environment: "internal_paper", orderId: st.openOrders[0].orderId }, cookies: paper }); assert.equal(cx.body.order.status, "cancelled");
  // partial and full close via ordinary sell orders (the Close button posts the same)
  assert.equal((await place(env, order({ side: "sell", quantity: 0.25 }), paper)).r.status, 201);
  assert.equal((await place(env, order({ side: "sell", quantity: 0.75 }), paper)).r.status, 201);
  st = (await api(env, "/api/portfolio/state?environment=internal_paper", { cookies: paper })).body;
  assert.equal(st.positions.length, 0); assert.equal(st.closed.length, 1); assert.equal(st.stats.trades, 1); assert.equal(st.openOrders.length, 0); assert.ok(st.pnl.realizedNet > 0);
  assert.ok(st.orders.some((o: any) => o.status === "cancelled"), "cancelled orders stay visible in history"); assert.ok(st.fills.length >= 3);
  assert.equal((await api(env, "/api/portfolio/state?environment=exchange_testnet", { cookies: testnet })).body.closed.length, 0, "testnet view is separate and empty");
  const hist = await api(env, "/api/portfolio/history?environment=internal_paper&result=win&symbol=btc", { cookies: paper }); assert.equal(hist.body.count, 1);
  assert.equal((await api(env, "/api/portfolio/history?environment=internal_paper&result=loss", { cookies: paper })).body.count, 0);
  const csv = await api(env, "/api/portfolio/history?environment=internal_paper&format=csv", { cookies: paper }); assert.ok(csv.text.startsWith("symbol,side,qty")); assert.ok(csv.text.split("\n")[1].includes("Internal Paper"));
  assert.equal((await api(env, "/api/portfolio/plan", { method: "POST", body: { environment: "internal_paper", symbol: "BTCUSDT", stop: 1 }, cookies: paper })).r.status, 409, "no open position");
  const rec = await api(env, "/api/portfolio/reconcile", { method: "POST", body: { environment: "internal_paper" }, cookies: paper }); assert.equal(rec.body.reconciliation.ok, true);
  assert.equal(JSON.stringify(st).includes(env.ETI_EXECUTION_TOKEN), false, "no secrets in responses");
});

test("API: testnet order through the gateway lands in the testnet ledger with broker fills and is isolated from paper", async () => {
  reset(); const env = mk({ ALPACA_API_KEY: "ak", ALPACA_SECRET_KEY: "as", BINANCE_API_KEY: "bk", BINANCE_SECRET_KEY: "bs" }); const testnet = await sess(env, "testnet"), paper = await sess(env, "paper");
  const fetchImpl: any = async (u: any, init: any) => { const url = String(u), j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    const path = url.includes("binance") ? new URL(url).pathname : "";
    if (path.endsWith("/exchangeInfo")) return j({ symbols: [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" }] });
    if (path.endsWith("/ticker/price")) return j({ price: "50000" });
    if (url.includes("/api/v3/account")) return j({ canTrade: true, balances: [{ asset: "USDT", free: "1000000" }, { asset: "BTC", free: "1000" }] });
    if (url.includes("testnet.binance.vision/api/v3/order") && init?.method === "POST") return j({ orderId: 4242, status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "25000", fills: [{ price: "50000", qty: "0.5", commission: "12.5", commissionAsset: "USDT", tradeId: 99 }] });
    return j({}, 404); };
  const r = await handleExecution(new Request(ORIGIN + "/api/orders", { method: "POST", headers: H(testnet), body: JSON.stringify(order({ broker: "binance", quantity: 0.5 })) }), env, { now: () => clock, fetchImpl, priceOf: async () => price });
  assert.equal(r.status, 201);
  const st = (await api(env, "/api/portfolio/state?environment=exchange_testnet", { cookies: testnet })).body;
  assert.equal(st.positions.length, 1); assert.equal(st.positions[0].avgEntry, 50_000); assert.equal(st.fills[0].origin, "exchange_reported"); assert.equal(st.balances.cash, null, "no invented testnet balance"); assert.equal(st.simulated, false);
  assert.equal((await api(env, "/api/portfolio/state?environment=internal_paper", { cookies: paper })).body.positions.length, 0);
  const rej = await handleExecution(new Request(ORIGIN + "/api/orders", { method: "POST", headers: H(testnet), body: JSON.stringify(order({ broker: "binance", quantity: 99, side: "sell" })) }), env, { now: () => clock, fetchImpl: (async (u: any, init: any) => String(u).includes("/api/v3/order") && init?.method === "POST" ? new Response(JSON.stringify({ code: -2010, msg: "insufficient balance" }), { status: 400 }) : fetchImpl(u, init)) as any, priceOf: async () => price });
  assert.equal(rej.status, 502);
  const st2 = (await api(env, "/api/portfolio/state?environment=exchange_testnet", { cookies: testnet })).body; assert.ok(st2.orders.some((o: any) => o.status === "rejected"), "broker rejection is recorded");
});

test("alerts: testnet levels are alert-only", async () => {
  reset(); const env = mk({ BINANCE_API_KEY: "bk", BINANCE_SECRET_KEY: "bs" }); const testnet = await sess(env, "testnet");
  await recordExchangeOrder(env, { broker: "binance", clientOrderId: "bn-alert-0001", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1, plan: { stop: 49_500, tp: [null, null, null] } }, { orderId: 1, status: "FILLED", executedQty: "1", cummulativeQuoteQty: "50000", fills: [{ price: "50000", qty: "1", commission: "0", commissionAsset: "USDT", tradeId: 1 }] }, true, clock);
  price = 49_000; const s = (await api(env, "/api/portfolio/state?environment=exchange_testnet", { cookies: testnet })).body;
  assert.equal(s.alerts[0].kind, "stop_level_reached"); assert.match(s.alerts[0].message, /manually/); assert.equal(s.closed.length, 0, "no exit is invented");
});

test("cron cycle: idle streams cost one read; active streams are processed", async () => {
  reset(); const env = mk(); const kv: MemKV = env.ETI_EXECUTION_LOG; const q: string[] | undefined = env.ETI_PORTFOLIO_DB?.queries;
  assert.equal((await runPortfolioCycle(env, deps()) as any).internal_paper.idle, true);
  const before = kv.lists; const o = await runPortfolioCycle(env, deps()) as any; assert.equal(o.internal_paper, "idle"); assert.equal(kv.lists, before, "idle: no KV list operation"); if (q) { const n = q.length; await runPortfolioCycle(env, deps()); assert.ok(q.slice(n).every(x => !x.includes("SELECT body")), "idle on D1: the events table is not read"); }
  await placeInternal(env, deps(), buy({ type: "limit", limitPrice: 40_000 }), clock); const a = await runPortfolioCycle(env, deps()) as any; assert.notEqual(a.internal_paper, "idle"); assert.equal(a.internal_paper.idle, false);
});

test("filters and csv helpers", () => {
  const t = (over: any) => ({ symbol: "BTCUSDT", strategy: "trend", result: "win", exitAt: Date.parse("2026-11-05T12:00:00Z"), fills: [{ origin: "internal_sim" }], fees: 1, net: 5, unknownFees: 0, ...over });
  const all = [t({}), t({ symbol: "ETHUSDT", result: "loss", strategy: "mean" }), t({ exitAt: Date.parse("2026-10-01T00:00:00Z") })] as any;
  assert.equal(filterClosed(all, new URLSearchParams("symbol=eth")).length, 1); assert.equal(filterClosed(all, new URLSearchParams("from=2026-11-01&to=2026-11-30")).length, 2);
  assert.equal(filterClosed(all, new URLSearchParams("strategy=mean&result=loss")).length, 1);
  const c = closedCsv([{ ...all[0], symbol: 'A"B', entryAt: 0, exitAt: 1, entryPrice: 1, exitPrice: 2, qty: 1, holdingMs: 1, gross: 1, slippageCost: 0, signalId: null }] as any, "Internal Paper"); assert.ok(c.includes('"A""B"'));
});
