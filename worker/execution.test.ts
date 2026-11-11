import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleExecution, splitSymbol } from "./execution.ts";

// These tests exercise the real handler. Broker HTTP is replaced by a recording stub of globalThis.fetch, so they prove ETI's
// own logic (which requests reach the broker, and which never do). They do NOT prove that Alpaca or Binance accept the order.
interface Opts { alpacaCash?: string; alpacaQty?: string | null; binanceBalances?: any[]; brokerOk?: boolean; accountDown?: boolean }
function harness(o: Opts = {}) {
  const calls: { m: string; u: string; body: string }[] = [], kv = new Map<string, string>();
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  const stub = (async (input: any, init?: any) => {
    const u = String(input), m = init?.method ?? "GET";
    calls.push({ m, u: u.split("?")[0], body: String(init?.body ?? "") });
    if (u.startsWith("https://paper-api.alpaca.markets/v2/account")) return o.accountDown ? json({}, 500) : json({ cash: o.alpacaCash ?? "10000", trading_blocked: false, account_blocked: false });
    if (u.startsWith("https://paper-api.alpaca.markets/v2/positions/")) return o.alpacaQty === null ? json({ message: "position does not exist" }, 404) : json({ qty: o.alpacaQty ?? "5" });
    if (u.startsWith("https://data.alpaca.markets/v2/stocks/")) return json({ trade: { p: 150 } });
    if (u === "https://paper-api.alpaca.markets/v2/orders" && m === "POST") return o.brokerOk === false ? json({ message: "rejected" }, 422) : json({ id: "alp-1", status: "accepted" });
    if (u.startsWith("https://testnet.binance.vision/api/v3/account")) return o.accountDown ? json({}, 500) : json({ balances: o.binanceBalances ?? [{ asset: "USDT", free: "10000", locked: "0" }, { asset: "BTC", free: "1", locked: "0" }] });
    if (u.startsWith("https://testnet.binance.vision/api/v3/ticker/price")) return json({ price: "100" });
    if (u.startsWith("https://testnet.binance.vision/api/v3/order") && m === "POST") return o.brokerOk === false ? json({ code: -2010, msg: "rejected" }, 400) : json({ orderId: 77, status: "NEW" });
    return json({}, 404);
  }) as any;
  const env: any = { ETI_EXECUTION_TOKEN: "x".repeat(32), ALPACA_API_KEY: "a", ALPACA_SECRET_KEY: "b", BINANCE_API_KEY: "k", BINANCE_SECRET_KEY: "s", ETI_READINESS_GATE: "off",
    ETI_EXECUTION_LOG: { put: async (k: string, v: string) => { kv.set(k, v); }, get: async (k: string) => kv.get(k) ?? null, delete: async (k: string) => { kv.delete(k); }, list: async (p: any) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(p?.prefix ?? "")).map((name) => ({ name })) }) } };
  const orderBody = (b: any = {}) => ({ broker: "alpaca", symbol: "AAPL", side: "buy", type: "market", quantity: 1, clientOrderId: "test-order-0001", riskConfirmed: true, executionSource: { actorType: "manual_user", actorId: "u1", sourceName: "test" }, ...b });
  const req = (b: any = {}, init: { path?: string; token?: string | null; raw?: string } = {}) => new Request("https://e.test" + (init.path ?? "/api/orders"), { method: "POST", headers: init.token === null ? {} : { authorization: "Bearer " + (init.token ?? env.ETI_EXECUTION_TOKEN) }, body: init.raw ?? JSON.stringify(orderBody(b)) });
  const run = async <T>(fn: () => Promise<T>) => { const real = globalThis.fetch; globalThis.fetch = stub; try { return await fn(); } finally { globalThis.fetch = real; } };
  const submit = (b: any = {}, init: any = {}, e: any = env) => run(() => handleExecution(req(b, init), e));
  const brokerOrders = () => calls.filter((c) => c.m === "POST" && (c.u.endsWith("/v2/orders") || c.u.endsWith("/api/v3/order")));
  return { calls, kv, env, req, run, submit, brokerOrders };
}
const orderRecords = (h: ReturnType<typeof harness>) => [...h.kv.keys()].filter((k) => k.startsWith("order:")).map((k) => JSON.parse(h.kv.get(k)!));

test("Alpaca Paper BUY and SELL reach the paper endpoint, are audited, and need no risk gateway", async () => {
  const h = harness(), buy = await h.submit(), jb: any = await buy.json();
  assert.equal(buy.status, 201, JSON.stringify(jb)); assert.equal(jb.mode, "paper"); assert.equal(jb.live_trading, false); assert.equal(jb.preTrade.available, 10000);
  assert.equal(h.brokerOrders().length, 1); assert.equal(h.brokerOrders()[0].u, "https://paper-api.alpaca.markets/v2/orders");
  assert.equal(JSON.parse(h.brokerOrders()[0].body).side, "buy");
  const sell = await h.submit({ side: "sell", type: "limit", limitPrice: 150, quantity: 2, clientOrderId: "test-order-0002" }), js: any = await sell.json();
  assert.equal(sell.status, 201, JSON.stringify(js)); assert.equal(h.brokerOrders().length, 2); assert.equal(JSON.parse(h.brokerOrders()[1].body).side, "sell");
  const recs = orderRecords(h); assert.equal(recs.length, 2); assert.equal(recs[0].executionSource.sourceName, "test"); assert.equal(recs[0].broker, "alpaca");
  assert.ok(h.calls.every((c) => c.u.startsWith("https://paper-api.alpaca.markets") || c.u.startsWith("https://data.alpaca.markets")), "only paper/data hosts may be contacted");
});

test("Binance Spot Testnet BUY and SELL reach the testnet endpoint", async () => {
  const h = harness(), buy = await h.submit({ broker: "binance", symbol: "BTCUSDT" }), jb: any = await buy.json();
  assert.equal(buy.status, 201, JSON.stringify(jb)); assert.equal(jb.mode, "testnet"); assert.equal(h.brokerOrders()[0].u, "https://testnet.binance.vision/api/v3/order"); assert.match(h.brokerOrders()[0].body, /side=BUY/);
  const sell = await h.submit({ broker: "binance", symbol: "BTCUSDT", side: "sell", clientOrderId: "test-order-0002" });
  assert.equal(sell.status, 201); assert.match(h.brokerOrders()[1].body, /side=SELL/);
  assert.ok(h.calls.every((c) => c.u.startsWith("https://testnet.binance.vision")));
});

test("rejected orders never reach the broker", async () => {
  const cases: [string, () => Promise<Response>, number, string?][] = [];
  const add = (name: string, make: (h: ReturnType<typeof harness>) => Promise<Response>, status: number, error?: string, opts: Opts = {}) => cases.push([name, async () => { const h = harness(opts); const r = await make(h); assert.equal(h.brokerOrders().length, 0, name + ": order POST reached the broker"); return r; }, status, error]);
  add("no token", (h) => h.submit({}, { token: null }), 401, "unauthorized");
  add("wrong token", (h) => h.submit({}, { token: "y".repeat(32) }), 401, "unauthorized");
  add("kill switch", (h) => h.submit({}, {}, { ...h.env, ETI_KILL_SWITCH: "true" }), 423, "execution_disabled");
  add("live route", (h) => h.submit({}, { path: "/api/orders/live" }), 423, "live_trading_not_supported");
  add("no audit log", (h) => h.submit({}, {}, { ...h.env, ETI_EXECUTION_LOG: undefined }), 503, "audit_log_not_configured");
  add("invalid json", (h) => h.submit({}, { raw: "{nope" }), 400, "invalid_json");
  add("invalid side", (h) => h.submit({ side: "short" }), 400, "invalid_order");
  add("unconfirmed", (h) => h.submit({ riskConfirmed: false }), 400, "invalid_order");
  add("bad client id", (h) => h.submit({ clientOrderId: "x" }), 400, "invalid_order");
  add("no execution source", (h) => h.submit({ executionSource: undefined }), 400, "execution_source_required");
  add("zero quantity", (h) => h.submit({ quantity: 0 }), 400, "invalid_order");
  add("limit without price", (h) => h.submit({ type: "limit" }), 400, "invalid_limit_price");
  add("quantity above limit", (h) => h.submit({ quantity: 11 }, {}, { ...h.env, ETI_MAX_ORDER_QUANTITY: "10" }), 403, "risk_limit_exceeded");
  add("notional above limit", (h) => h.submit({}, {}, { ...h.env, ETI_MAX_ORDER_NOTIONAL_USD: "100" }), 403, "risk_limit_exceeded");
  add("broker not configured", (h) => h.submit({}, {}, { ...h.env, ALPACA_API_KEY: undefined }), 503, "broker_not_configured");
  add("alpaca sell without holdings", (h) => h.submit({ side: "sell" }), 403, "insufficient_holdings", { alpacaQty: null });
  add("alpaca sell more than held", (h) => h.submit({ side: "sell", quantity: 6 }), 403, "insufficient_holdings");
  add("alpaca buy without funds", (h) => h.submit({}), 403, "insufficient_funds", { alpacaCash: "10" });
  add("binance sell more than held", (h) => h.submit({ broker: "binance", symbol: "BTCUSDT", side: "sell", quantity: 2 }), 403, "insufficient_holdings");
  add("binance buy without funds", (h) => h.submit({ broker: "binance", symbol: "BTCUSDT", quantity: 1 }), 403, "insufficient_funds", { binanceBalances: [{ asset: "USDT", free: "5", locked: "0" }] });
  add("binance unsupported symbol", (h) => h.submit({ broker: "binance", symbol: "FOO" }), 400, "unsupported_symbol_format");
  add("alpaca account unreadable", (h) => h.submit({}), 503, "paper_account_unavailable", { accountDown: true });
  add("binance account unreadable", (h) => h.submit({ broker: "binance", symbol: "BTCUSDT" }), 503, "paper_account_unavailable", { accountDown: true });
  for (const [name, run, status, error] of cases) { const r = await run(), j: any = await r.json(); assert.equal(r.status, status, name + ": " + JSON.stringify(j)); if (error) assert.equal(j.error, error, name); }
});

test("duplicate clientOrderId is blocked, and a broker rejection releases the id", async () => {
  const h = harness(), first = await h.submit(), again = await h.submit();
  assert.equal(first.status, 201); assert.equal(again.status, 409); assert.equal(((await again.json()) as any).error, "duplicate_order"); assert.equal(h.brokerOrders().length, 1);
  const rej = harness({ brokerOk: false }), r = await rej.submit(); assert.equal(r.status, 502); assert.equal(((await r.json()) as any).error, "broker_rejected");
  assert.equal(rej.brokerOrders().length, 1); assert.ok(![...rej.kv.keys()].some((k) => k.startsWith("idem:")), "a rejected order must not block a retry"); assert.equal(orderRecords(rej).length, 0);
});

test("status reports paper/testnet only with no gateway dependency; history needs the token", async () => {
  const h = harness(), s: any = await (await h.run(() => handleExecution(new Request("https://e.test/api/execution/status"), h.env))).json();
  assert.equal(s.mode, "paper_testnet_only"); assert.equal(s.live_trading_enabled, false); assert.equal(s.external_risk_gateway_required, false);
  assert.equal(s.alpaca_paper_configured, true); assert.equal(s.binance_testnet_configured, true); assert.equal(s.kill_switch, false); assert.equal(s.withdrawal_permissions, false);
  assert.ok(!JSON.stringify(s).includes("risk_gate") || s.external_risk_gateway_required === false);
  const flagged: any = await (await h.run(() => handleExecution(new Request("https://e.test/api/execution/status"), { ...h.env, ETI_LIVE_TRADING_ENABLED: "true" }))).json();
  assert.equal(flagged.live_trading_enabled, false); assert.equal(flagged.live_flag_set, true);
  await h.submit();
  assert.equal((await h.run(() => handleExecution(new Request("https://e.test/api/execution/history"), h.env))).status, 401);
  const hist: any = await (await h.run(() => handleExecution(new Request("https://e.test/api/execution/history", { headers: { authorization: "Bearer " + h.env.ETI_EXECUTION_TOKEN } }), h.env))).json();
  assert.equal(hist.records.length, 1); assert.equal(hist.records[0].mode, "paper");
});

test("the execution module contains no live broker URL and no external risk-gateway reference", () => {
  const src = readFileSync(new URL("./execution.ts", import.meta.url), "utf8");
  assert.ok(!/api\.binance\.com/.test(src)); assert.ok(!/https:\/\/api\.alpaca\.markets/.test(src)); assert.ok(!/ETI_RISK_GATE/.test(src)); assert.ok(!/ALPACA_LIVE|BINANCE_LIVE|LIVE_ACTIVATION/.test(src));
  assert.deepEqual(splitSymbol("BTCUSDT"), { base: "BTC", quote: "USDT" }); assert.deepEqual(splitSymbol("ETHBTC"), { base: "ETH", quote: "BTC" }); assert.equal(splitSymbol("FOO"), null);
});
