import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { catalogueStatus, runBitgetCatalogueSync, CATALOGUE_FRESH_SECONDS } from "./catalogue.ts";
import { handleBitget } from "./api.ts";
import { handleMarket, listBitgetSymbols, _resetSymbolCache } from "../market.ts";
import main from "../main.ts";

const realFetch = globalThis.fetch;
const realError = console.error;
test.beforeEach(() => { _resetSymbolCache(); console.error = () => {}; });
test.afterEach(() => { globalThis.fetch = realFetch; console.error = realError; _resetSymbolCache(); });

/** Real SQLite behind a D1-shaped adapter so the actual migration SQL and constraints are exercised. Counts statements by verb. */
function realDb(applyMigration = true) {
  const raw = new DatabaseSync(":memory:");
  if (applyMigration) raw.exec(readFileSync(new URL("../../migrations/0019_bitget_catalogue.sql", import.meta.url), "utf8"));
  const sql: string[] = [];
  const db = { prepare: (q: string) => { const mk = (v: unknown[]): any => ({
    bind: (...x: unknown[]) => mk(x),
    run: async () => { sql.push(q); const r = raw.prepare(q).run(...(v as any[])); return { meta: { changes: Number(r.changes) } }; },
    all: async () => { sql.push(q); return { results: raw.prepare(q).all(...(v as any[])) as any[] }; },
    first: async () => { sql.push(q); return (raw.prepare(q).get(...(v as any[])) as any) ?? null; },
  }); return mk([]); } };
  return { db, raw, sql };
}

type World = Record<string, any[]>;
const inst = (symbol: string, base: string, quote: string, extra: Record<string, unknown> = {}) => ({ symbol, baseCoin: base, quoteCoin: quote, status: "online", ...extra });
const newWorld = (): World => ({
  SPOT: [inst("BTCUSDT", "BTC", "USDT"), inst("ETHUSDT", "ETH", "USDT"), inst("SOLUSDT", "SOL", "USDT")],
  "USDT-FUTURES": [inst("BTCUSDT", "BTC", "USDT", { type: "perpetual" }), inst("ETHUSDT", "ETH", "USDT", { type: "perpetual" })],
  "USDC-FUTURES": [inst("BTCPERP", "BTC", "USDC", { type: "perpetual" })],
  "COIN-FUTURES": [inst("BTCUSD", "BTC", "USD", { type: "perpetual" }), inst("ETHUSD", "ETH", "USD", { type: "delivery" })],
  MARGIN: [inst("BTCUSDT", "BTC", "USDT", { isCrossBorrowable: true, maxCrossedLeverage: "5", maxIsolatedLeverage: "10" })],
});
/** A fake Bitget. `down` categories answer 500; `throwAll` makes every request a network error. */
function bitget(world: World, ctl: { down: Set<string>; throwAll: boolean; calls: string[] }): typeof fetch {
  return (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const cat = u.searchParams.get("category") || "";
    ctl.calls.push(u.pathname + "?category=" + cat);
    if (ctl.throwAll) throw new TypeError("network down");
    if (u.pathname !== "/api/v3/market/instruments" || ctl.down.has(cat)) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ code: "00000", data: world[cat] ?? [] }));
  }) as any;
}
const setup = () => { const world = newWorld(), ctl = { down: new Set<string>(), throwAll: false, calls: [] as string[] }; return { world, ctl, fetchImpl: bitget(world, ctl) }; };
const count = (raw: DatabaseSync, cat: string) => (raw.prepare("SELECT pair_count n FROM eti_bitget_catalogue WHERE category=?").get(cat) as any)?.n;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

test("first sync persists all five categories as the baseline: correct counts, no listing events, run ok", async () => {
  const { db, raw } = realDb(), { fetchImpl } = setup();
  const run = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  assert.equal(run.ok, true); assert.equal(run.persisted, true); assert.equal(run.consecutiveFailures, 0);
  assert.deepEqual([count(raw, "SPOT"), count(raw, "USDT-FUTURES"), count(raw, "USDC-FUTURES"), count(raw, "COIN-FUTURES"), count(raw, "MARGIN")], [3, 2, 1, 2, 1]);
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM eti_bitget_catalogue_events").get() as any).n, 0, "the baseline load is not a listing event");
  assert.ok(Object.values(run.categories).every(c => c.status === "ok" && c.error === null));
});

test("a minute with no changes only advances the confirmation time; the large payload is not rewritten", async () => {
  const { db, raw, sql } = realDb(), { fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  const before = raw.prepare("SELECT category, changed_at FROM eti_bitget_catalogue ORDER BY category").all() as any[];
  sql.length = 0;
  const run = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 60_000 });
  assert.equal(run.ok, true);
  assert.equal(sql.filter(s => /^INSERT INTO eti_bitget_catalogue \(/.test(s)).length, 0, "no full-row rewrite when nothing changed");
  assert.equal(sql.filter(s => /^UPDATE eti_bitget_catalogue SET fetched_at/.test(s)).length, 5, "one tiny touch per category");
  const after = raw.prepare("SELECT category, changed_at, fetched_at FROM eti_bitget_catalogue ORDER BY category").all() as any[];
  assert.deepEqual(after.map(r => r.changed_at), before.map(r => r.changed_at));
  assert.ok(after.every(r => r.fetched_at === T0 + 60_000));
});

test("a new listing and a delisting are detected, recorded and the category content updates", async () => {
  const { db, raw } = realDb(), { world, fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  world.SPOT.push(inst("PEPEUSDT", "PEPE", "USDT"));                       // listed
  world["USDT-FUTURES"] = world["USDT-FUTURES"].filter(x => x.symbol !== "ETHUSDT");   // delisted
  world["COIN-FUTURES"][0].status = "maintenance";                          // not tradable any more -> treated as delisted
  const run = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 60_000 });
  assert.deepEqual([run.categories.SPOT.added, run.categories["USDT-FUTURES"].removed, run.categories["COIN-FUTURES"].removed], [1, 1, 1]);
  const ev = raw.prepare("SELECT category, change, symbol FROM eti_bitget_catalogue_events ORDER BY category, symbol").all() as any[];
  assert.deepEqual(ev.map(e => `${e.category}:${e.change}:${e.symbol}`), ["COIN-FUTURES:delisted:BTCUSD", "SPOT:listed:PEPEUSDT", "USDT-FUTURES:delisted:ETHUSDT"]);
  assert.equal(count(raw, "SPOT"), 4); assert.equal(count(raw, "USDT-FUTURES"), 1);
  assert.equal((raw.prepare("SELECT changed_at c FROM eti_bitget_catalogue WHERE category='SPOT'").get() as any).c, T0 + 60_000);
  assert.equal((raw.prepare("SELECT changed_at c FROM eti_bitget_catalogue WHERE category='USDC-FUTURES'").get() as any).c, T0, "an unchanged category keeps its changed_at");
});

test("a changed attribute (margin leverage) rewrites the row but is not a listing event", async () => {
  const { db, raw } = realDb(), { world, fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  world.MARGIN[0].maxCrossedLeverage = "3";
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 60_000 });
  const stored = JSON.parse((raw.prepare("SELECT rows_json j FROM eti_bitget_catalogue WHERE category='MARGIN'").get() as any).j);
  assert.equal(stored[0].maxCrossedLeverage, 3);
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM eti_bitget_catalogue_events").get() as any).n, 0);
});

test("PARTIAL FAILURE: one failed product type keeps its last pairs, is reported, and is NOT treated as delisted", async () => {
  const { db, raw } = realDb(), { world, ctl, fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  ctl.down.add("COIN-FUTURES");
  world["USDT-FUTURES"].push(inst("XRPUSDT", "XRP", "USDT", { type: "perpetual" }));   // other categories keep syncing
  const run = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 60_000 });
  assert.equal(run.ok, false); assert.equal(run.consecutiveFailures, 1);
  assert.equal(run.categories["COIN-FUTURES"].status, "carried"); assert.equal(run.categories["COIN-FUTURES"].count, 2);
  assert.match(String(run.categories["COIN-FUTURES"].error), /./);
  assert.equal(count(raw, "COIN-FUTURES"), 2, "previous coin-margined pairs are still stored");
  assert.equal(count(raw, "USDT-FUTURES"), 3, "healthy categories continue to update");
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM eti_bitget_catalogue_events WHERE category='COIN-FUTURES'").get() as any).n, 0);
  assert.equal((raw.prepare("SELECT fetched_at f FROM eti_bitget_catalogue WHERE category='COIN-FUTURES'").get() as any).f, T0, "its confirmation time is not advanced, so its age stays visible");
  ctl.down.clear();
  const healed = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 120_000 });
  assert.equal(healed.ok, true); assert.equal(healed.consecutiveFailures, 0);
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM eti_bitget_catalogue_events WHERE category='COIN-FUTURES'").get() as any).n, 0, "recovery with identical content produces no phantom events");
});

test("a total Bitget outage keeps everything, invents nothing, and counts consecutive failures", async () => {
  const { db, raw } = realDb(), { ctl, fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  ctl.throwAll = true;
  const r1 = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 60_000 });
  const r2 = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 120_000 });
  assert.deepEqual([r1.ok, r1.consecutiveFailures, r2.consecutiveFailures], [false, 1, 2]);
  assert.ok(Object.values(r2.categories).every(c => c.status === "carried"));
  assert.deepEqual([count(raw, "SPOT"), count(raw, "USDT-FUTURES"), count(raw, "COIN-FUTURES"), count(raw, "MARGIN")], [3, 2, 2, 1]);
});

test("a category that never synced and is unreachable is reported as missing with zero pairs", async () => {
  const { db } = realDb(), { ctl, fetchImpl } = setup();
  ctl.down.add("USDC-FUTURES");
  const run = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  assert.equal(run.categories["USDC-FUTURES"].status, "missing"); assert.equal(run.categories["USDC-FUTURES"].count, 0);
  assert.equal(run.ok, false);
});

test("storage problems never stop the fetch: unbound D1 and a missing migration are reported, not thrown", async () => {
  const { fetchImpl } = setup();
  const unbound = await runBitgetCatalogueSync({}, { fetchImpl, now: () => T0 });
  assert.deepEqual([unbound.persisted, unbound.storageError, unbound.categories.SPOT.count], [false, "d1_not_bound", 3]);
  const { db } = realDb(false);
  const noTables = await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  assert.equal(noTables.persisted, false); assert.match(String(noTables.storageError), /migration_0019/);
});

test("status endpoint: never_synced, fresh, degraded and stale, with real ages and recent changes; it is public", async () => {
  const { db } = realDb(), { world, ctl, fetchImpl } = setup();
  const get = async (now: number) => { const r = await handleBitget(new Request("https://eti.test/api/bitget/catalogue"), { ETI_PORTFOLIO_DB: db }, { now: () => now }); return { status: r.status, body: await r.json() as any }; };
  assert.equal((await get(T0)).body.state, "never_synced");
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  let s = await get(T0 + 30_000);
  assert.deepEqual([s.status, s.body.state, s.body.totals, s.body.intervalSeconds], [200, "fresh", { spot: 3, futures: 5, margin: 1 }, 60]);
  assert.equal(s.body.categories.SPOT.confirmedSecondsAgo, 30);
  world.SPOT.push(inst("PEPEUSDT", "PEPE", "USDT")); ctl.down.add("MARGIN");
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 + 60_000 });
  s = await get(T0 + 70_000);
  assert.equal(s.body.state, "degraded"); assert.equal(s.body.categories.MARGIN.lastRunStatus, "carried"); assert.equal(s.body.lastRunOk, false);
  assert.deepEqual(s.body.recentChanges.map((c: any) => `${c.change}:${c.symbol}`), ["listed:PEPEUSDT"]);
  s = await get(T0 + 60_000 + (CATALOGUE_FRESH_SECONDS + 5) * 1000);
  assert.equal(s.body.state, "stale", "no sync for longer than the freshness window must not look healthy");
});

test("status without a D1 binding is an explicit 503, not an empty success", async () => {
  const r = await catalogueStatus({}, T0);
  assert.equal(r.status, 503); assert.equal((r.body as any).error, "storage_not_configured");
});

test("listBitgetSymbols: a failed futures product type is carried forward and reported; the entry is not served as a fresh hit", async () => {
  const { ctl, fetchImpl } = setup();
  let t = T0; const now = () => t;
  const first = await listBitgetSymbols("futures", fetchImpl, now);
  assert.equal(first.rows.length, 5); assert.deepEqual(first.failed, []);
  t += 61_000; ctl.down.add("COIN-FUTURES");
  const second = await listBitgetSymbols("futures", fetchImpl, now);
  assert.equal(second.rows.length, 5, "coin-margined pairs must not vanish");
  assert.deepEqual(second.failed, ["COIN-FUTURES"]); assert.equal(second.stale, true);
  ctl.calls.length = 0; t += 1_000;
  const third = await listBitgetSymbols("futures", fetchImpl, now);
  assert.ok(ctl.calls.length > 0, "a partial entry is retried immediately instead of being cached for 60s");
  assert.equal(third.rows.length, 5);
});

test("listBitgetSymbols: fresh bypasses the 60-second cache", async () => {
  const { ctl, fetchImpl } = setup();
  await listBitgetSymbols("spot", fetchImpl, () => T0);
  ctl.calls.length = 0;
  assert.equal((await listBitgetSymbols("spot", fetchImpl, () => T0 + 5_000)).cached, true);
  assert.equal(ctl.calls.length, 0);
  assert.equal((await listBitgetSymbols("spot", fetchImpl, () => T0 + 5_000, { fresh: true })).cached, false);
  assert.equal(ctl.calls.length, 1);
});

test("/api/market/symbols serves the stored snapshot, labelled stale, when Bitget is unreachable on a cold isolate", async () => {
  const { db } = realDb(), { ctl, fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  _resetSymbolCache(); ctl.throwAll = true; globalThis.fetch = fetchImpl;
  const res = await handleMarket(new Request("https://eti.test/api/market/symbols?venue=bitget&market=all"), { ETI_PORTFOLIO_DB: db } as any);
  const body: any = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.count, 8, "3 spot + 5 futures");
  assert.equal(body.sources.spot.stale, true); assert.equal(body.sources.spot.host, "eti-d1-snapshot");
  assert.ok(body.warnings.some((w: any) => w.error === "served_from_snapshot"));
  const noDb = await handleMarket(new Request("https://eti.test/api/market/symbols?venue=bitget&market=spot"), {} as any);
  assert.equal(noDb.status, 502, "without a snapshot an outage is still an honest 502");
});

test("/api/market/symbols fills a failed futures product type from the snapshot on a cold isolate", async () => {
  const { db } = realDb(), { ctl, fetchImpl } = setup();
  await runBitgetCatalogueSync({ ETI_PORTFOLIO_DB: db }, { fetchImpl, now: () => T0 });
  _resetSymbolCache(); ctl.down.add("COIN-FUTURES"); globalThis.fetch = fetchImpl;
  const res = await handleMarket(new Request("https://eti.test/api/market/symbols?venue=bitget&market=futures"), { ETI_PORTFOLIO_DB: db } as any);
  const body: any = await res.json();
  assert.equal(body.count, 5);
  assert.ok(body.symbols.some((r: any[]) => r[6] === "COIN-FUTURES"));
  assert.deepEqual(body.sources.futures.partial, ["COIN-FUTURES"]);
});

test("the every-minute cron runs the Bitget catalogue sync (and ETI_BITGET_CATALOGUE_SYNC=false turns it off)", async () => {
  const run = async (extra: Record<string, unknown>) => {
    const { db, raw } = realDb(), { fetchImpl } = setup();
    globalThis.fetch = fetchImpl;
    const pending: Promise<unknown>[] = [];
    await (main as any).scheduled({ cron: "* * * * *" }, { ETI_PORTFOLIO_DB: db, ...extra }, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.allSettled(pending);
    return (raw.prepare("SELECT COUNT(*) n FROM eti_bitget_catalogue").get() as any).n;
  };
  assert.equal(await run({}), 5);
  assert.equal(await run({ ETI_BITGET_CATALOGUE_SYNC: "false" }), 0);
});
