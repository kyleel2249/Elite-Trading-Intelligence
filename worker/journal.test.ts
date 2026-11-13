import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { JournalStore, openJournal, verifyChain, type NewEntry } from "./journal/store.ts";
import { buildTrades, computeStats, deriveInsights } from "./journal/analytics.ts";
import { fromAnalysis, fromManual, fromNote, fromRejection, validateManual } from "./journal/record.ts";
import { judge, syncJournal } from "./journal/sync.ts";
import { handleJournal } from "./journal/api.ts";
import { handleExecution } from "./execution.ts";
import { sqliteD1 } from "./portfolio/testing.ts";

class MemKV { m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; } async put(k: string, v: string) { this.m.set(k, v); } async delete(k: string) { this.m.delete(k); }
  async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) { return { keys: [...this.m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })), list_complete: true }; } }
const T0 = Date.UTC(2026, 10, 10, 12), TOKEN = "master-token-value-0123456789";
const e = (id: string, kind: string, tradeId: string | null, data: any, at = T0, extra: Partial<NewEntry> = {}): NewEntry => ({ id, at, kind: kind as any, tradeId, symbol: "BTCUSDT", environment: "internal_paper", source: "eti_auto", actor: "eti", data, ...extra });
const closed = (id: string, net: number, at: number, extra: any = {}) => e("close:" + id, "trade_closed", id, { qty: 1, entryPrice: 100, exitPrice: 100 + net, gross: net, fees: 0, net, unknownFees: 0, result: net > 0 ? "win" : net < 0 ? "loss" : "breakeven", strategy: "intraday", holdingMs: 60_000, ...extra }, at);

for (const kind of ["d1", "kv"] as const) {
  const mk = () => kind === "d1" ? new JournalStore(sqliteD1()) : new JournalStore(new MemKV() as any);
  test(`[${kind}] entries are chained, idempotent by id, and verify reports an intact chain`, async () => {
    const st = mk();
    const a = await st.append(e("a", "note", "t1", { text: "x" }), T0), a2 = await st.append(e("a", "note", "t1", { text: "DIFFERENT" }), T0 + 5);
    assert.equal(a.created, true); assert.equal(a2.created, false); assert.deepEqual((a2.entry.data as any).text, "x", "an existing entry is never overwritten");
    const b = await st.append(e("b", "note", "t1", { text: "y" }, T0 + 1), T0 + 1);
    assert.equal(b.entry.prev, a.entry.hash); assert.equal((await st.all()).entries.length, 2);
    const v = await verifyChain(st); assert.equal(v.ok, true); assert.equal(v.entries, 2); assert.equal(v.badHashes.length, 0);
  });
}
test("[d1] tampering with a stored entry is detected by verify", async () => {
  const db = sqliteD1(), st = new JournalStore(db);
  await st.append(e("a", "trade_closed", "t1", { net: -5, result: "loss" }), T0); await st.append(e("b", "note", "t1", { text: "ok" }, T0 + 1), T0 + 1);
  await db.prepare("UPDATE jr_entries SET body = ? WHERE id = 'a'").bind(JSON.stringify({ ...(await st.get("a")), data: { net: 500, result: "win" } })).run();
  const v = await verifyChain(st); assert.equal(v.ok, false); assert.ok(v.badHashes.includes("a"));
});
test("[kv] tampering and removal are detected", async () => {
  const kv = new MemKV(), st = new JournalStore(kv as any);
  await st.append(e("a", "note", "t1", { text: "1" }), T0); await st.append(e("b", "note", "t1", { text: "2" }, T0 + 1), T0 + 1); await st.append(e("c", "note", "t1", { text: "3" }, T0 + 2), T0 + 2);
  const key = [...kv.m.keys()].find(k => k.startsWith("jr:e:") && k.endsWith(":b"))!; kv.m.set(key, kv.m.get(key)!.replace('"2"', '"edited"'));
  let v = await verifyChain(st); assert.equal(v.ok, false); assert.ok(v.badHashes.includes("b"));
  kv.m.delete(key); v = await verifyChain(st); assert.equal(v.ok, false, "a removed entry breaks the chain");
});
test("entries never expire: the KV backend writes no expirationTtl", async () => {
  const seen: any[] = [], kv: any = new MemKV(), put = kv.put.bind(kv); kv.put = async (k: string, v: string, o?: any) => { seen.push(o); return put(k, v); };
  await new JournalStore(kv).append(e("a", "note", "t", {}), T0); assert.ok(seen.every(o => !o || o.expirationTtl === undefined));
});

test("trades keep losses, refusals, cancellations, broker rejections and unknown outcomes; stats are computed from what was recorded", async () => {
  const st = new JournalStore(sqliteD1()), A = (n: NewEntry) => st.append(n, T0);
  await A(closed("w1", 30, T0 + 10)); await A(closed("w2", 10, T0 + 20)); await A(closed("l1", -20, T0 + 30)); await A(closed("l2", -40, T0 + 40));
  await A(e("rj1", "order_rejected", "r1", { stage: "balance", reasons: ["Insufficient cash"] }, T0 + 50));
  await A(e("rj2", "order_rejected", "r2", { stage: "balance", reasons: ["Insufficient cash"] }, T0 + 51));
  await A(e("bk", "order_broker_rejected", "b1", { reasons: ["broker said no"] }, T0 + 52)); await A(e("un", "order_outcome_unknown", "u1", { reasons: ["timeout"] }, T0 + 53));
  await A(e("o1", "order_submitted", "c1", { outcome: "resting", side: "buy", quantity: 1 }, T0 + 54)); await A(e("c1", "order_cancelled", "c1", { reason: "user" }, T0 + 55));
  await A(e("ex", "order_expired", "x1", { reason: "ttl" }, T0 + 56)); await A(e("a1", "analysis", "ana-1", { decision: "NO_TRADE", strategy: "intraday" }, T0 + 57));
  const { entries } = await st.all(), s = computeStats(entries, T0 + 100), p = s.performance;
  assert.equal(p.closed, 4); assert.equal(p.wins, 2); assert.equal(p.losses, 2); assert.equal(p.winRate, 0.5); assert.equal(p.netPnl, -20);
  assert.equal(p.expectancy, -5); assert.ok(Math.abs(p.profitFactor! - 40 / 60) < 1e-9); assert.equal(p.maxLossStreak, 2); assert.equal(p.maxDrawdown, 60); assert.equal(p.largestLoss, -40);
  assert.equal(s.orders.refused, 2); assert.equal(s.orders.brokerRejected, 1); assert.equal(s.orders.outcomeUnknown, 1); assert.equal(s.orders.cancelled, 1); assert.equal(s.orders.expired, 1); assert.equal(s.orders.analysedOnly, 1);
  assert.deepEqual(s.orders.refusalReasons[0], { reason: "Insufficient cash", count: 2 }); assert.match(s.dataQuality.sampleWarning!, /below 30/);
  const t = buildTrades(entries); assert.equal(t.find(x => x.tradeId === "c1")!.status, "cancelled"); assert.equal(t.find(x => x.tradeId === "l2")!.result, "loss");
  assert.equal(t.find(x => x.tradeId === "r1")!.reasons[0], "Insufficient cash");
});
test("unknown fees stay unknown and risk multiples are not invented", async () => {
  const st = new JournalStore(sqliteD1()); await st.append(closed("u", 5, T0, { unknownFees: 1 }), T0);
  const t = buildTrades((await st.all()).entries)[0]; assert.equal(t.feesKnown, false); assert.equal(t.r, null);
  assert.equal(computeStats((await st.all()).entries).performance.avgR, null);
});
test("insights need a minimum sample, only suggest, and name their numbers", () => {
  const few = deriveInsights(computeStats([])); assert.equal(few[0].key, "sample_small");
  const rows: any[] = []; for (let i = 0; i < 12; i++) rows.push({ ...closed("s" + i, i < 3 ? 5 : -10, T0 + i, { strategy: "scalp" }), seq: i + 1, recordedAt: T0, prev: null, hash: "h" + i, corrects: null });
  const ins = deriveInsights(computeStats(rows)); const bad = ins.find(i => i.key === "strategy_negative:scalp")!;
  assert.ok(bad); assert.equal(bad.severity, "action"); assert.equal((bad.basis as any).trades, 12);
});

test("manual trades: P&L is computed from prices, validation rejects bad input, corrections are new notes", async () => {
  assert.equal((validateManual({ symbol: "btc usdt", side: "buy", quantity: 1, entryPrice: 1 }) as any).error, "invalid_symbol");
  assert.equal((validateManual({ symbol: "BTCUSDT", side: "buy", quantity: -1, entryPrice: 1 }) as any).error, "invalid_quantity_or_price");
  const v = validateManual({ symbol: "ethusdt", side: "sell", quantity: 2, entryPrice: 100, exitPrice: 90, fees: 1, entryAt: T0 - 1000, exitAt: T0 - 500 }); assert.equal(v.ok, true);
  const entry = await fromManual((v as any).v, "master"); assert.equal((entry.data as any).gross, 20); assert.equal((entry.data as any).net, 19); assert.equal((entry.data as any).result, "win");
  const st = new JournalStore(sqliteD1()); const r = await st.append(entry, T0); const n = await fromNote(entry.tradeId!, "fee was actually 2", "master", { corrects: r.entry.id, at: T0 });
  await st.append(n, T0); const trade = buildTrades((await st.all()).entries)[0]; assert.equal(trade.origin, "manual"); assert.equal(trade.notes, 1); assert.equal((await st.get(r.entry.id))!.hash, r.entry.hash, "original untouched");
});

test("judge: hit, miss, stop-first on ambiguity, inconclusive without data", () => {
  const a = { decision: "BUY", entryZone: null, stop: 95, targets: [110], referencePrice: 100 };
  const k = (hi: number, lo: number): any => [0, 100, hi, lo, 100, 1];
  assert.equal(judge(a, [k(105, 98), k(111, 99)]).outcome, "hit"); assert.equal(judge(a, [k(104, 94)]).outcome, "miss"); assert.match(judge(a, [k(112, 94)]).reason, /stop first/);
  assert.equal(judge(a, [k(104, 99)]).outcome, "miss"); assert.equal(judge(a, []).outcome, "inconclusive"); assert.equal(judge({ ...a, decision: "SELL", stop: 105, targets: [90] }, [k(101, 89)]).outcome, "hit");
});

test("refusals recorded by the order flow are journaled, and sync backfills a missed one exactly once", async () => {
  const kv = new MemKV(), env: any = { ETI_EXECUTION_LOG: kv, ETI_EXECUTION_TOKEN: TOKEN, ETI_READINESS_GATE: "off" };
  const res = await handleExecution(new Request("https://x.test/api/orders", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ broker: "eti_paper", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 0 }) }), env, { now: () => T0 });
  assert.ok(res.status >= 400 && res.status < 500, "refused: " + res.status);
  const st = openJournal(env)!, before = (await st.all()).entries.filter(x => x.kind === "order_rejected");
  assert.equal(before.length, 1, "the refusal is in the journal"); assert.equal(before[0].source, "eti_auto");
  const key = [...kv.m.keys()].find(k => k.startsWith("reject:"))!, rec = JSON.parse(kv.m.get(key)!);
  const r1 = await syncJournal(env, T0 + 1000, { evaluate: false }); assert.equal(r1.added, 0, "already journaled by the hook: no duplicate");
  kv.m.set("reject:2026-11-10T12:30:00.000Z:zzzzzzzz", JSON.stringify({ ...rec, at: "2026-11-10T12:30:00.000Z", request: { ...rec.request, clientOrderId: "missed-1" } }));
  const r2 = await syncJournal(env, T0 + 2000, { evaluate: false }); assert.equal(r2.byKind.order_rejected, 1);
  const r3 = await syncJournal(env, T0 + 3000, { evaluate: false }); assert.equal(r3.added, 0, "idempotent");
  assert.equal((await verifyChain(st)).ok, true);
});

test("api: auth required, append-only (PUT/PATCH/DELETE 405), manual/note/analysis POST, exports", async () => {
  const env: any = { ETI_PORTFOLIO_DB: sqliteD1(), ETI_EXECUTION_TOKEN: TOKEN }, H = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
  const call = (m: string, p: string, body?: unknown, h: any = H) => handleJournal(new Request("https://x.test/api/journal" + p, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, T0);
  assert.equal((await call("GET", "/summary", undefined, {})).status, 401);
  for (const m of ["PUT", "PATCH", "DELETE"]) { const r = await call(m, "/entries/x", {}); assert.equal(r.status, 405); assert.equal((await r.json() as any).error, "journal_is_append_only"); }
  const man = await call("POST", "/manual", { symbol: "BTCUSDT", side: "buy", quantity: 1, entryPrice: 100, exitPrice: 90, entryAt: T0 - 5000, exitAt: T0 - 1000 }); assert.equal(man.status, 201);
  const tradeId = ((await man.json()) as any).entry.tradeId;
  assert.equal((await call("POST", "/note", { tradeId, text: "stopped out, entered late" })).status, 201);
  assert.equal((await call("POST", "/note", { tradeId, text: "x", corrects: "does-not-exist" })).status, 404);
  assert.equal((await call("POST", "/analysis", { symbol: "BTCUSDT", decision: "NO_TRADE", strategy: "intraday" })).status, 201);
  assert.equal((await call("POST", "/manual", { symbol: "!!", side: "buy" })).status, 400);
  const tr = await (await call("GET", "/trades?result=loss")).json() as any; assert.equal(tr.total, 1); assert.equal(tr.trades[0].net, -10);
  const one = await (await call("GET", "/trades/" + tradeId)).json() as any; assert.equal(one.trade.timeline.length, 2);
  const sum = await (await call("GET", "/summary")).json() as any; assert.equal(sum.verification.ok, true); assert.equal(sum.stats.performance.losses, 1);
  const csv = await (await call("GET", "/export?format=csv")).text(); assert.match(csv, /^trade_id,status/); assert.match(csv, /loss/);
  assert.equal((await (await call("GET", "/export")).json() as any).entries.length, 3);
  assert.equal((await call("GET", "/entries?kind=bogus")).status, 400);
});
test("api: no storage bound answers 503, never a silent success", async () => {
  const r = await handleJournal(new Request("https://x.test/api/journal/summary", { headers: { authorization: "Bearer " + TOKEN } }), { ETI_EXECUTION_TOKEN: TOKEN } as any, T0); assert.equal(r.status, 503);
});
test("rejection mapping keeps the trade id of the request and marks broker outcomes", () => {
  const rec = { at: new Date(T0).toISOString(), outcome: "unknown", stage: "broker", reasons: ["no answer"], request: { symbol: "btcusdt", clientOrderId: "cid-9" }, environment: "exchange_testnet" };
  const n = fromRejection("reject:k", rec); assert.equal(n.kind, "order_outcome_unknown"); assert.equal(n.tradeId, "cid-9"); assert.equal(n.symbol, "BTCUSDT");
});
test("analysis ids are deterministic and NO_TRADE decisions are kept", async () => {
  const a = await fromAnalysis({ symbol: "ethusdt", decision: "NO_TRADE", at: T0 }), b = await fromAnalysis({ symbol: "ETHUSDT", decision: "NO_TRADE", at: T0 }); assert.equal(a.id, b.id); assert.equal(a.kind, "analysis");
});
test("the journal source contains no external gateway or live-order reference", () => {
  const bad = /risk[-_ ]?gateway|RISK_GATEWAY|api\.binance\.com\/api\/v3\/order|live_trading:\s*true/i;
  for (const f of readdirSync(new URL("./journal/", import.meta.url))) assert.doesNotMatch(readFileSync(new URL("./journal/" + f, import.meta.url), "utf8"), bad, f);
});
test("a kill-switch refusal from an authenticated caller is journaled; an unauthenticated one writes nothing", async () => {
  const kv = new MemKV(), env: any = { ETI_EXECUTION_LOG: kv, ETI_EXECUTION_TOKEN: TOKEN, ETI_KILL_SWITCH: "true" }, body = JSON.stringify({ broker: "eti_paper", symbol: "BTCUSDT", side: "buy", quantity: 1, clientOrderId: "kill-switch-1" });
  const anon = await handleExecution(new Request("https://x.test/api/orders", { method: "POST", body }), env, { now: () => T0 }); assert.equal(anon.status, 423);
  assert.equal((await openJournal(env)!.all()).entries.length, 0);
  const auth = await handleExecution(new Request("https://x.test/api/orders", { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body }), env, { now: () => T0 }); assert.equal(auth.status, 423);
  const rows = (await openJournal(env)!.all()).entries; assert.equal(rows.length, 1); assert.equal(rows[0].kind, "order_rejected"); assert.equal(rows[0].tradeId, "kill-switch-1"); assert.equal((rows[0].data as any).stage, "kill_switch");
});
test("sports paper bets and predictions reach the journal (losses and misses included) without mixing into trading statistics", async () => {
  const d = sqliteD1(); const { readFileSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter(f => /^000[3-8]/.test(f)).sort()) for (const st of readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8").split(/;\s*\n/)) if (st.trim()) await d.prepare(st).run();
  const bet = (id: string, status: string, profit: number) => d.prepare("INSERT INTO sports_bets (id,created_at,sport,event_name,market,selection,odds,model_probability,stake_cents,status,profit_cents,settled_at,event_id,bookmaker,odds_provider,implied_probability,expected_value,model_version) VALUES (?,?, 'Football','A vs B','Full Time Result','Home',2.0,0.6,1000,?,?,?,?,'bk','t',0.5,0.2,'m1')").bind(id, T0, status, profit, T0 + 5, "fx-" + id).run();
  await bet("b-won", "WON", 1000); await bet("b-lost", "LOST", -1000); await bet("b-void", "VOID", 0); await bet("b-open", "OPEN", 0);
  await d.prepare("INSERT INTO sports_model_predictions (id,fixture_id,created_at,kickoff_at,competition,home_team,away_team,p_home,p_draw,p_away,expected_home_goals,expected_away_goals,sample_size,decision,model_version,actual_outcome,settled_at) VALUES ('p1','fx-b-won',?,?,'L','A','B',0.6,0.2,0.2,1.5,1.0,50,'NO_BET','m1','A',?)").bind(T0, T0 + 9, T0 + 10).run();
  const env: any = { ETI_PORTFOLIO_DB: d }, r = await syncJournal(env, T0 + 100, { evaluate: false }); assert.equal(r.ok, true, r.errors.join());
  const st = openJournal(env)!, { entries } = await st.all(), s = computeStats(entries, T0 + 200);
  assert.equal(s.sportsPaper.bets, 4); assert.equal(s.sportsPaper.wins, 1); assert.equal(s.sportsPaper.losses, 1); assert.equal(s.sportsPaper.voided, 1); assert.equal(s.sportsPaper.open, 1); assert.equal(s.sportsPaper.net, 0);
  assert.equal(s.sportsPaper.predictionMisses, 1, "a missed prediction is kept"); assert.equal(s.performance.closed, 0, "sports bets do not enter trading statistics"); assert.equal(s.orders.executed, 0);
  assert.equal((await syncJournal(env, T0 + 300, { evaluate: false })).added, 0, "idempotent"); assert.equal((await verifyChain(st)).ok, true);
});
