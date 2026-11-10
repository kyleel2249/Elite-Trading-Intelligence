import test from "node:test";
import assert from "node:assert/strict";
import { evaluateInvalidation, handleManage, nextConfirmation, CONFIRMATION_WINDOW_MS, type Holding } from "./algo/manage.ts";
import { runOmnisignal } from "./algo/omnisignal.ts";
import { series } from "./algo/fixtures.ts";
import { TF_SECONDS, TIMEFRAMES } from "./algo/timeframes.ts";

const TOKEN = "t".repeat(40), NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const MS: Record<string, number> = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
const H: Holding = { symbol: "BTCUSDT", qty: 1, entryPrice: 100 };
const candlesFor = (drift: number) => Object.fromEntries(TIMEFRAMES.map(tf => [tf, series(300, { drift, noise: 0.35, seed: 7, stepMs: TF_SECONDS[tf] * 1000, end: NOW - TF_SECONDS[tf] * 500, vol: 100 })])) as any;
const planFor = (drift: number) => runOmnisignal({ symbol: "BTCUSDT", strategy: "intraday", candles: candlesFor(drift), now: NOW }, { roundTripCostBps: 0 });

function world(o: { drift?: number; positions?: any[]; acct?: any; closeStatus?: number; closeBody?: any; klinesFail?: boolean } = {}) {
  const drift = o.drift ?? -0.25, px = series(300, { drift, noise: 0.35, seed: 7, stepMs: 900000, end: 0 }).at(-1)![4], calls: { url: string; method: string; body?: string }[] = [];
  const positions = o.positions ?? [{ symbol: "BTCUSDT", qty: 1, entry_price: 100, protective_orders: 6 }];
  const fetchImpl = (async (input: any, init?: any) => {
    const u = new URL(String(input)); calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
    if (u.host === "api.test") {
      if (u.pathname.endsWith("/managed-positions")) return new Response(JSON.stringify({ positions }), { status: 200 });
      if (u.pathname.endsWith("/close")) return new Response(JSON.stringify(o.closeBody ?? { status: "closed" }), { status: o.closeStatus ?? 200 });
      if (u.pathname.startsWith("/api/execution/accounts/")) return new Response(JSON.stringify(o.acct ?? { environment: "paper", halted: false }), { status: 200 });
    }
    if (u.pathname.includes("klines")) { if (o.klinesFail) return new Response("x", { status: 500 }); const st = MS[u.searchParams.get("interval") || "1h"]; return new Response(JSON.stringify(series(300, { drift, noise: 0.35, seed: 7, stepMs: st, end: NOW - st * 0.5, vol: 100 }).map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), 0, "0", 1, "0", "0", "0"]))); }
    if (u.pathname.includes("depth")) return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 50 }, (_, i) => [String(px - 0.01 - i * 0.01), "50"]), asks: Array.from({ length: 50 }, (_, i) => [String(px + 0.01 + i * 0.01), "50"]) }));
    return new Response("x", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls, closes: () => calls.filter(c => c.url.endsWith("/close")) };
}
const kv = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, list: async () => ({ keys: [] }) }; };
const envOf = (store = kv(), o: any = {}) => ({ ETI_EXECUTION_TOKEN: TOKEN, ETI_RISK_GATE_URL: "https://api.test/api/risk-gateway/preflight", ETI_RISK_GATE_TOKEN: "gate", ETI_EXECUTION_LOG: store, ETI_ROUND_TRIP_COST_BPS: "0", ...o });
const req = (body: unknown, o: { token?: string | null; method?: string } = {}) => new Request("https://eti.test/api/omnisignal/manage", { method: o.method ?? "POST", headers: { "content-type": "application/json", ...(o.token === null ? {} : { authorization: "Bearer " + (o.token ?? TOKEN) }) }, body: o.method === "GET" ? undefined : JSON.stringify(body) });
const realFetch = globalThis.fetch; test.afterEach(() => { globalThis.fetch = realFetch; });
const run = (r: Request, env: any, w: ReturnType<typeof world>, now = NOW) => { globalThis.fetch = w.fetchImpl; return handleManage(r, env, { fetchImpl: w.fetchImpl, now: () => now }); };
const j = async (r: Response) => r.json() as Promise<any>;

test("evaluateInvalidation: unreliable data is never an invalidation", () => {
  const p = { ...planFor(-0.25), decision: "DATA_UNRELIABLE" as const }; const v = evaluateInvalidation(p, H);
  assert.equal(v.evaluable, false); assert.equal(v.invalidated, false);
});
test("evaluateInvalidation: a bullish market leaves the thesis intact; a confirmed SELL invalidates", () => {
  const up = planFor(0.25), dn = planFor(-0.25);
  assert.equal(evaluateInvalidation(up, H).invalidated, false);
  assert.equal(dn.decision, "SELL"); const v = evaluateInvalidation(dn, H); assert.equal(v.invalidated, true); assert.match(v.reasons.join(" "), /SELL/);
});
test("evaluateInvalidation: blocked and deteriorating liquidity invalidates, healthy or merely degraded does not", () => {
  const base = planFor(0.25), mk = (status: string, det: boolean) => ({ ...base, decision: "HOLD" as const, liquidity: { ...(base.liquidity ?? {}), status, deteriorating: det } as any });
  assert.equal(evaluateInvalidation(mk("blocked", true), H).invalidated, true);
  assert.equal(evaluateInvalidation(mk("blocked", false), H).invalidated, false);
  assert.equal(evaluateInvalidation(mk("degraded", true), H).invalidated, false);
});
test("nextConfirmation: needs consecutive readings, resets on clear, ignores unreliable data, expires when stale", () => {
  const bad = { invalidated: true, evaluable: true, reasons: ["r"], note: "" }, ok = { invalidated: false, evaluable: true, reasons: [], note: "" }, unk = { invalidated: false, evaluable: false, reasons: [], note: "" };
  let s = nextConfirmation(null, bad, 1000); assert.equal(s.count, 1);
  s = nextConfirmation(s, bad, 2000); assert.equal(s.count, 2);
  assert.equal(nextConfirmation(s, unk, 3000).count, 2);                        // unreliable data neither confirms nor clears
  assert.equal(nextConfirmation(s, ok, 3000).count, 0);                         // cleared
  assert.equal(nextConfirmation(s, bad, 2000 + CONFIRMATION_WINDOW_MS + 1).count, 1);   // too old to count as consecutive
});

test("guards: auth, method, input, live accounts", async () => {
  const w = world();
  assert.equal((await run(req({ accountId: "a" }, { token: null }), envOf(), w)).status, 401);
  assert.equal((await run(req({ accountId: "a" }, { method: "GET" }), envOf(), w)).status, 405);
  for (const bad of [undefined, { accountId: "a b" }, { accountId: "a", strategy: "x" }, { accountId: "a", close: "yes" }]) assert.equal((await run(req(bad), envOf(), w)).status, 400);
  const live = world({ acct: { environment: "live" } }); assert.equal((await run(req({ accountId: "a", close: true }), envOf(), live)).status, 403); assert.equal(live.closes().length, 0);
});
test("a bearish market: first reading is only counted, the second confirms and closes through the engine", async () => {
  const w = world(), store = kv(), env = envOf(store);
  let b = await j(await run(req({ accountId: "acct1", close: true }), env, w));
  assert.equal(b.outcomes[0].invalidated, true); assert.equal(b.outcomes[0].confirmations, 1); assert.equal(b.outcomes[0].action, "none"); assert.equal(w.closes().length, 0);
  b = await j(await run(req({ accountId: "acct1", close: true }), env, w, NOW + 900_000));
  assert.equal(b.outcomes[0].action, "close_requested"); assert.equal(w.closes().length, 1);
  const sent = JSON.parse(w.closes()[0].body!); assert.match(sent.reason, /consecutive evaluations/); assert.equal(w.closes()[0].method, "POST");
  assert.equal(b.opensPositions, false); assert.equal(b.increasesExposure, false);
  assert.ok(!w.calls.some(c => c.url.includes("/signals")), "management never submits a new order");
  b = await j(await run(req({ accountId: "acct1", close: true }), env, w, NOW + 1_800_000)); assert.equal(b.outcomes[0].confirmations, 1, "counter restarted after the close request");
});
test("without close:true the invalidation is reported but nothing is closed", async () => {
  const w = world(), env = envOf();
  await run(req({ accountId: "acct1" }), env, w); const b = await j(await run(req({ accountId: "acct1" }), env, w, NOW + 900_000));
  assert.equal(b.outcomes[0].action, "report_only"); assert.equal(b.closeEnabled, false); assert.equal(w.closes().length, 0);
});
test("a bullish market is left alone, and unreliable data takes no action", async () => {
  let w = world({ drift: 0.25 }), b = await j(await run(req({ accountId: "a", close: true }), envOf(), w));
  assert.equal(b.outcomes[0].invalidated, false); assert.equal(w.closes().length, 0);
  w = world({ klinesFail: true }); b = await j(await run(req({ accountId: "a", close: true }), envOf(), w));
  assert.equal(b.outcomes[0].evaluable, false); assert.equal(b.outcomes[0].action, "none"); assert.equal(w.closes().length, 0);
});
test("a failed close is reported as failed, never as success", async () => {
  const w = world({ closeStatus: 200, closeBody: { status: "failed_unprotected_halted", error: "x" } }), env = envOf();
  await run(req({ accountId: "a", close: true }), env, w); const b = await j(await run(req({ accountId: "a", close: true }), env, w, NOW + 900_000));
  assert.equal(b.outcomes[0].action, "close_failed");
});
test("no managed positions means nothing is evaluated; the per-run budget is enforced", async () => {
  let w = world({ positions: [] }), b = await j(await run(req({ accountId: "a" }), envOf(), w)); assert.equal(b.evaluated, 0);
  const many = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"].map(s => ({ symbol: s, qty: 1, entry_price: 1 }));
  w = world({ positions: many }); b = await j(await run(req({ accountId: "a" }), envOf(), w)); assert.equal(b.evaluated, 3); assert.equal(b.skippedForBudget, 2);
});
