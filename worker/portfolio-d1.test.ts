// Runs the whole portfolio suite against the D1 backend (SQLite-backed shim), then D1-specific checks.
process.env.PF_BACKEND = "d1";
await import("./portfolio.test.ts");
import test from "node:test";
import assert from "node:assert/strict";
import { PortfolioStore, importKvToD1, openStore, SCHEMA, storageConfigured } from "./portfolio/store.ts";
import { sqliteD1 } from "./portfolio/testing.ts";
import { handlePortfolio } from "./portfolio/routes.ts";
import { placeInternal } from "./portfolio/engine.ts";

class MemKV { m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; } async put(k: string, v: string) { this.m.set(k, v); } async delete(k: string) { this.m.delete(k); }
  async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) { return { keys: [...this.m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })) }; } }
const ev = (id: string, at: number): any => ({ id, at, t: "init", startingBalance: 10, currency: "USDT" });

test("[d1] schema is idempotent, duplicate ids are ignored by the primary key, head counter moves, order is (at, id)", async () => {
  const db = sqliteD1(), st = new PortfolioStore(db, "internal_paper"), h0 = await st.head(); assert.equal(h0, "none");
  assert.equal(await st.append(ev("b", 20)), true); assert.equal(await st.append(ev("b", 20)), false, "same id again: ignored"); assert.equal(await st.append(ev("a", 20)), true); assert.equal(await st.append(ev("c", 10)), true);
  assert.equal((await st.events()).events.map((e: any) => e.id).join(","), "c,a,b");
  assert.notEqual(await st.head(), h0);
  for (const s of SCHEMA) await db.prepare(s).run(); // re-applying the migration is harmless
  assert.equal((await new PortfolioStore(db, "exchange_testnet").events()).events.length, 0, "streams are per environment");
});

test("[d1] a failed batch rolls back: no event without its head bump", async () => {
  const db = sqliteD1(), st = new PortfolioStore(db, "internal_paper"); await st.append(ev("x", 1));
  const real = db.batch.bind(db); (db as any).batch = async (ss: any[]) => real([...ss, db.prepare("INSERT INTO no_such_table VALUES (1)")]);
  await assert.rejects(() => st.append(ev("y", 2))); (db as any).batch = real;
  assert.deepEqual((await st.events()).events.map((e: any) => e.id), ["x"]);
});

test("[d1] kv helper honours expiry; polling reads one row while nothing changed", async () => {
  const db = sqliteD1(), st = new PortfolioStore(db, "internal_paper");
  await st.kvPut("a", { n: 1 }); assert.deepEqual(await st.kvGet("a", null), { n: 1 }); assert.equal(await st.kvGet("missing", "fb"), "fb");
  await db.prepare("UPDATE pf_kv SET exp = 1 WHERE k = 'a'").run(); assert.equal(await st.kvGet("a", "gone"), "gone", "expired value is not returned");
  await st.append(ev("p", 5)); await st.ledgerFast(); const n = db.queries.length; const r = await st.ledgerFast(); assert.equal(r.cached, true);
  assert.deepEqual(db.queries.slice(n).map(q => q.slice(0, 19)), ["SELECT v FROM pf_kv"], "only the head row is read");
});

test("[d1] openStore prefers D1, falls back to KV, and reports unconfigured", async () => {
  assert.equal(openStore({ ETI_PORTFOLIO_DB: sqliteD1(), ETI_EXECUTION_LOG: new MemKV() }, "internal_paper")!.kind, "d1");
  assert.equal(openStore({ ETI_EXECUTION_LOG: new MemKV() }, "internal_paper")!.kind, "kv");
  assert.equal(openStore({}, "internal_paper"), null); assert.equal(storageConfigured({}), false);
});

test("[d1] end to end through the API: state says d1; migration from KV is master-only and idempotent", async () => {
  const kv = new MemKV(), env: any = { ETI_EXECUTION_LOG: kv, ETI_EXECUTION_TOKEN: "master-token-value-0123456789", ETI_PAPER_START_BALANCE: "100000", ETI_PAPER_SLIPPAGE_BPS: "0" };
  const deps = { now: () => 1_800_000_000_000, priceOf: async () => 50_000 };
  // history written while only KV existed
  await placeInternal(env, deps, { clientOrderId: "kvorder0001", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1 }, deps.now());
  const kvLedger = (await openStore(env, "internal_paper")!.ledger()).ledger; assert.equal(kvLedger.positions.BTCUSDT.qty, 1);
  env.ETI_PORTFOLIO_DB = sqliteD1();
  const call = async (path: string, token?: string, body?: unknown) => { const r = await handlePortfolio(new Request("https://eti.test" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, deps); return { r, b: await r.json() as any }; };
  assert.equal((await call("/api/portfolio/state?environment=internal_paper", env.ETI_EXECUTION_TOKEN)).b.positions.length, 0, "D1 starts empty");
  assert.equal((await call("/api/portfolio/migrate-to-d1", undefined, { environment: "internal_paper" })).r.status, 401);
  const m1 = await call("/api/portfolio/migrate-to-d1", env.ETI_EXECUTION_TOKEN, { environment: "internal_paper" }); assert.equal(m1.r.status, 200); assert.ok(m1.b.written >= 3, JSON.stringify(m1.b));
  const m2 = await call("/api/portfolio/migrate-to-d1", env.ETI_EXECUTION_TOKEN, { environment: "internal_paper" }); assert.equal(m2.b.written, 0, "re-running copies nothing");
  const st = (await call("/api/portfolio/state?environment=internal_paper", env.ETI_EXECUTION_TOKEN)).b;
  assert.equal(st.storage, "d1"); assert.equal(st.positions.length, 1); assert.equal(st.positions[0].qty, 1); assert.match(st.sync.consistency, /strongly consistent/);
  const direct = await importKvToD1(kv as any, env.ETI_PORTFOLIO_DB, "internal_paper"); assert.equal(direct.written, 0);
});

import { readFileSync } from "node:fs";
test("[d1] migration file mirrors the runtime schema; provisioning helpers patch wrangler.jsonc and parse wrangler output", async () => {
  const mig = readFileSync(new URL("../migrations/0001_portfolio.sql", import.meta.url), "utf8");
  for (const s of SCHEMA) assert.ok(mig.includes(s), "migration lacks: " + s);
  const { patchWrangler, parseDatabaseId } = await import("../scripts/provision-d1.mjs");
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), id = "123e4567-e89b-12d3-a456-426614174000";
  const patched = patchWrangler(cfg, "eti-portfolio", id); assert.ok(patched.includes('"ETI_PORTFOLIO_DB"') && patched.includes(id)); assert.equal(patchWrangler(patched, "eti-portfolio", id), patched, "idempotent");
  assert.doesNotThrow(() => JSON.parse(patched.replace(/^\s*\/\/.*$/gm, "")), "patched wrangler.jsonc is still valid JSON");
  assert.equal(parseDatabaseId('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "' + id + '"'), id);
  assert.equal(parseDatabaseId('{ "d1_databases": [ { "database_id": "' + id + '" } ] }'), id);
  assert.throws(() => parseDatabaseId("nothing here"));
});
