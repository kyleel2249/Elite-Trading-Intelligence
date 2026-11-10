import test from "node:test";
import assert from "node:assert/strict";
import { executionBase, handleTestnetExecute, sizeFor } from "./algo/testnet-api.ts";
import { series } from "./algo/fixtures.ts";

const TOKEN = "t".repeat(40), NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const MS: Record<string, number> = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
const mk = (drift: number) => { const px = series(300, { drift, noise: 0.35, seed: 7, stepMs: 900000, end: 0 }).at(-1)![4]; return { drift, px }; };
function world(drift = 0.25, acct: any = { environment: "paper", halted: false }, signal: { status: number; body: any } = { status: 200, body: { status: "filled", protective: [{}, {}, {}] } }, reach = true) {
  const { px } = mk(drift), calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const u = new URL(String(input)); calls.push({ url: String(input), init });
    if (u.host === "api.test") {
      if (!reach) throw new TypeError("refused");
      if (u.pathname.startsWith("/api/execution/accounts/")) return new Response(JSON.stringify(acct), { status: acct ? 200 : 404 });
      if (u.pathname === "/api/execution/signals") return new Response(JSON.stringify(signal.body), { status: signal.status });
    }
    if (u.pathname.includes("klines")) { const st = MS[u.searchParams.get("interval") || "1h"]; return new Response(JSON.stringify(series(300, { drift, noise: 0.35, seed: 7, stepMs: st, end: NOW - st * 0.5 }).map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), 0, "0", 1, "0", "0", "0"]))); }
    if (u.pathname.includes("depth")) return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 50 }, (_, i) => [String(px - 0.01 - i * 0.01), "50"]), asks: Array.from({ length: 50 }, (_, i) => [String(px + 0.01 + i * 0.01), "50"]) }));
    return new Response("x", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, list: async () => ({ keys: [] }) }; };
const envOf = (o: any = {}) => ({ ETI_EXECUTION_TOKEN: TOKEN, ETI_RISK_GATE_URL: "https://api.test/api/risk-gateway/preflight", ETI_RISK_GATE_TOKEN: "gate", ETI_EXECUTION_LOG: kv(), ETI_ROUND_TRIP_COST_BPS: "0", ...o }) as any;
const req = (body: unknown, o: { token?: string | null; method?: string } = {}) => new Request("https://eti.test/api/omnisignal/execute", { method: o.method ?? "POST", headers: { "content-type": "application/json", ...(o.token === null ? {} : { authorization: "Bearer " + (o.token ?? TOKEN) }) }, body: body === undefined || (o.method ?? "POST") === "GET" ? undefined : JSON.stringify(body) });
const good = { symbol: "BTCUSDT", strategy: "intraday", accountId: "acct1", riskUsd: 50, maxNotionalUsd: 5000 };
const realFetch = globalThis.fetch; test.afterEach(() => { globalThis.fetch = realFetch; });
const run = (r: Request, env: any, w: ReturnType<typeof world>) => { globalThis.fetch = w.fetchImpl; return handleTestnetExecute(r, env, { fetchImpl: w.fetchImpl, now: () => NOW }); };
const j = async (r: Response) => r.json() as Promise<any>;

test("sizeFor: smaller of risk-based and notional-capped, zero on bad input", () => {
  assert.equal(sizeFor(100, 99, 50, 1e9), 50); assert.equal(sizeFor(100, 99, 50, 1000), 10);
  for (const [e, s, r, n] of [[100, 101, 50, 1000], [0, -1, 50, 1000], [100, 99, 0, 1000], [100, 99, 50, 0], [NaN, 1, 1, 1]]) assert.equal(sizeFor(e, s, r, n), 0);
});
test("executionBase derives the Python origin", () => {
  assert.equal(executionBase({ ETI_RISK_GATE_URL: "https://api.test/api/risk-gateway/preflight" } as any), "https://api.test");
  assert.equal(executionBase({ ETI_EXECUTION_API_URL: "https://x.test/y", ETI_RISK_GATE_URL: "https://api.test/z" } as any), "https://x.test");
  assert.equal(executionBase({} as any), null);
});
test("guards: auth, method, kill switch, bad input, missing config", async () => {
  const w = world();
  assert.equal((await run(req(good, { token: null }), envOf(), w)).status, 401);
  assert.equal((await run(req(good, { token: "x".repeat(40) }), envOf(), w)).status, 401);
  assert.equal((await run(req(good, { method: "GET" }), envOf(), w)).status, 405);
  assert.equal((await run(req(good), envOf({ ETI_KILL_SWITCH: "true" }), w)).status, 423);
  for (const bad of [undefined, { ...good, symbol: "x" }, { ...good, strategy: "bogus" }, { ...good, accountId: "a b" }, { ...good, riskUsd: 0 }, { ...good, maxNotionalUsd: -1 }, { ...good, riskUsd: "5" }]) assert.equal((await run(req(bad), envOf(), w)).status, 400);
  assert.equal((await run(req(good), envOf({ ETI_RISK_GATE_URL: undefined, ETI_RISK_GATE_TOKEN: undefined }), w)).status, 503);
  assert.equal(w.calls.filter(c => c.url.includes("/signals")).length, 0);
});
test("live accounts, halted accounts and unreachable API never reach order submission", async () => {
  let w = world(0.25, { environment: "live", halted: false }); let r = await run(req(good), envOf(), w);
  assert.equal(r.status, 403); assert.equal((await j(r)).error, "live_accounts_not_supported_here");
  w = world(0.25, { environment: "paper", halted: true, halted_reason: "Unprotected position" }); r = await run(req(good), envOf(), w); assert.equal(r.status, 409);
  w = world(0.25, null as any); r = await run(req(good), envOf(), w); assert.equal(r.status, 404);
  w = world(0.25, undefined, undefined, false); r = await run(req(good), envOf(), w); assert.equal(r.status, 503);
  for (const x of [w]) assert.equal(x.calls.filter(c => c.url.includes("/signals")).length, 0);
});
test("a BUY plan is sized, carries stop and 40/30/30 targets, and is submitted idempotently", async () => {
  const w = world(); const r = await run(req(good), envOf(), w), b = await j(r);
  assert.equal(r.status, 200, JSON.stringify(b).slice(0, 300));
  assert.equal(b.decision, "BUY", "fixture should yield an actionable plan");
  assert.equal(b.submitted, true);
  const sent = w.calls.find(c => c.url.endsWith("/api/execution/signals"))!, body = JSON.parse(String(sent.init!.body)), hdr = new Headers(sent.init!.headers);
  assert.equal(hdr.get("x-api-key"), "gate"); assert.equal(body.side, "buy"); assert.equal(body.order_type, "limit"); assert.equal(body.account_id, "acct1");
  assert.ok(body.stop_loss > 0 && body.stop_loss < body.limit_price);
  assert.deepEqual(body.take_profits.map((t: any) => t.fraction), [0.4, 0.3, 0.3]);
  assert.ok(body.take_profits[0].price > body.limit_price && body.take_profits[0].price < body.take_profits[2].price);
  assert.ok(body.qty * body.limit_price <= 5000 + 1e-6, "notional cap respected"); assert.ok(body.qty * (body.limit_price - body.stop_loss) <= 50 * 1.01, "risk cap respected");
  assert.match(body.signal_id, /^omni-BTCUSDT-intraday-/); assert.match(body.thesis, /uncalibrated/);
  assert.equal(b.calibration.status, "uncalibrated");
});
test("non-BUY decisions and spot-short plans are never submitted", async () => {
  const w = world(-0.25); const r = await run(req(good), envOf(), w), b = await j(r);
  assert.equal(b.submitted, false); assert.equal(w.calls.filter(c => c.url.includes("/signals")).length, 0);
});
test("an engine failure or unreachable engine is reported, never claimed as success", async () => {
  let w = world(0.25, undefined, { status: 500, body: { detail: "boom" } }); let r = await run(req(good), envOf(), w); let b = await j(r);
  if (b.decision === "BUY") { assert.equal(r.status, 502); assert.equal(b.submitted, false); }
  w = world(); const flaky = async (i: any, init?: any) => { if (String(i).endsWith("/signals")) throw new TypeError("net"); return w.fetchImpl(i, init); };
  globalThis.fetch = w.fetchImpl; r = await handleTestnetExecute(req(good), envOf(), { fetchImpl: flaky as any, now: () => NOW }); b = await j(r);
  if (b.decision === "BUY") { assert.equal(r.status, 502); assert.match(b.message, /outcome is unknown/); assert.ok(b.signalId); }
});
