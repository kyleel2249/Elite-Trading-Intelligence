import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { executionStatus, handleExecution, type ExecutionEnv } from "./execution.ts";
import { releaseReservation, reserveOrder, type OrderFacts } from "./safeguards.ts";

// These tests exercise the real handler against a stateful stand-in for the two PAPER venues. The stand-in mimics the
// brokers' HTTP behaviour (404 for no position, 422/400 on a reused client order id, signed requests) but it is NOT
// Alpaca or Binance: no real broker was contacted and none of these results prove behaviour of the live services.

const TOKEN = "t".repeat(40);
const FORBIDDEN_HOSTS = ["api.alpaca.markets", "api.binance.com", "gate.test", "risk.example"];

class KV {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async list(o: { prefix: string }) { return { keys: [...this.m.keys()].filter((k) => k.startsWith(o.prefix)).sort().map((name) => ({ name })), list_complete: true }; }
  keys(prefix: string) { return [...this.m.keys()].filter((k) => k.startsWith(prefix)); }
}

interface Call { method: string; host: string; path: string; search: URLSearchParams; headers: Record<string, string>; body: string }
const world = {
  calls: [] as Call[], unexpected: [] as string[], allowUnknown: false,
  alpaca: { cash: 10_000, status: "ACTIVE", positions: {} as Record<string, number>, orders: new Set<string>(), accountHttp: 200, tradeHttp: 200, orderMode: "ok" as "ok" | "reject" | "http500" | "throw", seq: 0 },
  binance: { balances: { USDT: 10_000, BTC: 0 } as Record<string, number>, canTrade: true, orders: new Set<string>(), orderMode: "ok" as "ok" | "reject" | "http500" | "throw", seq: 0 },
  prices: { AAPL: 190, BTCUSDT: 60_000 } as Record<string, number>,
};
const reset = () => {
  Object.assign(world, { calls: [], unexpected: [], allowUnknown: false });
  Object.assign(world.alpaca, { cash: 10_000, status: "ACTIVE", positions: {}, orders: new Set(), accountHttp: 200, tradeHttp: 200, orderMode: "ok", seq: 0 });
  Object.assign(world.binance, { balances: { USDT: 10_000, BTC: 0 }, canTrade: true, orders: new Set(), orderMode: "ok", seq: 0 });
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const orderPosts = () => world.calls.filter((c) => c.method === "POST" && /\/(v2\/orders|api\/v3\/order)$/.test(c.path));

const stub = (async (input: any, init: any = {}) => {
  const u = new URL(String(input)), method = (init.method || "GET").toUpperCase();
  const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
  const call: Call = { method, host: u.host, path: u.pathname, search: u.searchParams, headers, body: typeof init.body === "string" ? init.body : "" };
  world.calls.push(call);
  if (FORBIDDEN_HOSTS.includes(u.hostname)) { world.unexpected.push(u.host); return json({ error: "forbidden host" }, 500); }
  if (u.host === "paper-api.alpaca.markets") {
    assert.ok(headers["apca-api-key-id"] && headers["apca-api-secret-key"], "paper keys sent");
    const a = world.alpaca;
    if (method === "GET" && u.pathname === "/v2/account") return a.accountHttp !== 200 ? json({}, a.accountHttp) : json({ status: a.status, buying_power: String(a.cash), trading_blocked: false, account_blocked: false });
    const pos = u.pathname.match(/^\/v2\/positions\/(.+)$/);
    if (method === "GET" && pos) { const q = a.positions[decodeURIComponent(pos[1])]; return q ? json({ qty: String(q), qty_available: String(q) }) : json({ code: 40410000, message: "position does not exist" }, 404); }
    if (method === "POST" && u.pathname === "/v2/orders") {
      if (a.orderMode === "throw") throw new TypeError("network down");
      if (a.orderMode === "http500") return json({ message: "internal" }, 500);
      const o = JSON.parse(call.body);
      if (a.orderMode === "reject") return json({ code: 40310000, message: "insufficient buying power" }, 403);
      if (a.orders.has(o.client_order_id)) return json({ message: "client_order_id must be unique" }, 422);
      a.orders.add(o.client_order_id);
      const px = world.prices[o.symbol as "AAPL"] ?? 100, q = Number(o.qty);
      if (o.side === "buy") { a.cash -= q * px; a.positions[o.symbol] = (a.positions[o.symbol] ?? 0) + q; } else { a.cash += q * px; a.positions[o.symbol] = (a.positions[o.symbol] ?? 0) - q; }
      return json({ id: "alp-" + ++a.seq, client_order_id: o.client_order_id, status: "accepted", symbol: o.symbol, side: o.side, qty: o.qty });
    }
  }
  if (u.host === "data.alpaca.markets") {
    const m = u.pathname.match(/^\/v2\/stocks\/(.+)\/trades\/latest$/);
    if (m && world.alpaca.tradeHttp === 200) return json({ symbol: m[1], trade: { p: world.prices[m[1] as "AAPL"] ?? 100 } });
    return json({}, world.alpaca.tradeHttp === 200 ? 404 : world.alpaca.tradeHttp);
  }
  if (u.host === "testnet.binance.vision") {
    const b = world.binance;
    if (u.pathname === "/api/v3/exchangeInfo") { const s = u.searchParams.get("symbol"); return s === "BTCUSDT" ? json({ symbols: [{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" }] }) : json({ code: -1121, msg: "Invalid symbol." }, 400); }
    if (u.pathname === "/api/v3/ticker/price") return json({ symbol: u.searchParams.get("symbol"), price: String(world.prices.BTCUSDT) });
    if (u.pathname === "/api/v3/account") {
      assert.ok(u.searchParams.get("signature") && headers["x-mbx-apikey"], "account request is signed");
      return json({ canTrade: b.canTrade, balances: Object.entries(b.balances).map(([asset, free]) => ({ asset, free: String(free), locked: "0" })) });
    }
    if (u.pathname === "/api/v3/order" && method === "POST") {
      const p = new URLSearchParams(call.body);
      assert.ok(p.get("signature") && headers["x-mbx-apikey"], "order request is signed");
      if (b.orderMode === "throw") throw new TypeError("network down");
      if (b.orderMode === "http500") return json({ code: -1007, msg: "Timeout waiting for response from backend server. Send status unknown; execution status unknown." }, 500);
      if (b.orderMode === "reject") return json({ code: -2010, msg: "Account has insufficient balance for requested action." }, 400);
      const id = p.get("newClientOrderId")!;
      if (b.orders.has(id)) return json({ code: -2010, msg: "Duplicate order sent." }, 400);
      b.orders.add(id);
      const q = Number(p.get("quantity")), px = Number(p.get("price") ?? world.prices.BTCUSDT);
      if (p.get("side") === "BUY") { b.balances.USDT -= q * px; b.balances.BTC += q; } else { b.balances.USDT += q * px; b.balances.BTC -= q; }
      return json({ orderId: ++b.seq, clientOrderId: id, symbol: p.get("symbol"), side: p.get("side"), status: "FILLED", executedQty: String(q) });
    }
  }
  if (world.allowUnknown) return new Response("unavailable", { status: 500 });
  world.unexpected.push(u.host + u.pathname); return json({ error: "unexpected host" }, 500);
}) as typeof fetch;

const realFetch = globalThis.fetch;
test.beforeEach(() => { reset(); globalThis.fetch = stub; });
test.afterEach(() => { globalThis.fetch = realFetch; });

let counter = 0;
const newId = () => "eti" + String(++counter).padStart(10, "0");
const mkEnv = (o: Partial<ExecutionEnv> = {}) => {
  const kv = new KV();
  return { env: { ETI_EXECUTION_TOKEN: TOKEN, ETI_EXECUTION_LOG: kv as any, ETI_READINESS_GATE: "off", ALPACA_API_KEY: "ak", ALPACA_SECRET_KEY: "as", BINANCE_API_KEY: "bk", BINANCE_SECRET_KEY: "bs", ...o } as ExecutionEnv, kv };
};
const src = { actorType: "manual_user", actorId: "tester", sourceName: "unit test" };
const order = (o: Record<string, unknown> = {}) => ({ broker: "alpaca", symbol: "AAPL", side: "buy", type: "market", quantity: 2, clientOrderId: newId(), riskConfirmed: true, executionSource: src, ...o });
const post = (env: ExecutionEnv, body: unknown, path = "/api/orders", token: string | null = TOKEN) =>
  handleExecution(new Request("https://e" + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }), env);
const history = (env: ExecutionEnv, qs = "") => handleExecution(new Request("https://e/api/execution/history" + qs, { headers: { authorization: "Bearer " + TOKEN } }), env);
const noForbidden = () => assert.deepEqual(world.unexpected, [], "no live, gateway or unknown host was contacted");

test("status describes a paper-only, in-process flow with no gateway and no live path", async () => {
  const { env } = mkEnv({ ETI_LIVE_TRADING_ENABLED: "true", ETI_MAX_ORDER_QUANTITY: "25" });
  const s: any = await (await handleExecution(new Request("https://e/api/execution/status"), env)).json();
  assert.equal(s.mode, "paper_testnet_only"); assert.equal(s.live_trading_enabled, false); assert.equal(s.live_trading_available, false); assert.equal(s.live_flag_ignored, true);
  assert.equal(s.external_risk_gateway, false); assert.equal(s.safeguards.engine, "in_process"); assert.equal(s.safeguards.max_order_quantity, 25);
  assert.deepEqual([s.safeguards.balance_check, s.safeguards.holdings_check, s.safeguards.duplicate_protection], [true, true, true]);
  assert.equal(s.alpaca_paper_configured, true); assert.equal(s.binance_testnet_configured, true); assert.equal(s.withdrawal_permissions, false);
  assert.ok(!Object.keys(s).some((k) => /gate_required|live_risk_gate|live_activation|_live_configured|live_credentials/.test(k)));
  assert.equal(executionStatus({ ...env, ETI_KILL_SWITCH: "true" }).kill_switch, true);
});

test("Alpaca paper BUY executes through the paper endpoint with no gateway configured and records the broker response", async () => {
  const { env, kv } = mkEnv();
  const r = await post(env, order()); const j: any = await r.json();
  assert.equal(r.status, 201); assert.equal(j.ok, true); assert.equal(j.outcome, "executed"); assert.equal(j.mode, "paper"); assert.equal(j.live_trading, false);
  assert.equal(j.brokerOrderId, "alp-1"); assert.equal(j.brokerStatus, "accepted"); assert.equal(j.order.status, "accepted"); assert.equal(j.preTrade.cashAvailable, 10_000); assert.equal(j.preTrade.referenceSource, "latest_trade");
  assert.equal(orderPosts().length, 1); assert.equal(orderPosts()[0].host, "paper-api.alpaca.markets"); assert.equal(world.alpaca.positions.AAPL, 2); assert.equal(world.alpaca.cash, 10_000 - 380);
  const rec = JSON.parse(kv.m.get(kv.keys("order:")[0])!); assert.equal(rec.outcome, "executed"); assert.equal(rec.order.id, "alp-1"); assert.equal(rec.safeguards.engine, "in_process"); assert.equal(rec.executionSource.actorId, "tester");
  noForbidden();
});

test("Alpaca paper SELL executes only against held shares", async () => {
  const { env } = mkEnv(); world.alpaca.positions.AAPL = 5;
  const r = await post(env, order({ side: "sell", quantity: 3, type: "limit", limitPrice: 200 })); const j: any = await r.json();
  assert.equal(r.status, 201); assert.equal(j.brokerOrderId, "alp-1"); assert.equal(world.alpaca.positions.AAPL, 2); assert.equal(orderPosts().length, 1);
  const over = await post(env, order({ side: "sell", quantity: 4, type: "limit", limitPrice: 200 })); const o: any = await over.json();
  assert.equal(over.status, 403); assert.equal(o.error, "insufficient_holdings"); assert.equal(orderPosts().length, 1, "second sell never reached the broker"); noForbidden();
});

test("Binance testnet BUY and SELL execute on the testnet host with signed requests", async () => {
  const { env } = mkEnv();
  const buy = await post(env, order({ broker: "binance", symbol: "BTCUSDT", quantity: 0.05 })); const b: any = await buy.json();
  assert.equal(buy.status, 201); assert.equal(b.mode, "testnet"); assert.equal(b.brokerOrderId, 1); assert.equal(b.brokerStatus, "FILLED"); assert.equal(world.binance.balances.BTC, 0.05);
  const sell = await post(env, order({ broker: "binance", symbol: "BTCUSDT", side: "sell", quantity: 0.02, type: "limit", limitPrice: 61_000, timeInForce: "ioc" })); const s: any = await sell.json();
  assert.equal(sell.status, 201); assert.equal(s.brokerOrderId, 2); assert.ok(Math.abs(world.binance.balances.BTC - 0.03) < 1e-9);
  assert.ok(orderPosts().every((c) => c.host === "testnet.binance.vision")); assert.equal(new URLSearchParams(orderPosts()[1].body).get("timeInForce"), "IOC"); noForbidden();
});

test("every refused order is audited and never reaches a broker", async () => {
  const cases: [string, (e: ExecutionEnv) => void, Record<string, unknown>, number, string][] = [
    ["sell with no holdings", () => {}, { side: "sell" }, 403, "insufficient_holdings"],
    ["alpaca buy beyond cash", () => { world.alpaca.cash = 100; }, { quantity: 10, type: "limit", limitPrice: 190 }, 403, "insufficient_balance"],
    ["alpaca market buy beyond cash (uses latest trade)", () => { world.alpaca.cash = 300; }, { quantity: 2 }, 403, "insufficient_balance"],
    ["binance buy beyond cash", () => { world.binance.balances.USDT = 10; }, { broker: "binance", symbol: "BTCUSDT", quantity: 1 }, 403, "insufficient_balance"],
    ["binance sell with no BTC", () => {}, { broker: "binance", symbol: "BTCUSDT", side: "sell", quantity: 0.01 }, 403, "insufficient_holdings"],
    ["quantity over cap", () => {}, { quantity: 101 }, 403, "risk_limit_exceeded"],
    ["bad side", () => {}, { side: "short" }, 400, "invalid_order"],
    ["bad symbol", () => {}, { symbol: "A B" }, 400, "invalid_order"],
    ["no risk confirmation", () => {}, { riskConfirmed: false }, 400, "invalid_order"],
    ["unsafe client order id", () => {}, { clientOrderId: "short" }, 400, "invalid_order"],
    ["zero quantity", () => {}, { quantity: 0 }, 400, "invalid_order"],
    ["limit without price", () => {}, { type: "limit" }, 400, "invalid_limit_price"],
    ["market with price", () => {}, { limitPrice: 10 }, 400, "unexpected_limit_price"],
    ["missing execution source", () => {}, { executionSource: undefined }, 400, "execution_source_required"],
    ["unknown binance symbol", () => {}, { broker: "binance", symbol: "NOPEUSDT" }, 400, "unknown_symbol"],
    ["account not active", () => { world.alpaca.status = "ACCOUNT_UPDATED"; }, {}, 403, "paper_account_not_tradable"],
    ["account unreadable (fail closed)", () => { world.alpaca.accountHttp = 500; }, {}, 503, "account_state_unavailable"],
    ["market data unreadable for a market buy (fail closed)", () => { world.alpaca.tradeHttp = 500; }, {}, 503, "account_state_unavailable"],
  ];
  for (const [name, setup, patch, status, error] of cases) {
    reset(); setup({} as any);
    const { env, kv } = mkEnv(), r = await post(env, order(patch)), j: any = await r.json();
    assert.equal(r.status, status, name); assert.equal(j.error, error, name); assert.equal(j.outcome, "rejected", name); assert.equal(j.broker_contacted, false, name); assert.equal(j.audit_recorded, true, name);
    assert.equal(orderPosts().length, 0, name + ": no order POST"); assert.equal(kv.keys("order:").length, 0, name);
    const rej = kv.keys("reject:"); assert.equal(rej.length, 1, name); const rec = JSON.parse(kv.m.get(rej[0])!);
    assert.equal(rec.outcome, "rejected"); assert.equal(rec.brokerContacted, false); assert.equal(rec.error, error); assert.ok(rec.reasons.length > 0); noForbidden();
  }
});

test("broker credentials missing is refused before any network call", async () => {
  const { env, kv } = mkEnv({ ALPACA_API_KEY: undefined }), r = await post(env, order()), j: any = await r.json();
  assert.equal(r.status, 503); assert.equal(j.error, "broker_not_configured"); assert.equal(world.calls.length, 0); assert.equal(kv.keys("reject:").length, 1);
});

test("kill switch, auth, wrong method and missing audit log stop the order before any broker call", async () => {
  const killed = mkEnv({ ETI_KILL_SWITCH: "true" }); let r = await post(killed.env, order()); assert.equal(r.status, 423); assert.equal(((await r.json()) as any).error, "execution_disabled");
  const open = mkEnv(); r = await post(open.env, order(), "/api/orders", null); assert.equal(r.status, 401); r = await post(open.env, order(), "/api/orders", "x".repeat(40)); assert.equal(r.status, 401);
  r = await handleExecution(new Request("https://e/api/orders"), open.env); assert.equal(r.status, 405);
  r = await post({ ...open.env, ETI_EXECUTION_LOG: undefined }, order()); assert.equal(r.status, 503); assert.equal(((await r.json()) as any).error, "audit_log_not_configured");
  r = await post(open.env, "{not json"); assert.equal(r.status, 400);
  assert.equal(world.calls.length, 0, "none of these reached the network"); assert.equal(open.kv.keys("order:").length + open.kv.keys("idem:").length, 0);
});

test("the live endpoint is locked even with every live switch set, and never touches a broker", async () => {
  const { env } = mkEnv({ ETI_LIVE_TRADING_ENABLED: "true" });
  const r = await handleExecution(new Request("https://e/api/orders/live", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "x-eti-live-authorization": "anything", "content-type": "application/json" }, body: JSON.stringify({ ...order(), liveConfirmed: true }) }), env);
  assert.equal(r.status, 423); assert.equal(((await r.json()) as any).error, "live_trading_disabled"); assert.equal(world.calls.length, 0);
  assert.equal((await handleExecution(new Request("https://e/api/orders/live", { method: "POST", body: "{}" }), env)).status, 401);
});

test("duplicates: a reused clientOrderId and an identical rapid order are refused and only one order is sent", async () => {
  const { env, kv } = mkEnv(), first = order();
  assert.equal((await post(env, first)).status, 201);
  const again = await post(env, first), a: any = await again.json();
  assert.equal(again.status, 409); assert.equal(a.error, "duplicate_client_order_id"); assert.equal(a.state, "executed"); assert.equal(a.broker_contacted, false);
  const twin = await post(env, order({ clientOrderId: newId() })), t: any = await twin.json();
  assert.equal(twin.status, 409); assert.equal(t.error, "duplicate_order_window");
  assert.equal(orderPosts().length, 1); assert.equal(kv.keys("reject:").length, 2);
  const off = mkEnv({ ETI_DUPLICATE_WINDOW_SECONDS: "0" }); assert.equal((await post(off.env, order())).status, 201); assert.equal((await post(off.env, order({ clientOrderId: newId() }))).status, 201);
  const other = await post(env, order({ clientOrderId: newId(), quantity: 3 })); assert.equal(other.status, 201, "a different order is not a duplicate");
});

test("a refusal before the broker frees the clientOrderId so the corrected order can be retried", async () => {
  const { env } = mkEnv(), id = newId(); world.alpaca.cash = 50;
  const refused = await post(env, order({ clientOrderId: id })); assert.equal(refused.status, 403);
  world.alpaca.cash = 10_000; const retry = await post(env, order({ clientOrderId: id })); assert.equal(retry.status, 201); assert.equal(orderPosts().length, 1);
});

test("a definite broker rejection is recorded and frees the id; an ambiguous failure keeps it reserved and is never blindly re-sent", async () => {
  const { env, kv } = mkEnv({ ETI_DUPLICATE_WINDOW_SECONDS: "0" }), id = newId();
  world.alpaca.orderMode = "reject";
  let r = await post(env, order({ clientOrderId: id })), j: any = await r.json();
  assert.equal(r.status, 502); assert.equal(j.error, "broker_rejected"); assert.equal(j.outcome, "broker_rejected"); assert.equal(j.broker_contacted, true); assert.equal(j.status, 403); assert.equal(j.detail.message, "insufficient buying power");
  assert.equal(JSON.parse(kv.m.get(kv.keys("reject:")[0])!).outcome, "broker_rejected");
  world.alpaca.orderMode = "ok"; assert.equal((await post(env, order({ clientOrderId: id }))).status, 201, "same id usable after a definite rejection");
  for (const mode of ["http500", "throw"] as const) {
    world.alpaca.orderMode = mode; const uid = newId(), before = orderPosts().length;
    r = await post(env, order({ clientOrderId: uid })); j = await r.json();
    assert.equal(r.status, 502); assert.equal(j.error, "broker_outcome_unknown"); assert.equal(j.outcome, "unknown");
    world.alpaca.orderMode = "ok"; r = await post(env, order({ clientOrderId: uid })); j = await r.json();
    assert.equal(r.status, 409); assert.equal(j.state, "indeterminate"); assert.equal(orderPosts().length, before + 1, "no second POST for an ambiguous order");
  }
  noForbidden();
});

test("history lists executed and refused orders newest first, requires auth and honours the limit", async () => {
  const { env, kv } = mkEnv({ ETI_DUPLICATE_WINDOW_SECONDS: "0" });
  kv.m.set("order:2020-01-01T00:00:00.000Z:legacy000001", JSON.stringify({ executedAt: "2020-01-01T00:00:00.000Z", broker: "alpaca", symbol: "OLD", side: "buy", quantity: 1, clientOrderId: "legacy000001" }));
  await post(env, order()); await new Promise((r) => setTimeout(r, 5)); await post(env, order({ side: "sell", quantity: 50 })); await new Promise((r) => setTimeout(r, 5)); await post(env, order({ quantity: 1 }));
  const r = await history(env), j: any = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(j.records.map((x: any) => x.outcome), ["executed", "rejected", "executed", "executed"]);
  assert.equal(j.records[1].error, "insufficient_holdings"); assert.equal(j.records.at(-1).symbol, "OLD", "legacy record without an outcome is shown as executed");
  assert.deepEqual(j.records.map((x: any) => x.at), [...j.records.map((x: any) => x.at)].sort().reverse());
  assert.equal(((await (await history(env, "?limit=2")).json()) as any).records.length, 2);
  assert.equal((await handleExecution(new Request("https://e/api/execution/history"), env)).status, 401);
  assert.equal((await handleExecution(new Request("https://e/api/execution/history", { method: "POST", headers: { authorization: "Bearer " + TOKEN } }), env)).status, 405);
});

test("advisory readiness never blocks an order when the readiness check cannot run", async () => {
  world.allowUnknown = true; const { env } = mkEnv({ ETI_READINESS_GATE: "advisory" }), r = await post(env, order()), j: any = await r.json();
  assert.equal(r.status, 201); assert.ok(j.readiness); assert.equal(orderPosts().length, 1);
  // enforce blocks exactly when the readiness engine says AVOID TRADING / HIGH RISK. The engine reads the wall clock (session open/close windows), so the expectation is derived from its own verdict for the same instant instead of assuming one.
  const { readinessForOrder } = await import("./readiness/api.ts");
  const at = Date.now(), verdict = (await readinessForOrder({} as any, "equities", "AAPL", at)).status, mustBlock = verdict === "AVOID_TRADING" || verdict === "HIGH_RISK";
  const strict = mkEnv({ ETI_READINESS_GATE: "enforce" }), s = await handleExecution(new Request("https://e/api/orders", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(order({ clientOrderId: newId(), quantity: 1 })) }), strict.env, { now: () => at });
  if (mustBlock) { assert.ok([403, 503].includes(s.status), "enforce blocks on " + verdict); assert.equal(orderPosts().length, 1, "a blocked order never reaches the broker"); }
  else { assert.equal(s.status, 201, "enforce lets " + verdict + " through (only AVOID TRADING / HIGH RISK block)"); assert.equal(orderPosts().length, 2); }
});

test("reservation helper works on a KV without delete", async () => {
  const m = new Map<string, string>(), kv = { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } };
  const f: OrderFacts = { broker: "alpaca", symbol: "AAPL", side: "buy", type: "market", quantity: 1, clientOrderId: "abcdefgh12", actorId: "a" };
  const a = await reserveOrder(kv, f, 60); assert.equal(a.ok, true);
  assert.equal((await reserveOrder(kv, f, 60)).ok, false);
  await releaseReservation(kv, (a as any).reservation); assert.equal((await reserveOrder(kv, f, 60)).ok, true);
});

test("no gateway or live-broker reference remains in execution source", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = walk(new URL(".", import.meta.url).pathname).filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
  for (const f of files.filter((x) => !x.endsWith("/safeguards.ts"))) { const t = readFileSync(f, "utf8"); assert.ok(!/ETI_RISK_GATE|makeGatePreflight|riskGateConfigured|risk_gate_not_configured|live_without_risk_gate|risk-gateway\/preflight/i.test(t), f + " still references the external risk gateway"); }
  for (const f of ["execution.ts", "safeguards.ts", "futures.ts"]) {
    const t = readFileSync(new URL("./" + f, import.meta.url), "utf8");
    assert.ok(!/https:\/\/api\.alpaca\.markets|api\.binance\.com\/api\/v3\/order|ALPACA_LIVE|BINANCE_LIVE|ETI_LIVE_ACTIVATION|ETI_LIVE_MAX/.test(t), f + " must not reference a live broker host or live credential");
  }
});

test("future-proofing: gateway names are confined to the one legacy constant, and config files never ask for them", () => {
  const root = new URL("../", import.meta.url);
  const sg = readFileSync(new URL("./safeguards.ts", import.meta.url), "utf8");
  assert.equal((sg.match(/ETI_RISK_GATE/g) || []).length, 2, "safeguards.ts mentions the retired names only in LEGACY_GATEWAY_VARS");
  for (const f of ["wrangler.jsonc", ".dev.vars.example", ".github/workflows/deploy.yml"]) {
    let t = ""; try { t = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    assert.ok(!/ETI_RISK_GATE|ETI_LIVE_ACTIVATION|ETI_LIVE_TRADING_ENABLED/.test(t), f + " must not configure the retired gateway or a live switch");
  }
});

test("an old deployment that still has gateway settings keeps working and never contacts the gateway", async () => {
  const { env } = mkEnv({ ETI_RISK_GATE_URL: "https://gateway.invalid/preflight", ETI_RISK_GATE_TOKEN: "stale-token" } as any);
  const r = await post(env, order({ clientOrderId: newId(), quantity: 3 })), j: any = await r.json();
  assert.equal(r.status, 201, JSON.stringify(j).slice(0, 200)); assert.equal(j.outcome, "executed");
  assert.ok(world.calls.length > 0 && !world.calls.some((c) => c.host.includes("gateway.invalid")), "the broker was used and the legacy gateway host is never fetched");
  const st: any = await (await handleExecution(new Request("https://e/api/execution/status"), env)).json();
  assert.equal(st.external_risk_gateway, false); assert.equal(st.legacy_gateway_config_ignored, true);
});
