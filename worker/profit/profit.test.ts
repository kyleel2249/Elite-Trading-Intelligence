import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JournalStore } from "../journal/store.ts";
import type { NewEntry } from "../journal/store.ts";
import { buildTrades } from "../journal/analytics.ts";
import { sqliteD1 } from "../portfolio/testing.ts";
import { withProfit } from "./route.ts";
import { SCHEMA } from "./schema.ts";
import * as M from "./model.ts";
import * as E from "./engine.ts";
import { treasuryInternals as TI } from "../treasury/api.ts";

const T0 = Date.UTC(2026, 10, 10, 12), HOUR = 3_600_000, TOKEN = "master-token-value-0123456789";
const ent = (id: string, kind: string, tradeId: string, data: any, at: number, environment = "internal_paper"): NewEntry =>
  ({ id, at, kind: kind as any, tradeId, symbol: "BTCUSDT", environment, source: "eti_auto", actor: null, data } as any);
const closed = (id: string, net: number, at: number, extra: any = {}, environment = "internal_paper") =>
  ent("close:" + id, "trade_closed", id, { qty: 1, entryPrice: 100, exitPrice: 100 + net, gross: net, fees: 0, net, unknownFees: 0, result: net > 0 ? "win" : net < 0 ? "loss" : "breakeven", strategy: "intraday", holdingMs: 60_000, ...extra }, at, environment);
async function mk(entries: NewEntry[], extra: Record<string, unknown> = {}) {
  const db = sqliteD1(), store = new JournalStore(db); for (const x of entries) await store.append(x, x.at);
  E.resetForTests();
  return { db, env: { ETI_PORTFOLIO_DB: db, ETI_EXECUTION_TOKEN: TOKEN, ETI_PROFIT_SIM_CAPITAL_CENTS: "1000000", ...extra } as any };
}
const NOW = T0 + 5 * HOUR;

test("only realized, closed, fee-confirmed, confirmed trades are eligible; everything else is excluded with a reason", () => {
  const trades = buildTrades([
    closed("win", 50, T0) as any, closed("fresh", 20, NOW - 60_000) as any, closed("nofee", 9, T0, { unknownFees: 1 }) as any,
    ent("o1", "order_submitted", "open1", { outcome: "executed", side: "buy", quantity: 1, fillPrice: 100 }, T0) as any,
    ent("o2", "order_submitted", "rest1", { outcome: "resting", side: "buy", quantity: 1 }, T0) as any,
    ent("u1", "order_outcome_unknown", "unk1", { reasons: ["timeout"] }, T0) as any,
    closed("sp", 5, T0, {}, "sports_paper") as any, closed("lv", 7, T0, {}, "live") as any,
    ent("m1", "manual_trade", "man1", { side: "buy", quantity: 1, entryPrice: 1, exitPrice: 2, gross: 1, fees: 0, net: 1, status: "closed", result: "win" }, T0, "manual") as any,
  ].map((x: any, i) => ({ ...x, seq: i + 1, recordedAt: x.at, prev: null, hash: "h" + i, corrects: null })));
  const r = M.classifyTrades(trades, { environment: "simulated", now: NOW });
  assert.deepEqual(r.eligible.map(x => x.tradeId).sort(), ["win"]);
  const why = Object.fromEntries(r.excluded.map(x => [x.tradeId, x.reason]));
  assert.equal(why.fresh, "inside_confirmation_window"); assert.equal(why.nofee, "fees_unconfirmed");
  assert.equal(why.open1, "filled_not_closed_unrealized"); assert.equal(why.rest1, "order_resting_unconfirmed"); assert.equal(why.unk1, "broker_outcome_unknown");
  assert.equal(why.sp, "sports_tracked_separately"); assert.equal(why.lv, "other_environment"); assert.equal(why.man1, "manual_record_unverified");
});

test("testnet and internal paper map to simulated books; live maps to actual; unknown is excluded", () => {
  assert.equal(M.treasuryEnvOf("internal_paper"), "simulated"); assert.equal(M.treasuryEnvOf("exchange_testnet"), "simulated");
  assert.equal(M.treasuryEnvOf("live"), "actual"); assert.equal(M.treasuryEnvOf("manual"), "excluded"); assert.equal(M.treasuryEnvOf(null), "excluded");
});

test("a profitable cycle recognises net profit once, recognises exactly the realized net, keeps the ledger intact, and is idempotent", async () => {
  const { db, env } = await mk([closed("a", 120, T0), closed("b", -20, T0 + 1000), ent("o1", "order_submitted", "open1", { outcome: "executed", side: "buy", quantity: 1, fillPrice: 100 }, T0)]);
  const st0 = await E.profitState(env, "simulated", NOW);
  assert.equal(st0.pending.netCents, 10_000); assert.equal(st0.excludedByReason.filled_not_closed_unrealized, 1);
  const r1 = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  assert.equal(r1.ran, true); assert.equal(r1.blocked, undefined); assert.equal(r1.recognised!.reduce((s, x) => s + x.netCents, 0), 10_000);
  const bal = await TI.readBalances(db as any, "simulated");
  assert.equal(bal.tradingRevenue, 10_000, "revenue recognised equals net realized");
  assert.equal(bal.b.tradingCapital + bal.b.realizedProfits + bal.b.operatingFunds + bal.b.emergencyReserve + bal.b.longTermInvestments, 1_000_000 + 10_000);
  const r2 = await E.runProfitCycle(env, "simulated", NOW + 1, { force: true });
  assert.equal(r2.recognised!.length, 0, "already recognised trades are never posted twice");
  assert.equal((await TI.readBalances(db as any, "simulated")).tradingRevenue, 10_000);
  const v = await TI.verify(db as any, "simulated"); assert.equal((v as any).ok, true, "ledger hash chain intact");
});

test("a trade inside the confirmation window is not recognised until it ages", async () => {
  const { db, env } = await mk([closed("late", 80, NOW - 10 * 60_000)]);
  const r = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  assert.equal(r.recognised!.length, 0); assert.equal((await TI.readBalances(db as any, "simulated")).tradingRevenue, 0);
  const later = await E.runProfitCycle(env, "simulated", NOW + 2 * HOUR, { force: true });
  assert.equal(later.recognised!.reduce((s, x) => s + x.netCents, 0), 8000);
});

test("a net loss is charged to trading capital and recorded as unrecovered loss; actual books are never automatic", async () => {
  const { db, env } = await mk([closed("l", -300, T0)]);
  const r = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  assert.equal(r.recognised![0].netCents, -30_000);
  const b = await TI.readBalances(db as any, "simulated");
  assert.equal(b.b.tradingCapital, 1_000_000 - 30_000); assert.equal(b.unrecoveredLoss, 30_000); assert.equal(b.tradingLosses, 30_000);
  const a = await E.runProfitCycle(env, "actual", NOW, { force: true }); assert.equal(a.ran, false); assert.equal(a.skipped, "actual_books_are_never_automatic");
});

test("a loss that capital cannot absorb is blocked and nothing is posted", async () => {
  const { db, env } = await mk([closed("big", -500, T0)], { ETI_PROFIT_SIM_CAPITAL_CENTS: "0" });
  const r = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  assert.match(String(r.blocked), /capital/i);
  assert.equal((await TI.readBalances(db as any, "simulated")).tradingLosses, 0);
  const n = await (db as any).prepare("SELECT COUNT(*) AS n FROM profit_engine_trades").first(); assert.equal(n.n, 0);
});

test("the cycle is throttled and requires storage", async () => {
  const { env } = await mk([closed("t", 10, T0)]);
  assert.equal((await E.runProfitCycle(env, "simulated", NOW)).ran, true);
  assert.equal((await E.runProfitCycle(env, "simulated", NOW + 1000)).skipped, "throttled");
  assert.equal((await E.runProfitCycle({}, "simulated", NOW)).skipped, "storage_not_configured");
});

test("capital protection: a drawdown beyond the limit holds distributions", () => {
  const bal: any = { tradingCapital: 100_000, realizedProfits: 50_000, operatingFunds: 0, emergencyReserve: 0, longTermInvestments: 0, departmentBudgets: 0, liabilities: 0 };
  const hold = M.assessProtection({ policy: null, balances: bal, unrecoveredLoss: 0, recent: [{ closedAt: T0, netCents: 20_000 }, { closedAt: T0 + 1, netCents: -15_000 }], now: NOW, windowMs: 30 * 86_400_000, maxDrawdownBps: 1000 });
  assert.equal(hold.hold, true); assert.ok(hold.drawdownCents >= 15_000);
  const rec = M.recommend(null, bal, 0, 50_000, hold); assert.notEqual(rec.mode, "policy_waterfall");
});

test("expense forecast uses only paid expenses and reports runway", () => {
  const paid = [0, 1, 2].map(i => ({ paidAt: NOW - i * 31 * 86_400_000, cents: 100_000 }));
  const f = M.forecastExpenses(paid, NOW, 3, 600_000, 0, null);
  assert.equal(f.months.length, 3); assert.ok(f.monthlyAverageCents > 0); assert.ok(f.months.every(m => m.lowCents <= m.baseCents && m.baseCents <= m.highCents));
  assert.ok(f.runwayMonths !== null && f.runwayMonths > 0);
});

test("financial report: totals, markdown and CSV agree and exclude unrealized", async () => {
  const { env } = await mk([closed("a", 120, T0), closed("b", -20, T0 + 1000), ent("o1", "order_submitted", "open1", { outcome: "executed", side: "buy", quantity: 1, fillPrice: 100 }, T0)]);
  await E.runProfitCycle(env, "simulated", NOW, { force: true });
  const r = await E.financialReport(env, "simulated", "all", NOW);
  assert.equal(r.realized.netCents, 10_000); assert.equal(r.realized.trades, 2); assert.equal(r.excluded.filled_not_closed_unrealized, 1);
  assert.match(E.reportMarkdown(r), /SIMULATED/); assert.match(E.reportCsv(r), /realized,net_cents,10000/);
  await assert.rejects(E.financialReport(env, "simulated", "bogus", NOW), /invalid_period/);
});

test("API: needs sign-in, forbids unqualified users, serves status/report/forecast, runs the cycle, refuses actual", async () => {
  const { env } = await mk([closed("a", 120, T0)]);
  const app = withProfit({ fetch: async () => new Response("base") }), call = (p: string, init: RequestInit = {}, token = true) =>
    app.fetch(new Request("https://x.test" + p, { ...init, headers: { ...(token ? { authorization: "Bearer " + TOKEN } : {}), "content-type": "application/json" } }), env);
  assert.equal((await call("/api/profit/status", {}, false)).status, 401);
  const s = await call("/api/profit/status?environment=simulated"); assert.equal(s.status, 200); assert.equal(((await s.json()) as any).environment, "simulated");
  assert.equal((await call("/api/profit/status?environment=nope")).status, 400);
  assert.equal((await call("/api/profit/report?environment=simulated&period=all&format=csv")).headers.get("content-type")!.startsWith("text/csv"), true);
  assert.equal((await call("/api/profit/report?environment=simulated&period=zzz")).status, 400);
  assert.equal((await call("/api/profit/forecast?environment=simulated")).status, 200);
  const run = await call("/api/profit/run", { method: "POST", body: JSON.stringify({ environment: "simulated" }) }); assert.equal(run.status, 200);
  assert.equal((await call("/api/profit/run", { method: "POST", body: JSON.stringify({ environment: "actual" }) })).status, 409);
  const page = await call("/profit", {}, false); assert.equal(page.status, 200); assert.match(await page.text(), /Profit management/);
  assert.equal(await (await call("/other", {}, false)).text(), "base");
});

test("migration 0011 matches the embedded profit schema", () => {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const file = squash(readFileSync(new URL("../../migrations/0013_profit_engine.sql", import.meta.url), "utf8").replace(/--[^\n]*\n/g, "\n"));
  for (const stmt of SCHEMA) assert.ok(file.includes(squash(stmt)), "missing from migration: " + stmt.slice(0, 70));
  assert.equal((file.match(/CREATE(UNIQUE)?(TABLE|INDEX)IFNOTEXISTS/g) || []).length, SCHEMA.filter(s => s.startsWith("CREATE")).length);
});

async function activate(db: any, o: Partial<Record<string, number>> = {}) {
  await TI.ensureSchema(db);
  const p = { min: 100_000, rec: 5000, rt: 0, rb: 0, liq: 0, op: 5000, lt: 3000, re: 2000, ...o };
  await db.prepare("INSERT INTO treasury_policies (id, environment, version, status, min_trading_capital_cents, loss_recovery_bps, reserve_target_cents, reserve_bps, liquidity_min_cents, operating_bps, long_term_bps, reinvest_bps, proposed_by, proposed_at, decided_by, decided_at) VALUES ('p1','simulated',1,'active',?,?,?,?,?,?,?,?,'a',1,'b',2)")
    .bind(p.min, p.rec, p.rt, p.rb, p.liq, p.op, p.lt, p.re).run();
}

test("with an active policy the pool is allocated automatically, only from recognised profit", async () => {
  const { db, env } = await mk([closed("a", 200, T0)]);
  await activate(db);
  const r = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  assert.ok(r.allocation, JSON.stringify(r)); assert.equal(r.allocation!.totalCents, 20_000);
  const b = await TI.readBalances(db as any, "simulated");
  assert.equal(b.b.realizedProfits, 0, "the pool is fully distributed");
  assert.equal(b.b.operatingFunds, 10_000); assert.equal(b.b.longTermInvestments, 6_000); assert.equal(b.b.tradingCapital, 1_000_000 + 4_000);
});

test("auto-allocation can be switched off and unconfirmed profit is never allocated", async () => {
  const { db, env } = await mk([closed("a", 200, T0), closed("fresh", 500, NOW - 60_000)], { ETI_PROFIT_AUTO_ALLOCATE: "false" });
  await activate(db);
  const r = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  assert.equal(r.allocation, undefined);
  assert.equal((await TI.readBalances(db as any, "simulated")).b.realizedProfits, 20_000, "only the confirmed trade is in the pool");
  const st = await E.profitState(env, "simulated", NOW); assert.equal(st.excludedByReason.inside_confirmation_window, 1);
});

test("a capital-protection hold routes profit to trading capital instead of distributing", async () => {
  const { db, env } = await mk([closed("w", 2000, T0), closed("l", -1500, T0 + 1000)]);
  await activate(db);
  const r = await E.runProfitCycle(env, "simulated", NOW, { force: true });
  const b = await TI.readBalances(db as any, "simulated");
  assert.equal(b.b.operatingFunds, 0); assert.equal(b.b.longTermInvestments, 0);
  assert.equal(r.allocation?.mode, "capital_protection_hold", JSON.stringify(r));
  assert.equal(b.b.tradingCapital, 1_000_000 + 50_000, "the profit stays in trading capital");
  assert.equal((await E.profitState(env, "simulated", NOW)).protection.hold, true);
});
