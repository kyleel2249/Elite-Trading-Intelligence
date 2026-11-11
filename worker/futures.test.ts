import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, estimateLiquidation, futuresHardChecks, handleFutures } from "./futures.ts";
import type { FuturesCaps, FuturesState } from "./futures.ts";
import { estimateCosts, planFutures } from "./agents/futures-plan.ts";
import { parseFuturesFilters, withFutures } from "./agents/futures-route.ts";
import type { Depth, Kline, MarketInput } from "./agents/types.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const st = (o: Partial<FuturesState> = {}): FuturesState => ({ positionAmt: 0, entryPrice: 0, markPrice: 100, liquidationPrice: 0, leverage: 3, marginType: "isolated", availableBalance: 1000, walletBalance: 1000, fundingRate: 0, canTrade: true, dualSide: false, ...o });
const caps: FuturesCaps = { maxLeverage: 3, maxNotionalUsd: 1000 };
const short = { side: "sell" as const, quantity: 1, limitPrice: 100, reduceOnly: false, leverage: 3, stopPrice: 102 };
const reasons = (r: ReturnType<typeof futuresHardChecks>) => (r.ok ? [] : r.reasons);

test("intent classification distinguishes BUY, SELL, SHORT and COVER", () => {
  assert.equal(classifyIntent("buy", 0), "BUY"); assert.equal(classifyIntent("buy", 2), "BUY"); assert.equal(classifyIntent("buy", -2), "COVER");
  assert.equal(classifyIntent("sell", 2), "SELL"); assert.equal(classifyIntent("sell", 0), "SHORT"); assert.equal(classifyIntent("sell", -2), "SHORT");
  assert.ok(estimateLiquidation(100, 5, "sell") > 100 && estimateLiquidation(100, 5, "buy") < 100);
});

test("hard checks accept a well-formed short and reject unsafe variants", () => {
  const ok = futuresHardChecks(short, st(), caps); assert.ok(ok.ok); if (ok.ok) { assert.equal(ok.intent, "SHORT"); assert.ok(ok.estLiquidation! > 104); }
  assert.ok(reasons(futuresHardChecks(short, st({ positionAmt: 2, entryPrice: 100 }), caps)).includes("opposing_order_must_be_reduce_only"), "a plain sell against a long must never open/flip into a short");
  assert.ok(reasons(futuresHardChecks({ ...short, stopPrice: undefined }, st(), caps)).includes("protective_stop_price_required"));
  assert.ok(reasons(futuresHardChecks({ ...short, stopPrice: 98 }, st(), caps)).includes("protective_stop_price_required"), "short stop must be above entry");
  assert.ok(reasons(futuresHardChecks({ ...short, leverage: 4 }, st(), caps)).includes("leverage_above_cap"));
  assert.ok(reasons(futuresHardChecks({ ...short, quantity: 11 }, st(), caps)).includes("notional_above_cap"));
  assert.ok(reasons(futuresHardChecks({ ...short, limitPrice: 105, stopPrice: 107 }, st(), caps)).includes("limit_price_far_from_mark"));
  assert.ok(reasons(futuresHardChecks({ ...short, leverage: 5, stopPrice: 125 }, st(), { ...caps, maxLeverage: 5 })).includes("liquidation_too_close_to_stop"));
  assert.ok(reasons(futuresHardChecks(short, st({ fundingRate: -0.002 }), caps)).includes("adverse_funding_extreme"));
  assert.ok(reasons(futuresHardChecks(short, st({ dualSide: true }), caps)).includes("hedge_mode_unsupported"));
  assert.ok(reasons(futuresHardChecks(short, st({ canTrade: false }), caps)).includes("account_cannot_trade"));
  assert.ok(reasons(futuresHardChecks(short, st({ availableBalance: 10 }), caps)).includes("insufficient_margin_buffer"));
  assert.ok(reasons(futuresHardChecks({ ...short, side: "buy", stopPrice: 98 }, st({ positionAmt: 1, entryPrice: 100, marginType: "cross" }), caps)).includes("existing_position_not_isolated"));
});

test("reduce-only exits: only against an existing opposite position and never larger than it", () => {
  const exit = { side: "sell" as const, quantity: 2, limitPrice: 99.9, reduceOnly: true, leverage: 3 };
  const ok = futuresHardChecks(exit, st({ positionAmt: 2, entryPrice: 100 }), caps); assert.ok(ok.ok); if (ok.ok) assert.equal(ok.intent, "SELL");
  assert.ok(reasons(futuresHardChecks({ ...exit, quantity: 3 }, st({ positionAmt: 2 }), caps)).includes("reduce_quantity_exceeds_position"));
  assert.ok(reasons(futuresHardChecks({ ...exit, side: "buy" }, st({ positionAmt: 0 }), caps)).includes("reduce_only_without_position"));
  assert.ok(reasons(futuresHardChecks({ ...exit, side: "buy" }, st({ positionAmt: 2 }), caps)).includes("reduce_only_must_oppose_position"));
  const cover = futuresHardChecks({ ...exit, side: "buy", quantity: 1, limitPrice: 100.1 }, st({ positionAmt: -1, leverage: 10 }), { maxLeverage: 3, maxNotionalUsd: 1 });
  assert.ok(cover.ok, "exits must not be blocked by leverage or notional caps");
});

test("cost model counts fees, slippage and adverse funding but not funding receipts", () => {
  const c = estimateCosts({ side: "sell", quantity: 1, price: 100, fundingRate: 0.0001 });
  assert.ok(Math.abs(c.feesUsd - 0.1) < 1e-9 && Math.abs(c.slippageUsd - 0.1) < 1e-9 && c.fundingUsd < 0 && Math.abs(c.totalUsd - 0.2) < 1e-9);
  const adverse = estimateCosts({ side: "buy", quantity: 1, price: 100, fundingRate: 0.0009 });
  assert.ok(adverse.totalUsd > 0.4);
});

const fake = (dir: "long" | "short", over: any = {}) => ({
  id: "a1", symbol: "BTCUSDT", deliberation: { direction: dir },
  decision: { executionEligible: true, action: dir === "long" ? "BUY" : "SELL", proposal: { symbol: "BTCUSDT", side: dir === "long" ? "buy" : "sell", entry: 100, stop: dir === "long" ? 98 : 102, targets: dir === "long" ? [102, 104, 106] : [98, 96, 94], atr: 1.33, stopDistance: 2 } },
  risk: { approved: true, sizing: { quantity: 1 }, vetoes: [] }, ...over,
}) as any;
const base = { caps, marketFresh: true, flags: { enabled: true, killSwitch: false }, request: { clientOrderId: "fut-test-0001", riskConfirmed: true } };

test("plans map consensus + position to the correct action", () => {
  const s = planFutures({ ...base, analysis: fake("short"), state: st() });
  assert.equal(s.action, "SHORT"); assert.equal(s.eligible, true, s.blockers.join()); assert.equal(s.ticket!.side, "sell"); assert.equal(s.ticket!.reduceOnly, false); assert.equal(s.ticket!.stopPrice, 102); assert.ok(s.costs && s.liquidation?.estimated);
  const b = planFutures({ ...base, analysis: fake("long"), state: st() }); assert.equal(b.action, "BUY"); assert.equal(b.eligible, true, b.blockers.join());
  const cover = planFutures({ ...base, analysis: fake("long"), state: st({ positionAmt: -1, entryPrice: 100 }) });
  assert.equal(cover.action, "COVER"); assert.equal(cover.reduceOnly, true); assert.equal(cover.ticket!.quantity, 1); assert.equal(cover.ticket!.side, "buy");
  const sell = planFutures({ ...base, analysis: fake("short"), state: st({ positionAmt: 2, entryPrice: 100 }) });
  assert.equal(sell.action, "SELL"); assert.equal(sell.reduceOnly, true); assert.equal(sell.ticket!.quantity, 2);
  assert.equal(planFutures({ ...base, analysis: fake("long", { deliberation: { direction: "none" } }), state: st() }).action, "NO_TRADE");
});

test("plans are blocked by risk veto, disabled flag, kill switch, missing state and missing confirmation", () => {
  const veto = planFutures({ ...base, analysis: fake("short", { decision: { ...fake("short").decision, executionEligible: false }, risk: { approved: false, sizing: null, vetoes: ["event_hazard"] } }), state: st() });
  assert.equal(veto.eligible, false); assert.ok(veto.blockers.includes("risk_not_approved") && veto.blockers.includes("risk_veto:event_hazard"));
  assert.ok(planFutures({ ...base, flags: { enabled: false, killSwitch: false }, analysis: fake("short"), state: st() }).blockers.includes("futures_disabled"));
  assert.ok(planFutures({ ...base, flags: { enabled: true, killSwitch: true }, analysis: fake("short"), state: st() }).blockers.includes("kill_switch_active"));
  assert.ok(planFutures({ ...base, analysis: fake("short"), state: null }).blockers.includes("futures_state_unavailable"));
  assert.ok(planFutures({ ...base, request: {}, analysis: fake("short"), state: st() }).blockers.includes("risk_confirmation_required"));
  assert.equal(planFutures({ ...base, marketFresh: false, analysis: fake("short"), state: st() }).eligible, false);
});

function harness(opts: { positionAmt?: string; liq?: string; orderStatus?: number } = {}) {
  const calls: string[] = [], kv = new Map<string, string>();
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  const fetchStub = (async (input: any, init?: any) => {
    const u = String(input); calls.push((init?.method ?? "GET") + " " + u.split("?")[0]);
    if (u.includes("/fapi/v2/account")) return json({ canTrade: true, availableBalance: "1000", totalWalletBalance: "1000" });
    if (u.includes("/fapi/v2/positionRisk")) return json([{ symbol: "BTCUSDT", positionAmt: opts.positionAmt ?? "0", entryPrice: "100", markPrice: "100", liquidationPrice: opts.liq ?? "0", leverage: "3", marginType: "isolated", unRealizedProfit: "0" }]);
    if (u.includes("/fapi/v1/positionSide/dual")) return json({ dualSidePosition: false });
    if (u.includes("/fapi/v1/premiumIndex")) return json({ markPrice: "100", lastFundingRate: "0.0001" });
    if (u.includes("example.invalid")) throw new Error("an external gateway host must never be contacted");
    if (u.includes("/fapi/v1/order")) return opts.orderStatus ? json({ code: -1, msg: "x" }, opts.orderStatus) : json({ orderId: 123, status: "NEW" });
    return json({}, 404);
  }) as any;
  const env: any = { ETI_EXECUTION_TOKEN: "x".repeat(32), ETI_FUTURES_ENABLED: "true", ETI_FUTURES_MAX_NOTIONAL_USD: "1000", ETI_FUTURES_MAX_LEVERAGE: "3", BINANCE_FUTURES_API_KEY: "k", BINANCE_FUTURES_SECRET_KEY: "s", ETI_EXECUTION_LOG: { put: async (k: string, v: string) => { kv.set(k, v); }, get: async (k: string) => kv.get(k) ?? null, list: async () => ({ keys: [...kv.keys()].map((name) => ({ name })) }) } };
  const order = (o: any = {}) => new Request("https://e.test/api/futures/orders", { method: "POST", headers: { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN }, body: JSON.stringify({ symbol: "BTCUSDT", side: "sell", quantity: 1, limitPrice: 100, leverage: 3, stopPrice: 102, reduceOnly: false, clientOrderId: "fut-test-0001", riskConfirmed: true, executionSource: { actorType: "manual_user", actorId: "u1", sourceName: "test" }, ...o }) });
  const run = async <T>(fn: () => Promise<T>) => { const real = globalThis.fetch; globalThis.fetch = fetchStub; try { return await fn(); } finally { globalThis.fetch = real; } };
  return { calls, kv, env, order, run };
}

test("gateway: testnet-only short entry succeeds, is audited, and never touches a live host", async () => {
  const h = harness(), res = await h.run(() => handleFutures(h.order(), h.env)), j: any = await res.json();
  assert.equal(res.status, 201, JSON.stringify(j)); assert.equal(j.intent, "SHORT"); assert.match(j.protectiveStop, /NOT placed/);
  assert.ok(h.calls.some((c) => c === "POST https://testnet.binancefuture.com/fapi/v1/order"));
  assert.ok(h.calls.every((c) => c.includes("testnet.binancefuture.com")), h.calls.join("\n"));
  const rec = JSON.parse(h.kv.get([...h.kv.keys()].find((k) => k.startsWith("order:"))!)!); assert.equal(rec.mode, "futures_testnet"); assert.equal(rec.intent, "SHORT"); assert.equal(rec.outcome, "executed"); assert.equal(rec.brokerStatus, "NEW"); assert.equal(j.brokerOrderId, 123);
});

test("gateway: reduce-only COVER of a short is accepted; a plain buy-to-cover is not required but intent mismatches are rejected", async () => {
  const h = harness({ positionAmt: "-1" });
  const ok = await h.run(() => handleFutures(h.order({ side: "buy", limitPrice: 100.1, reduceOnly: true, stopPrice: undefined, intent: "COVER", clientOrderId: "fut-test-0002" }), h.env));
  assert.equal(ok.status, 201); assert.equal(((await ok.json()) as any).intent, "COVER");
  const bad = await h.run(() => handleFutures(h.order({ side: "buy", limitPrice: 100.1, reduceOnly: true, stopPrice: undefined, intent: "BUY", clientOrderId: "fut-test-0003" }), h.env));
  assert.equal(bad.status, 400); assert.equal(((await bad.json()) as any).error, "intent_mismatch");
});

test("gateway: hard limits, auth, flag and kill switch all stop the order before submission", async () => {
  let h = harness({ positionAmt: "2" });
  let r = await h.run(() => handleFutures(h.order(), h.env)); assert.equal(r.status, 403); assert.ok((((await r.json()) as any).reasons as string[]).includes("opposing_order_must_be_reduce_only")); assert.ok(!h.calls.some((c) => c.includes("/fapi/v1/order")));
  assert.ok([...h.kv.keys()].some((k) => k.startsWith("reject:")), "the refusal was audited");
  h = harness();
  assert.equal((await h.run(() => handleFutures(new Request("https://e.test/api/futures/orders", { method: "POST", body: "{}" }), h.env))).status, 401);
  assert.equal((await h.run(() => handleFutures(h.order(), { ...h.env, ETI_FUTURES_ENABLED: "false" }))).status, 423);
  assert.equal((await h.run(() => handleFutures(h.order(), { ...h.env, ETI_KILL_SWITCH: "true" }))).status, 423);
  assert.equal((await h.run(() => handleFutures(h.order(), { ...h.env, ETI_FUTURES_MAX_NOTIONAL_USD: undefined }))).status, 503);
  assert.equal((await h.run(() => handleFutures(h.order({ leverage: 9 }), h.env))).status, 403);
  assert.equal(h.calls.filter((c) => c.includes("/fapi/v1/order")).length, 0);
});

test("gateway: refused orders are audited, a reused clientOrderId is refused, and an ambiguous exchange failure is never re-sent", async () => {
  let h = harness();
  const ok = await h.run(() => handleFutures(h.order(), h.env)); assert.equal(ok.status, 201);
  const dup = await h.run(() => handleFutures(h.order(), h.env)), d: any = await dup.json();
  assert.equal(dup.status, 409); assert.equal(d.error, "duplicate_client_order_id"); assert.equal(d.broker_contacted, false);
  assert.equal(h.calls.filter((c) => c === "POST https://testnet.binancefuture.com/fapi/v1/order").length, 1);
  const rejects = [...h.kv.keys()].filter((k) => k.startsWith("reject:")); assert.equal(rejects.length, 1); assert.equal(JSON.parse(h.kv.get(rejects[0])!).brokerContacted, false);
  h = harness({ orderStatus: 400 });
  const bad = await h.run(() => handleFutures(h.order(), h.env)), bj: any = await bad.json(); assert.equal(bad.status, 502); assert.equal(bj.outcome, "broker_rejected"); assert.equal(bj.broker_contacted, true);
  h = harness({ orderStatus: 503 });
  const amb = await h.run(() => handleFutures(h.order(), h.env)), aj: any = await amb.json(); assert.equal(amb.status, 502); assert.equal(aj.outcome, "unknown");
  const again = await h.run(() => handleFutures(h.order(), h.env)); assert.equal(again.status, 409);
  assert.equal(h.calls.filter((c) => c === "POST https://testnet.binancefuture.com/fapi/v1/order").length, 1, "no blind re-send after an ambiguous failure");
  const status: any = await (await handleFutures(new Request("https://e.test/api/futures/status"), h.env)).json(); assert.equal(status.external_risk_gateway, false); assert.equal(status.safeguards.engine, "in_process");
});

test("gateway: positions endpoint reports liquidation distance and risk level", async () => {
  const h = harness({ positionAmt: "1", liq: "95" });
  const res = await h.run(() => handleFutures(new Request("https://e.test/api/futures/positions", { headers: { authorization: "Bearer " + h.env.ETI_EXECUTION_TOKEN } }), h.env)), j: any = await res.json();
  assert.equal(res.status, 200); assert.equal(j.positions[0].liquidationRisk, "critical"); assert.equal(Math.round(j.positions[0].liquidationDistancePct), 5);
  const status: any = await (await handleFutures(new Request("https://e.test/api/futures/status"), h.env)).json(); assert.equal(status.live_futures, false); assert.equal(status.withdrawal_permissions, false);
});

test("futures filters parse MIN_NOTIONAL from the `notional` field", () => {
  const f = parseFuturesFilters({ symbols: [{ symbol: "BTCUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" }, { filterType: "PRICE_FILTER", tickSize: "0.1", minPrice: "1", maxPrice: "1000000" }, { filterType: "MIN_NOTIONAL", notional: "100" }] }] }, "BTCUSDT");
  assert.equal(f?.minNotional, 100); assert.equal(f?.tickSize, 0.1); assert.equal(parseFuturesFilters({ symbols: [] }, "BTCUSDT"), null);
});

function lcg(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function candles(n: number): Kline[] { const rnd = lcg(7), out: Kline[] = []; let prev = 100; for (let i = 0; i < n; i++) { const c = prev * (1 + 0.002 + 0.004 * (rnd() - 0.5)); out.push([NOW - 600_000 - (n - 1 - i) * 3_600_000, prev, Math.max(prev, c) * 1.001, Math.min(prev, c) * 0.999, c, 1000 + rnd() * 200]); prev = c; } return out; }
const depthAround = (p: number): Depth => ({ bids: Array.from({ length: 30 }, (_, i) => [p * (1 - 0.0004 - i * 0.0004), 50] as [number, number]), asks: Array.from({ length: 30 }, (_, i) => [p * (1 + 0.0004 + i * 0.0004), 50] as [number, number]) });

test("agent futures routes: bearer required, preview returns a plan, execute is blocked without confirmation", async () => {
  const cs = candles(300), market: MarketInput = { symbol: "BTCUSDT", interval: "1h", candles: cs, depth: depthAround(cs[cs.length - 1][4]), provider: "test", fetchedAt: NOW, crossCheck: null, benchmark: null, failures: {} };
  let baseCalls = 0, handlerCalls = 0;
  const app = withFutures({ fetch: () => { baseCalls++; return new Response("base"); } } as any, { loadMarket: async () => market, loadProviders: async () => ({ supplied: {}, status: [] }), loadState: async () => st({ markPrice: cs[cs.length - 1][4] }), loadFilters: async () => ({ stepSize: 0.001, tickSize: 0.01, minNotional: 5 }), now: () => NOW });
  const env: any = { ETI_EXECUTION_TOKEN: "x".repeat(32), ETI_FUTURES_ENABLED: "true", ETI_FUTURES_MAX_NOTIONAL_USD: "1000" };
  const real = globalThis.fetch; globalThis.fetch = (async () => { handlerCalls++; return new Response("{}", { status: 404 }); }) as any;
  try {
    assert.equal(await (await app.fetch(new Request("https://e.test/other"), env)).text(), "base");
    assert.equal((await app.fetch(new Request("https://e.test/api/agents/futures/analyze"), env)).status, 401);
    const auth = { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN };
    const a: any = await (await app.fetch(new Request("https://e.test/api/agents/futures/analyze?symbol=BTCUSDT", { headers: auth }), env)).json();
    assert.equal(a.futuresPlan.schema, "eti.futures.plan/1"); assert.equal(a.futuresPlan.venue, "binance_futures_testnet"); assert.equal(a.analysis.reports.length, 12);
    assert.ok(["BUY", "SHORT", "SELL", "COVER", "NO_TRADE"].includes(a.futuresPlan.action));
    const r = await app.fetch(new Request("https://e.test/api/agents/futures/execute", { method: "POST", headers: auth, body: JSON.stringify({ symbol: "BTCUSDT" }) }), env), j: any = await r.json();
    assert.equal(r.status, 409); assert.equal(j.error, "blocked_by_agents"); assert.equal(handlerCalls, 0, "no gateway/broker call when the plan is not eligible");
  } finally { globalThis.fetch = real; }
});
