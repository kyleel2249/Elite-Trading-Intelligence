import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAPER_CONFIG, type PaperState } from "../algo/paper.ts";
import { series } from "../algo/fixtures.ts";
import { evaluatePaperAccount, paperAccountRisk } from "./account.ts";
import { handlePrecision } from "./api.ts";
import { depthAround } from "./testkit.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const cfg = DEFAULT_PAPER_CONFIG;
const state = (o: Partial<PaperState> = {}): PaperState => ({ equity: 10_000, positions: [], closed: [], orderIds: [], lastStopOut: {}, killSwitch: false, dayKey: "2026-11-10", dayStartEquity: 10_000, version: 1, ...o });
const pos = (symbol: string) => ({ symbol } as any);
const loss = (closedAt: number) => ({ pnl: -10, closedAt } as any);

test("a clean paper account is within limits", () => {
  assert.deepEqual(evaluatePaperAccount(state(), cfg, "BTCUSDT", NOW), { withinLimits: true, reasons: [] });
});

test("each paper entry limit is reported with its reason", () => {
  const reasons = (s: PaperState, sym = "BTCUSDT") => evaluatePaperAccount(s, cfg, sym, NOW);
  assert.match(reasons(state({ killSwitch: true })).reasons[0], /Kill switch/);
  assert.match(reasons(state({ positions: [pos("BTCUSDT")] })).reasons.join(), /already open on BTCUSDT/);
  assert.equal(reasons(state({ positions: [pos("ETHUSDT")] })).withinLimits, true);
  assert.match(reasons(state({ positions: [pos("A"), pos("B"), pos("C")] }), "ETHUSDT").reasons[0], /Open-position cap reached \(3\/3\)/);
  assert.match(reasons(state({ equity: 9_650 })).reasons[0], /Daily loss limit reached \(-3\.50%/);
  assert.equal(reasons(state({ equity: 9_800 })).withinLimits, true);
  assert.equal(reasons(state({ equity: 9_000, dayKey: "2026-11-09" })).withinLimits, true, "a previous day's baseline does not count");
  const streak = [1, 2, 3, 4].map(i => loss(NOW - i * 3_600_000));
  assert.match(reasons(state({ closed: streak })).reasons[0], /4 consecutive losses/);
  assert.equal(reasons(state({ closed: [loss(NOW - 3 * 86_400_000), loss(NOW - 3 * 86_400_000), loss(NOW - 3 * 86_400_000), loss(NOW - 3 * 86_400_000)] })).withinLimits, true, "pause has elapsed");
  assert.match(reasons(state({ lastStopOut: { BTCUSDT: NOW - 600_000 } })).reasons[0], /cooldown/);
  assert.equal(reasons(state({ lastStopOut: { BTCUSDT: NOW - 600_000 } }), "ETHUSDT").withinLimits, true);
});

function kvWith(value: unknown) { const data = new Map<string, string>(); if (value !== undefined) data.set("eti:paper:state", typeof value === "string" ? value : JSON.stringify(value)); return { async get(k: string) { return data.get(k) ?? null; }, async put(k: string, v: string) { data.set(k, v); } }; }

test("no stored account, unreadable state or no KV leave the gate unevaluated (null), never 'within limits'", async () => {
  assert.equal(await paperAccountRisk({}, "BTCUSDT", NOW), null);
  assert.equal(await paperAccountRisk({ ETI_EXECUTION_LOG: kvWith(undefined) } as any, "BTCUSDT", NOW), null);
  assert.equal(await paperAccountRisk({ ETI_EXECUTION_LOG: kvWith("{not json") } as any, "BTCUSDT", NOW), null);
  assert.equal(await paperAccountRisk({ ETI_EXECUTION_LOG: kvWith({ equity: "x" }) } as any, "BTCUSDT", NOW), null);
  assert.equal((await paperAccountRisk({ ETI_EXECUTION_LOG: kvWith(state({ killSwitch: true })) } as any, "BTCUSDT", NOW))!.withinLimits, false);
});

// ---- API: account=paper
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const STEP: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
function mockExchange() {
  const px = series(260, { drift: 1, noise: 2, seed: 1, start: 100, end: Date.now() }).at(-1)![4];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.includes("depth")) { const d = depthAround(px, Date.now()); return new Response(JSON.stringify({ lastUpdateId: 1, bids: d.bids.map(([p, q]) => [String(p), String(q)]), asks: d.asks.map(([p, q]) => [String(p), String(q)]) }), { status: 200 }); }
    const step = (STEP[u.searchParams.get("interval") || "1h"] || 3600) * 1000;
    return new Response(JSON.stringify(series(260, { drift: 1, noise: 2, seed: 1, start: 100, stepMs: step, end: Date.now() }).map(r => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5])])), { status: 200 });
  }) as typeof fetch;
}
const TOKEN = "a-sufficiently-long-admin-token-123";
const call = (qs: string, env: any, headers: Record<string, string> = {}) => handlePrecision(new Request("https://eti.test/api/precision/signal?symbol=BTCUSDT&strategy=intraday" + qs, { headers }), env);
const gate = (body: any) => body.riskChecks.find((g: any) => g.id === "account_risk");

test("account=paper needs the admin token; unsupported accounts are rejected", async () => {
  mockExchange();
  assert.equal((await call("&account=live", {})).status, 400);
  assert.equal((await call("&account=paper", {})).status, 403);
  assert.equal((await call("&account=paper", { ETI_PRECISION_ADMIN_TOKEN: TOKEN })).status, 401);
  assert.equal((await call("&account=paper", { ETI_PRECISION_ADMIN_TOKEN: TOKEN }, { authorization: "Bearer wrong-token-wrong-token-1" })).status, 401);
});

test("without the parameter the account gate stays not_evaluated; with it the paper account decides", async () => {
  mockExchange();
  const plain: any = await (await call("", { ETI_PRECISION_ADMIN_TOKEN: TOKEN })).json();
  assert.equal(gate(plain).status, "not_evaluated");
  const auth = { authorization: `Bearer ${TOKEN}` };
  const ok: any = await (await call("&account=paper", { ETI_PRECISION_ADMIN_TOKEN: TOKEN, ETI_EXECUTION_LOG: kvWith(state({ dayKey: new Date().toISOString().slice(0, 10) })) }, auth)).json();
  assert.equal(gate(ok).status, "pass");
  const halted: any = await (await call("&account=paper", { ETI_PRECISION_ADMIN_TOKEN: TOKEN, ETI_EXECUTION_LOG: kvWith(state({ killSwitch: true })) }, auth)).json();
  assert.equal(gate(halted).status, "fail"); assert.match(gate(halted).detail, /Kill switch/);
  assert.equal(halted.direction, "NO TRADE", "a failed account gate forces NO TRADE regardless of score");
  const none: any = await (await call("&account=paper", { ETI_PRECISION_ADMIN_TOKEN: TOKEN }, auth)).json();
  assert.equal(gate(none).status, "not_evaluated", "no stored account: not evaluated, never a pass");
});
