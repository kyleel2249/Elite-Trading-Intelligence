import test from "node:test";
import assert from "node:assert/strict";
import { INGEST_REFRESH_MS, buildNewsContexts, ingestEventCalendar } from "./ingest.ts";
import { parseNewsContext } from "./context.ts";
import { keys, type KvLike } from "./stores.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const H = 3_600_000;
function memoryKv(): KvLike & { data: Map<string, string>; puts: number } {
  const data = new Map<string, string>();
  const kv = { data, puts: 0, async get(k: string) { return data.get(k) ?? null; }, async put(k: string, v: string) { kv.puts++; data.set(k, v); } };
  return kv;
}
const feed = (rows: unknown[], status = 200) => (async () => new Response(JSON.stringify(rows), { status })) as unknown as typeof fetch;
const ev = (o: Record<string, unknown>) => ({ title: "FOMC decision", time: new Date(NOW + 5 * H).toISOString(), impact: "high", category: "central_bank", currency: "USD", ...o });
const env = (kv: KvLike) => ({ ETI_EXECUTION_LOG: kv, ETI_EVENT_FEED_URL: "https://calendar.example/feed.json" });

test("no calendar source configured: nothing is read, written or invented", async () => {
  const kv = memoryKv();
  const r = await ingestEventCalendar({ ETI_EXECUTION_LOG: kv }, ["BTCUSDT"], NOW, feed([]));
  assert.equal(r.status, "not_configured"); assert.equal(kv.puts, 0);
});

test("a clean feed becomes market-wide news with scheduled flags; unrelated currencies are left out", async () => {
  const kv = memoryKv();
  const r = await ingestEventCalendar(env(kv), [], NOW, feed([ev({}), ev({ title: "ECB speech", currency: "EUR", time: new Date(NOW + 2 * H).toISOString() }), ev({ title: "Old", time: new Date(NOW - 30 * H).toISOString() })]));
  assert.equal(r.status, "ok");
  const ctx = parseNewsContext(JSON.parse(kv.data.get(keys.marketNews())!))!;
  assert.deepEqual(ctx.events.map(e => e.title), ["FOMC decision"]);
  assert.equal(ctx.events[0].impact, "high"); assert.equal(ctx.events[0].scheduled, true); assert.equal(ctx.events[0].sentiment, null);
  assert.match(ctx.source, /^auto:calendar\.example/);
});

test("an empty but successfully loaded calendar is written as 'no events', a failed one is not written", async () => {
  const kv = memoryKv();
  assert.equal((await ingestEventCalendar(env(kv), [], NOW, feed([]))).status, "ok");
  assert.equal(parseNewsContext(JSON.parse(kv.data.get(keys.marketNews())!))!.events.length, 0);
  const kv2 = memoryKv();
  const bad = await ingestEventCalendar(env(kv2), [], NOW, feed([], 503));
  assert.equal(bad.status, "error"); assert.equal(kv2.puts, 0);
  const kv3 = memoryKv();
  const partial = await ingestEventCalendar(env(kv3), [], NOW, feed([ev({}), { title: "no time or impact" }]));
  assert.equal(partial.status, "error"); assert.match(partial.detail, /invalid/); assert.equal(kv3.puts, 0);
  const kv4 = memoryKv();
  assert.equal((await ingestEventCalendar(env(kv4), [], NOW, (async () => { throw new Error("offline"); }) as any)).status, "error"); assert.equal(kv4.puts, 0);
});

test("symbol-scoped events go to that asset's news key only for configured symbols, capped", () => {
  const rows = [{ id: "1", title: "BTC ETF ruling", time: NOW + H, impact: "high" as const, category: "other" as const, currencies: [], markets: [], symbols: ["BTCUSDT"], source: "x" },
    { id: "2", title: "Other", time: NOW + H, impact: "low" as const, category: "other" as const, currencies: [], markets: [], symbols: ["DOGEUSDT"], source: "x" }];
  const { market, perBase } = buildNewsContexts(rows, ["x"], ["BTCUSDT", "ETHUSDT"], NOW);
  assert.equal(market.events.length, 0); assert.deepEqual([...perBase.keys()], ["BTC"]);
});

test("operator-supplied fresh data is never overwritten; stale or auto data is refreshed on schedule", async () => {
  const kv = memoryKv();
  kv.data.set(keys.marketNews(), JSON.stringify({ asOf: new Date(NOW - H).toISOString(), source: "my-macro-calendar", events: [] }));
  let calls = 0; const f = (async () => { calls++; return new Response("[]", { status: 200 }); }) as unknown as typeof fetch;
  const kept = await ingestEventCalendar(env(kv), [], NOW, f);
  assert.equal(kept.status, "skipped"); assert.equal(calls, 0); assert.match(kv.data.get(keys.marketNews())!, /my-macro-calendar/);
  kv.data.set(keys.marketNews(), JSON.stringify({ asOf: new Date(NOW - 13 * H).toISOString(), source: "my-macro-calendar", events: [] }));
  assert.equal((await ingestEventCalendar(env(kv), [], NOW, f)).status, "ok"); assert.equal(calls, 1);
  assert.equal((await ingestEventCalendar(env(kv), [], NOW + 60_000, f)).status, "skipped"); assert.equal(calls, 1, "auto data refreshed recently");
  assert.equal((await ingestEventCalendar(env(kv), [], NOW + INGEST_REFRESH_MS + 1, f)).status, "ok"); assert.equal(calls, 2);
});

test("a blackout event ingested this way is visible to the engine's news parser", () => {
  const { market } = buildNewsContexts([{ id: "1", title: "CPI", time: NOW + H, impact: "high", category: "economic", currencies: ["USD"], markets: [], symbols: [], source: "feed" }], ["feed"], [], NOW);
  const parsed = parseNewsContext(JSON.parse(JSON.stringify(market)));
  assert.ok(parsed && parsed.events[0].impact === "high" && parsed.events[0].scheduled);
});

test("the scheduled cycle ingests the calendar, and a failed feed is reported without breaking the cycle", async () => {
  const { runPrecisionCycle } = await import("./cycle.ts");
  const real = globalThis.fetch;
  try {
    const kv = memoryKv(); const now = Date.now();
    globalThis.fetch = (async (u: any) => String(u).includes("calendar.example")
      ? new Response(JSON.stringify([{ title: "CPI", time: new Date(now + 2 * H).toISOString(), impact: "high", category: "economic", currency: "USD" }]), { status: 200 })
      : new Response("down", { status: 503 })) as typeof fetch;
    const e: any = { ETI_PRECISION_DATA: kv, ETI_PRECISION_SYMBOLS: "BTCUSDT", ETI_EVENT_FEED_URL: "https://calendar.example/f" };
    const r = await runPrecisionCycle(e, now);
    assert.equal(r.ingest?.status, "ok");
    assert.equal(parseNewsContext(JSON.parse(kv.data.get(keys.marketNews())!))!.events[0].title, "CPI");
    const kv2 = memoryKv(); globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const r2 = await runPrecisionCycle({ ...e, ETI_PRECISION_DATA: kv2 }, now);
    assert.equal(r2.status, "ok"); assert.equal(r2.ingest?.status, "error"); assert.ok(r2.notes.some(n => /calendar/i.test(n))); assert.equal(kv2.data.has(keys.marketNews()), false);
  } finally { globalThis.fetch = real; }
});
