import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CYCLE_SYMBOLS, cycleConfig, handlePaper, runPaperCycle, type PaperEnv } from "./algo/paper-api.ts";
import main from "./main.ts";
import { series } from "./algo/fixtures.ts";

const TOKEN = "t".repeat(40), NOW = Date.UTC(2026, 10, 9, 12, 0, 0), PX = series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: 900000, end: 0 }).at(-1)![4];
const MS: Record<string, number> = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
const kvStore = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, list: async (o: { prefix: string; limit?: number }) => ({ keys: [...m.keys()].filter(k => k.startsWith(o.prefix)).sort().slice(0, o.limit ?? 1000).map(name => ({ name })) }) }; };
const world = { clock: NOW, failSymbols: new Set<string>(), minuteOverride: null as null | ((s: string) => unknown[][] | null), gate: "approve" as "approve" | "down", gateCalls: 0, fetched: [] as string[] };
const fetchImpl = (async (input: any, init?: any) => {
  const u = new URL(String(input));
  if (u.host === "gate.test") { world.gateCalls++; if (world.gate === "down") throw new TypeError("refused"); return new Response(JSON.stringify({ approved: true, reasons: [] })); }
  if (u.host !== "data-api.binance.vision") return new Response("x", { status: 500 });
  const sym = u.searchParams.get("symbol") || ""; world.fetched.push(sym);
  if (world.failSymbols.has(sym)) return new Response("down", { status: 500 });
  if (u.pathname.includes("klines")) {
    const iv = u.searchParams.get("interval")!, ov = iv === "1m" ? world.minuteOverride?.(sym) : null; if (ov) return new Response(JSON.stringify(ov));
    const step = MS[iv]; return new Response(JSON.stringify(series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: step, end: world.clock - step * 0.5 }).map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), 0, "0", 1, "0", "0", "0"])));
  }
  if (u.pathname.includes("depth")) return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 50 }, (_, i) => [String(PX - 0.01 - i * 0.01), "50"]), asks: Array.from({ length: 50 }, (_, i) => [String(PX + 0.01 + i * 0.01), "50"]) }));
  return new Response("x", { status: 500 });
}) as typeof fetch;
const realFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = fetchImpl; Object.assign(world, { clock: NOW, minuteOverride: null, gate: "approve", gateCalls: 0, fetched: [] }); world.failSymbols = new Set(); });
test.afterEach(() => { globalThis.fetch = realFetch; });
const mkEnv = (o: Partial<PaperEnv> = {}) => { const kv = kvStore(); return { ETI_EXECUTION_TOKEN: TOKEN, ETI_EXECUTION_LOG: kv as any, ETI_RISK_GATE_URL: "https://gate.test/p", ETI_RISK_GATE_TOKEN: "k", ETI_ROUND_TRIP_COST_BPS: "0", ...o, kv } as PaperEnv & { kv: ReturnType<typeof kvStore> }; };
const cycle = (env: PaperEnv) => runPaperCycle(env, { now: () => world.clock, fetchImpl });
const status = async (env: PaperEnv) => (await handlePaper(new Request("https://e/api/paper/status", { headers: { authorization: "Bearer " + TOKEN } }), env, { now: () => world.clock, fetchImpl })).json() as Promise<any>;

test("config: symbols are validated, de-duplicated and capped to the subrequest budget", () => {
  const c = cycleConfig({ ETI_PAPER_SYMBOLS: "btcusdt, ETHUSDT,bad!,BTCUSDT,SOLUSDT,XRPUSDT,ADAUSDT", ETI_PAPER_STRATEGY: "swing" } as PaperEnv);
  assert.deepEqual(c.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]); assert.equal(c.symbols.length, MAX_CYCLE_SYMBOLS); assert.equal(c.strategy, "swing"); assert.equal(c.autoExecute, false);
  assert.deepEqual(c.ignored.sort(), ["ADAUSDT", "XRPUSDT", "bad!".toUpperCase()].sort());
  assert.equal(cycleConfig({ ETI_PAPER_STRATEGY: "yolo" } as PaperEnv).strategy, "intraday"); assert.equal(cycleConfig({ ETI_PAPER_AUTOEXECUTE: "yes" } as PaperEnv).autoExecute, false, "only the exact string 'true' enables execution");
});
test("disabled by default: no symbols and no positions means no market or gateway calls", async () => {
  const s = await cycle(mkEnv()); assert.equal(s.ran, false); assert.match(s.reason!, /ETI_PAPER_SYMBOLS/); assert.equal(world.fetched.length, 0); assert.equal(world.gateCalls, 0);
  assert.equal((await cycle(mkEnv({ ETI_EXECUTION_LOG: undefined, ETI_PAPER_SYMBOLS: "BTCUSDT" }))).ran, false);
});
test("analyse-only unless ETI_PAPER_AUTOEXECUTE=true: it evaluates but never opens or asks the gateway", async () => {
  const env = mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT" }), s = await cycle(env);
  assert.equal(s.ran, true); assert.equal(s.items[0].action, "evaluate"); assert.equal(s.items[0].decision, "BUY"); assert.equal(s.items[0].event, undefined); assert.equal(world.gateCalls, 0); assert.equal(s.openPositions, 0);
});
test("with auto-execute it opens through the gateway, and the next run manages the position instead of stacking", async () => {
  const env = mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT", ETI_PAPER_AUTOEXECUTE: "true" }), a = await cycle(env);
  assert.equal(a.items[0].event, "OPENED"); assert.equal(world.gateCalls, 1); assert.equal(a.openPositions, 1);
  const p0 = (await status(env)).openPositions[0], t0 = Math.ceil(p0.openedAt / 60000) * 60000;
  world.clock += 5 * 60000; world.minuteOverride = () => [0, 1, 2].map(i => [t0 + i * 60000, String(PX), String(PX + 0.05), String(PX - 0.05), String(PX), "1", 0, "0", 1, "0", "0", "0"]); // quiet market: nothing hits stop or target
  const b = await cycle(env); assert.equal(b.items[0].action, "tick"); assert.equal(world.gateCalls, 1, "no second order"); assert.equal(b.openPositions, 1);
  const st = await status(env); assert.equal(st.scheduler.lastRun.at, new Date(world.clock).toISOString()); assert.equal(st.scheduler.autoExecute, true);
});
test("a gateway outage blocks the order but the cycle completes and records why", async () => {
  world.gate = "down"; const s = await cycle(mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT", ETI_PAPER_AUTOEXECUTE: "true" }));
  assert.equal(s.items[0].event, "REJECTED"); assert.match(s.items[0].reasons!.join(" "), /unreachable/); assert.equal(s.openPositions, 0);
});
test("kill switch stops new entries but open positions are still managed (stops keep working)", async () => {
  const env = mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT", ETI_PAPER_AUTOEXECUTE: "true" }); await cycle(env);
  const pos = (await status(env)).openPositions[0], t0 = Math.ceil(pos.openedAt / 60000) * 60000;
  world.clock = t0 + 6 * 60000; world.minuteOverride = () => [[t0 + 60000, String(PX), String(PX + 0.1), String(pos.stop - 1), String(pos.stop), "1", 0, "0", 1, "0", "0", "0"]];
  const killed = await cycle({ ...env, ETI_KILL_SWITCH: "true" } as PaperEnv);
  assert.equal(killed.killSwitch, true); assert.equal(killed.items[0].action, "tick"); assert.deepEqual(killed.items[0].events, ["STOP", "CLOSED"]); assert.equal(killed.openPositions, 0);
  const after = await cycle({ ...env, ETI_KILL_SWITCH: "true" } as PaperEnv); assert.equal(after.items[0].event, "SKIPPED"); assert.match(after.items[0].reasons![0], /Kill switch/); assert.equal(world.gateCalls, 1, "gateway not asked while killed");
});
test("open positions are managed even when their symbol is no longer configured", async () => {
  const env = mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT", ETI_PAPER_AUTOEXECUTE: "true" }); await cycle(env);
  const p0 = (await status(env)).openPositions[0], t0 = Math.ceil(p0.openedAt / 60000) * 60000;
  world.clock += 5 * 60000; world.minuteOverride = () => [[t0, String(PX), String(PX + 0.05), String(PX - 0.05), String(PX), "1", 0, "0", 1, "0", "0", "0"]];
  const s = await cycle({ ...env, ETI_PAPER_SYMBOLS: undefined } as PaperEnv);
  assert.equal(s.ran, true); assert.deepEqual(s.items.map(i => [i.symbol, i.action]), [["BTCUSDT", "tick"]]);
});
test("one symbol's data failure is isolated; the other symbols still run; total work is capped", async () => {
  world.failSymbols.add("ETHUSDT"); const s = await cycle(mkEnv({ ETI_PAPER_SYMBOLS: "ETHUSDT,BTCUSDT,SOLUSDT,XRPUSDT,ADAUSDT" }));
  assert.deepEqual(s.items.map(i => i.symbol), ["ETHUSDT", "BTCUSDT", "SOLUSDT"]); assert.ok(s.items[0].error); assert.equal(s.items[1].decision, "BUY"); assert.deepEqual(s.ignoredSymbols, ["XRPUSDT", "ADAUSDT"]);
  assert.ok(!world.fetched.includes("XRPUSDT") && !world.fetched.includes("ADAUSDT"));
});
test("the Worker entrypoint exposes fetch and a scheduled handler that runs the cycle", async () => {
  assert.equal(typeof (main as any).fetch, "function"); assert.equal(typeof (main as any).scheduled, "function");
  const env = mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT" }) as any; let waited: Promise<unknown> | null = null;
  await (main as any).scheduled({}, env, { waitUntil: (p: Promise<unknown>) => { waited = p; } }); await waited;
  assert.ok(env.kv.m.has("eti:paper:lastrun"), "scheduled run recorded its summary");
  assert.equal((await (main as any).fetch(new Request("https://e/api/paper/status"), env)).status, 401);
});
test("scheduled handler never throws into the runtime when the cycle fails", async () => {
  const env = mkEnv({ ETI_PAPER_SYMBOLS: "BTCUSDT" }) as any; env.ETI_EXECUTION_LOG = { get: async () => { throw new Error("kv down"); }, put: async () => {}, list: async () => ({ keys: [] }) };
  let waited: Promise<unknown> | null = null; await (main as any).scheduled({}, env, { waitUntil: (p: Promise<unknown>) => { waited = p; } });
  await assert.doesNotReject(async () => { await waited; });
});
