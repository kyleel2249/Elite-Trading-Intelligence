import test from "node:test";
import assert from "node:assert/strict";
import { handlePaper, makeGatePreflight, type PaperEnv } from "./algo/paper-api.ts";
import worker from "./index.ts";
import { series } from "./algo/fixtures.ts";

const TOKEN = "t".repeat(40), NOW = Date.UTC(2026, 10, 9, 12, 0, 0), PX = series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: 900000, end: 0 }).at(-1)![4]; // every timeframe ends at this same price in the fixture
const MS: Record<string, number> = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
function fakeKV() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, list: async (o: { prefix: string; limit?: number }) => ({ keys: [...m.keys()].filter(k => k.startsWith(o.prefix)).sort().slice(0, o.limit ?? 1000).map(name => ({ name })) }) };
}
interface World { clock: number; minuteOverride: ((interval: string) => unknown[][] | null) | null; gate: "approve" | "reject" | "down" | "http500"; gateCalls: { headers: Record<string, string>; body: any }[]; depthOk: boolean }
const world: World = { clock: NOW, minuteOverride: null, gate: "approve", gateCalls: [], depthOk: true };
const fetchImpl = (async (input: any, init?: any) => {
  const u = new URL(String(input));
  if (u.host === "gate.test") {
    world.gateCalls.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(init.body) });
    if (world.gate === "down") throw new TypeError("connect refused");
    if (world.gate === "http500") return new Response("boom", { status: 500 });
    return new Response(JSON.stringify(world.gate === "approve" ? { approved: true, decision: "APPROVED", reasons: ["All risk checks passed"] } : { approved: false, decision: "REJECTED", reasons: ["Daily loss limit hit"] }), { status: 200 });
  }
  if (u.host !== "data-api.binance.vision") return new Response("down", { status: 500 });
  if (u.pathname.includes("klines")) {
    const iv = u.searchParams.get("interval") || "1h", ov = world.minuteOverride?.(iv);
    if (ov) return new Response(JSON.stringify(ov), { status: 200 });
    const step = MS[iv], rows = series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: step, end: world.clock - step * 0.5 });
    return new Response(JSON.stringify(rows.map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), 0, "0", 1, "0", "0", "0"])), { status: 200 });
  }
  if (u.pathname.includes("depth") && world.depthOk) return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 50 }, (_, i) => [String(PX - 0.01 - i * 0.01), "50"]), asks: Array.from({ length: 50 }, (_, i) => [String(PX + 0.01 + i * 0.01), "50"]) }), { status: 200 });
  return new Response("down", { status: 500 });
}) as typeof fetch;
const realFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = fetchImpl; world.clock = NOW; world.minuteOverride = null; world.gate = "approve"; world.gateCalls = []; world.depthOk = true; });
test.afterEach(() => { globalThis.fetch = realFetch; });

const mkEnv = (o: Partial<PaperEnv> = {}): PaperEnv & { kv: ReturnType<typeof fakeKV> } => { const kv = fakeKV(); return { ETI_EXECUTION_TOKEN: TOKEN, ETI_EXECUTION_LOG: kv as any, ETI_RISK_GATE_URL: "https://gate.test/api/risk-gateway/preflight", ETI_RISK_GATE_TOKEN: "gate-secret", ETI_ROUND_TRIP_COST_BPS: "0", ...o, kv } as any; };
const call = (env: PaperEnv, path: string, method = "GET", body?: unknown, token: string | null = TOKEN) =>
  handlePaper(new Request("https://eti.test" + path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { now: () => world.clock, fetchImpl });
const json = async (r: Response) => r.json() as Promise<any>;
const openOnce = async (env: PaperEnv) => { const r = await json(await call(env, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT", strategy: "intraday", execute: true })); return r; };

test("every route requires the bearer token; unknown paths and withdrawal-style paths do not exist", async () => {
  const env = mkEnv();
  for (const [p, m] of [["/api/paper/status", "GET"], ["/api/paper/performance", "GET"], ["/api/paper/audit", "GET"], ["/api/paper/evaluate", "POST"], ["/api/paper/tick", "POST"], ["/api/paper/kill", "POST"]] as const) {
    assert.equal((await call(env, p, m, m === "POST" ? {} : undefined, null)).status, 401, p + " without token");
    assert.equal((await call(env, p, m, m === "POST" ? {} : undefined, "x".repeat(40))).status, 401, p + " wrong token");
  }
  assert.equal((await call(mkEnv({ ETI_EXECUTION_TOKEN: undefined }), "/api/paper/status")).status, 401, "unconfigured token never authorises");
  for (const p of ["/api/paper/withdraw", "/api/paper/transfer", "/api/paper/live", "/api/paper"]) assert.equal((await call(env, p, "POST", {})).status, 404, p);
  assert.equal((await call(env, "/api/paper/status", "POST", {})).status, 405);
});
test("state storage is mandatory: without the KV binding paper trading is unavailable", async () => {
  const r = await call(mkEnv({ ETI_EXECUTION_LOG: undefined }), "/api/paper/status"); assert.equal(r.status, 503); assert.equal((await json(r)).error, "audit_log_not_configured");
});
test("status reports simulated mode, no live capability and no withdrawal permission", async () => {
  const b = await json(await call(mkEnv(), "/api/paper/status"));
  assert.equal(b.mode, "paper"); assert.equal(b.simulated, true); assert.equal(b.liveTradingAvailable, false); assert.equal(b.withdrawalPermissions, false); assert.equal(b.riskGateConfigured, true); assert.equal(b.equity, 10000);
});
test("evaluate without execute analyses only and changes no state", async () => {
  const env = mkEnv(), b = await json(await call(env, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT", strategy: "intraday" }));
  assert.equal(b.executed, false); assert.equal(b.event, null); assert.equal(b.plan.decision, "BUY"); assert.equal(b.submitsOrder, false); assert.equal(world.gateCalls.length, 0);
  assert.equal((await json(await call(env, "/api/paper/status"))).openPositions.length, 0);
});
test("execute goes through the Python gateway contract (limit order, x-api-key) and opens a persisted paper position", async () => {
  const env = mkEnv(), b = await openOnce(env);
  assert.equal(b.executed, true, JSON.stringify(b.event)); assert.equal(b.event.type, "OPENED");
  assert.equal(world.gateCalls.length, 1); const g = world.gateCalls[0];
  assert.equal(g.headers["x-api-key"], "gate-secret"); assert.deepEqual([g.body.provider, g.body.environment, g.body.order_type, g.body.side, g.body.symbol], ["binance", "paper", "limit", "buy", "BTCUSDT"]);
  assert.ok(g.body.quantity > 0 && g.body.limit_price > 0);
  const st = await json(await call(env, "/api/paper/status")); assert.equal(st.openPositions.length, 1); assert.ok(st.equity < 10000, "entry fee charged");
  const audit = await json(await call(env, "/api/paper/audit")); assert.ok(audit.entries.some((e: any) => e.type === "OPENED" && e.detail.reasoning.length > 0));
});
test("a second execute while a position is open cannot stack or average down", async () => {
  const env = mkEnv(); await openOnce(env); world.clock += 1000;
  const b = await openOnce(env); assert.equal(b.executed, false); assert.match(b.event.reasons[0], /already open/); assert.equal(world.gateCalls.length, 1, "gateway not even asked");
  assert.equal((await json(await call(env, "/api/paper/status"))).openPositions.length, 1);
});
test("fail closed: gateway rejecting, erroring, unreachable or unconfigured blocks the order", async () => {
  for (const [gate, re] of [["reject", /Risk gateway rejected/], ["http500", /rejected|HTTP 500/], ["down", /unreachable/]] as const) {
    world.gate = gate; const env = mkEnv(), b = await openOnce(env);
    assert.equal(b.executed, false, gate); assert.equal(b.event.type, "REJECTED"); assert.match(b.event.reasons.join(" "), re, gate);
    assert.equal((await json(await call(env, "/api/paper/status"))).openPositions.length, 0);
  }
  const b = await openOnce(mkEnv({ ETI_RISK_GATE_URL: undefined })); assert.equal(b.executed, false); assert.match(b.event.reasons[0], /not configured/);
  const gw = makeGatePreflight({ ETI_RISK_GATE_URL: "https://gate.test/x", ETI_RISK_GATE_TOKEN: "k" }, (async () => new Response(JSON.stringify({ approved: "true" }), { status: 200 })) as any);
  assert.equal((await gw!({ mode: "paper", symbol: "BTCUSDT", side: "buy", quantity: 1, orderType: "limit", limitPrice: 1, clientOrderId: "x", source: { actorType: "strategy", actorId: "a", signalGeneratedAt: "t" } })).approved, false, "only boolean true approves");
});
test("kill switches: the env switch returns 423 and the API switch blocks new orders", async () => {
  const b = await call(mkEnv({ ETI_KILL_SWITCH: "true" }), "/api/paper/evaluate", "POST", { symbol: "BTCUSDT", execute: true }); assert.equal(b.status, 423); assert.equal(world.gateCalls.length, 0);
  const env = mkEnv(); assert.equal((await json(await call(env, "/api/paper/kill", "POST", { on: true }))).killSwitch, true);
  const r = await openOnce(env); assert.equal(r.executed, false); assert.match(r.event.reasons[0], /Kill switch/);
  await call(env, "/api/paper/kill", "POST", { on: false }); assert.equal((await openOnce(env)).executed, true);
  assert.equal((await call(env, "/api/paper/kill", "POST", { on: "yes" })).status, 400);
});
test("input validation and data failure", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "/api/paper/evaluate", "POST", { symbol: "bad!" })).status, 400);
  assert.equal((await call(env, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT", strategy: "yolo" })).status, 400);
  assert.equal((await call(env, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT", execute: "yes" })).status, 400);
  assert.equal((await handlePaper(new Request("https://eti.test/api/paper/evaluate", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: "{not json" }), env, { now: () => NOW, fetchImpl })).status, 400);
  globalThis.fetch = (async () => { throw new TypeError("down"); }) as any;
  const down = await handlePaper(new Request("https://eti.test/api/paper/evaluate", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: JSON.stringify({ symbol: "BTCUSDT", execute: true }) }), env, { now: () => NOW, fetchImpl: (async () => { throw new TypeError("down"); }) as any });
  assert.equal(down.status, 503); assert.equal((await json(down)).decision, "DATA_UNRELIABLE");
});
const minute = (t: number, o: number, h: number, l: number, c: number) => [t, String(o), String(h), String(l), String(c), "10", 0, "0", 1, "0", "0", "0"];
test("tick applies closed 1m bars once: a stop-out closes the trade, feeds performance, and a repeat tick is a no-op", async () => {
  const env = mkEnv(), o = await openOnce(env); assert.equal(o.executed, true);
  const pos = (await json(await call(env, "/api/paper/status"))).openPositions[0], t0 = Math.ceil(pos.openedAt / 60000) * 60000;
  world.clock = t0 + 10 * 60000;
  world.minuteOverride = iv => (iv === "1m" ? [minute(t0 - 60000, PX, 999, 1, PX) /* pre-fill bar: must be ignored */, minute(t0, PX, PX + 0.2, PX - 0.1, PX), minute(t0 + 60000, PX, PX + 0.1, pos.stop - 1, pos.stop), minute(t0 + 9 * 60000, 100, 100, 100, 100)] : null);
  const tick = await json(await call(env, "/api/paper/tick", "POST", { symbol: "BTCUSDT" }));
  assert.deepEqual(tick.events.map((e: any) => e.type), ["STOP", "CLOSED"]); assert.equal(tick.position, null); assert.equal(tick.barsPending, 3, "pre-fill bar excluded; processing stops once the position closes");
  const st = await json(await call(env, "/api/paper/status")); assert.equal(st.openPositions.length, 0); assert.equal(st.closedTrades, 1); assert.ok(st.equity < 10000);
  const perf = await json(await call(env, "/api/paper/performance")); assert.equal(perf.trades, 1); assert.equal(perf.windows.all.status, "insufficient_sample"); assert.equal(perf.windows.all.winRate, null); assert.ok(perf.windows.all.winRateInterval95);
  const again = await json(await call(env, "/api/paper/tick", "POST", { symbol: "BTCUSDT" })); assert.deepEqual(again.events, []); assert.match(again.message, /No open paper position/);
});
test("tick does not re-apply bars already processed, and a position that survives keeps its progress", async () => {
  const env = mkEnv(); await openOnce(env);
  const pos = (await json(await call(env, "/api/paper/status"))).openPositions[0], t0 = Math.ceil(pos.openedAt / 60000) * 60000;
  world.clock = t0 + 5 * 60000; world.minuteOverride = iv => (iv === "1m" ? [minute(t0, PX, PX + 0.3, PX - 0.1, PX + 0.1), minute(t0 + 60000, PX + 0.1, PX + 0.3, PX - 0.05, PX + 0.2)] : null);
  const a = await json(await call(env, "/api/paper/tick", "POST", { symbol: "BTCUSDT" })); assert.equal(a.barsPending, 2); assert.equal(a.position.lastBarTs, t0 + 120000);
  const b = await json(await call(env, "/api/paper/tick", "POST", { symbol: "BTCUSDT" })); assert.equal(b.barsPending, 0); assert.deepEqual(b.events, []);
});
test("tick for a symbol with no position, and with market data down, behaves safely", async () => {
  const env = mkEnv(); assert.match((await json(await call(env, "/api/paper/tick", "POST", { symbol: "ETHUSDT" }))).message, /No open paper position/);
  await openOnce(env); globalThis.fetch = (async () => { throw new TypeError("down"); }) as any;
  const r = await handlePaper(new Request("https://eti.test/api/paper/tick", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: JSON.stringify({ symbol: "BTCUSDT" }) }), env, { now: () => world.clock, fetchImpl });
  assert.equal(r.status, 503); assert.equal((await json(await call(env, "/api/paper/status"))).openPositions.length, 1, "position untouched when data is unavailable");
});
test("the Worker router serves /api/paper/* and keeps it behind auth", async () => {
  const kv = fakeKV(), env: any = { ETI_EXECUTION_TOKEN: TOKEN, ETI_EXECUTION_LOG: kv };
  assert.equal((await worker.fetch(new Request("https://eti.test/api/paper/status"), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://eti.test/api/paper/status", { headers: { authorization: "Bearer " + TOKEN } }), env)).status, 200);
});

// ---- parameter registry API ----
const recommendation = (name: string) => ({ challenger: { name }, promotion: { decision: "RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL", reasons: [], autoApplied: false }, oosChallenger: { meanR: 0.3, trades: 40, bootstrap: { low95: 0.1 }, report: { maxDrawdownPct: 3 } }, oosChampion: {}, folds: [], caveats: [] });
test("params API: auth required, defaults to the built-in champion, no live/risk fields", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "/api/paper/params", "GET", undefined, null)).status, 401);
  const g = await json(await call(env, "/api/paper/params"));
  assert.equal(g.champion.name, "default"); assert.equal(g.champion.approvedBy, "system-default");
  assert.equal((await call(env, "/api/paper/params", "POST", {})).status, 405);
});
test("params API: propose resolves candidates server-side; promotion needs a named human; rollback restores", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "/api/paper/params/propose", "POST", { name: "evil", result: recommendation("evil") })).status, 400);
  assert.equal((await call(env, "/api/paper/params/propose", "POST", { name: "default", result: recommendation("default") })).status, 400);
  assert.equal((await call(env, "/api/paper/params/propose", "POST", { name: "tight_rr2", result: recommendation("other") })).status, 400);
  const bad = await call(env, "/api/paper/params/propose", "POST", { name: "tight_rr2", result: { ...recommendation("tight_rr2"), promotion: { decision: "KEEP_CHAMPION", reasons: [], autoApplied: false } } });
  assert.equal(bad.status, 409);
  const p = await json(await call(env, "/api/paper/params/propose", "POST", { name: "tight_rr2", result: recommendation("tight_rr2") }));
  assert.deepEqual(p.proposed.tighten, { minRiskReward: 2 }); assert.equal(p.champion.name, "default");
  for (const who of [undefined, "", "claude", "AI"]) assert.equal((await call(env, "/api/paper/params/promote", "POST", { id: p.proposed.id, approver: who })).status, 409);
  assert.equal((await call(env, "/api/paper/params/promote", "POST", { id: "x", approver: "Kyle" })).status, 400);
  const pr = await json(await call(env, "/api/paper/params/promote", "POST", { id: p.proposed.id, approver: "Kyle" })); assert.equal(pr.champion.name, "tight_rr2");
  const rb = await json(await call(env, "/api/paper/params/rollback", "POST", { reason: "test" })); assert.equal(rb.champion.name, "default");
  assert.equal((await call(mkEnv(), "/api/paper/params/rollback", "POST", {})).status, 409); // nothing approved to return to
});
test("evaluate uses the champion parameters and reports their version; an unreadable registry fails closed", async () => {
  const env = mkEnv(); let b = await json(await call(env, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT" })); assert.deepEqual(b.parameters, { version: 1, name: "default" });
  const p = await json(await call(env, "/api/paper/params/propose", "POST", { name: "tight_rr2_5", result: recommendation("tight_rr2_5") }));
  await call(env, "/api/paper/params/promote", "POST", { id: p.proposed.id, approver: "Kyle" });
  b = await json(await call(env, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT" })); assert.equal(b.parameters.name, "tight_rr2_5");
  const broken = mkEnv(); const kv = broken.ETI_EXECUTION_LOG as any, realGet = kv.get; kv.get = async (k: string) => { if (k === "algo:params:v1") throw new Error("kv down"); return realGet(k); };
  const r = await call(broken, "/api/paper/evaluate", "POST", { symbol: "BTCUSDT", execute: true }); assert.equal(r.status, 503); assert.equal((await json(r)).error, "params_unavailable");
});
