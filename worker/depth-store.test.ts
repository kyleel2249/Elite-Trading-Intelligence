import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AgentAuditDb } from "./agents/persistence.ts";
import { DEPTH_BUCKET_MS, listDepthSnapshots, persistDepthSnapshot, pruneDepthSnapshots, recordAndLoadDurable } from "./analysis/depth-store.ts";

/** Real SQLite behind a D1-shaped adapter, so the actual migration SQL and constraints are exercised. */
function realDb(): { db: AgentAuditDb; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../migrations/0018_depth_snapshots.sql", import.meta.url), "utf8"));
  const db: AgentAuditDb = { prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({
    run: async () => { const r = raw.prepare(sql).run(...(v as any[])); return { meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: raw.prepare(sql).all(...(v as any[])) as Record<string, unknown>[] }),
  }) }) };
  return { db, raw };
}
const depth = (bid = 99, ask = 101) => ({ bids: [[bid, 10], [bid - 1, 20]] as [number, number][], asks: [[ask, 8], [ask + 1, 15]] as [number, number][] });
const NOW = Date.UTC(2026, 10, 18, 4, 0, 0);
const w = (db: AgentAuditDb, t: number, d = depth(), over: Record<string, unknown> = {}) => persistDepthSnapshot(db, { venue: "bybit", market: "spot", symbol: "BTCUSDT", depth: d, now: t, ...over } as any);

test("migration 0018 is additive, idempotent and creates the snapshot table with its index", () => {
  const { raw } = realDb();
  raw.exec(readFileSync(new URL("../migrations/0018_depth_snapshots.sql", import.meta.url), "utf8")); // second run must not fail
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%depth%'").all() as { name: string }[]).map(r => r.name);
  assert.ok(names.includes("eti_depth_snapshots") && names.includes("idx_eti_depth_snapshots_time"));
  assert.doesNotMatch(readFileSync(new URL("../migrations/0018_depth_snapshots.sql", import.meta.url), "utf8"), /DROP |DELETE FROM|ALTER TABLE/i);
});

test("snapshots persist once per 5s bucket; retries and concurrent writes cannot duplicate", async () => {
  const { db } = realDb();
  assert.equal((await w(db, NOW)).status, "stored");
  assert.equal((await w(db, NOW + 1000)).status, "duplicate");
  assert.equal((await Promise.all([w(db, NOW + 2000), w(db, NOW + 3000)])).every(r => r.status === "duplicate"), true);
  assert.equal((await w(db, NOW + DEPTH_BUCKET_MS)).status, "stored");
  const rows = await listDepthSnapshots(db, { venue: "bybit", market: "spot", symbol: "BTCUSDT" });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].capturedAt < rows[1].capturedAt, "oldest first");
});

test("invalid or crossed books and malformed identities are rejected and never stored", async () => {
  const { db, raw } = realDb();
  assert.equal((await w(db, NOW, { bids: [[102, 1]], asks: [[101, 1]] })).status, "rejected");
  assert.equal((await w(db, NOW, { bids: [], asks: [[101, 1]] })).status, "rejected");
  assert.equal((await w(db, NOW, depth(), { symbol: "btc'; DROP TABLE x;--" })).status, "rejected");
  assert.equal((await w(db, NOW, depth(), { venue: "binance" })).status, "rejected");
  assert.equal((await w(db, NaN)).status, "rejected");
  assert.equal((raw.prepare("SELECT COUNT(*) c FROM eti_depth_snapshots").get() as { c: number }).c, 0);
});

test("queries are scoped by venue, market and symbol, time-filtered and bounded", async () => {
  const { db } = realDb();
  for (let i = 0; i < 12; i++) await w(db, NOW + i * DEPTH_BUCKET_MS);
  await w(db, NOW, depth(), { symbol: "ETHUSDT" }); await w(db, NOW, depth(), { market: "futures" });
  const all = await listDepthSnapshots(db, { venue: "bybit", market: "spot", symbol: "BTCUSDT", limit: 5000 });
  assert.equal(all.length, 12);
  assert.equal((await listDepthSnapshots(db, { venue: "bybit", market: "spot", symbol: "BTCUSDT", limit: 3 })).length, 3);
  assert.equal((await listDepthSnapshots(db, { venue: "bybit", market: "spot", symbol: "BTCUSDT", from: NOW + 10 * DEPTH_BUCKET_MS })).length, 2);
  await assert.rejects(() => listDepthSnapshots(db, { venue: "bybit", market: "spot", symbol: "bad symbol" }), /invalid_symbol/);
});

test("retention prunes only expired depth rows and leaves every other table untouched", async () => {
  const { db, raw } = realDb();
  raw.exec("CREATE TABLE eti_agent_decisions (id TEXT PRIMARY KEY); INSERT INTO eti_agent_decisions VALUES ('keep-me');");
  await w(db, NOW - 20 * 86_400_000); await w(db, NOW + DEPTH_BUCKET_MS); // not a self-pruning bucket, so the explicit prune does the work
  assert.equal(await pruneDepthSnapshots(db, NOW - 14 * 86_400_000), 1);
  assert.equal((raw.prepare("SELECT COUNT(*) c FROM eti_depth_snapshots").get() as { c: number }).c, 1);
  assert.equal((raw.prepare("SELECT COUNT(*) c FROM eti_agent_decisions").get() as { c: number }).c, 1);
});

test("storage outages report unavailable (null) instead of fabricating history", async () => {
  const broken: AgentAuditDb = { prepare: () => { throw new Error("D1 unavailable"); } };
  assert.equal(await recordAndLoadDurable(broken, { venue: "bybit", market: "spot", symbol: "BTCUSDT", depth: depth(), now: NOW }), null);
  assert.equal(await recordAndLoadDurable(undefined, { venue: "bybit", market: "spot", symbol: "BTCUSDT", depth: depth(), now: NOW }), null);
  const { db } = realDb();
  const rows = await recordAndLoadDurable(db, { venue: "bybit", market: "spot", symbol: "BTCUSDT", depth: depth(), now: NOW });
  assert.equal(rows?.length, 1);
});

import { handleAnalysis } from "./analysis/api.ts";
test("the order-flow route persists depth to D1, reports its source and sample limits, and stays read-only", async () => {
  const { db, raw } = realDb();
  const now = Date.now();
  const trades = Array.from({ length: 60 }, (_, i) => ({ time: now - 60_000 + i * 900, price: 100 + (i % 3) * 0.1, qty: 1 + (i % 4), isBuyerMaker: i % 3 === 0 }));
  const call = () => handleAnalysis(new Request("https://eti.test/api/analysis/orderflow", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "of-" + Math.random() }, body: JSON.stringify({ symbol: "BTCUSDT", venue: "bybit", trades, depth: { bids: [[99.9, 10], [99.8, 5]], asks: [[100.1, 8], [100.2, 4]] } }) }), { ETI_PORTFOLIO_DB: db } as any);
  const r = await call(), j = await r.json() as any;
  assert.equal(r.status, 200);
  assert.equal(j.liquidityHistory.status, "recorded");
  assert.equal(j.liquidityHistory.source, "d1");
  assert.equal(j.liquidityHistory.sampleCount, 1);
  assert.match(j.liquidityHistory.note, /at most one per 5 seconds/);
  assert.equal(j.submitsOrder, false); assert.equal(j.liveExecutionAllowed, false);
  await call(); // same bucket: still one durable row
  assert.equal((raw.prepare("SELECT COUNT(*) c FROM eti_depth_snapshots").get() as { c: number }).c <= 2, true);
  const none = await (await handleAnalysis(new Request("https://eti.test/api/analysis/orderflow", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "of-" + Math.random() }, body: JSON.stringify({ symbol: "BTCUSDT", venue: "bybit", trades, depth: { bids: [[99.9, 10]], asks: [[100.1, 8]] } }) }), {})).json() as any;
  assert.equal(none.liquidityHistory.status, "unavailable");
  assert.equal(none.liquidityHistory.sampleCount, 0);
});
