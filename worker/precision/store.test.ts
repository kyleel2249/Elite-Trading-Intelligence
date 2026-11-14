import test from "node:test";
import assert from "node:assert/strict";
import { handlePrecision } from "./api.ts";
import { loadContext, precisionStore, type KvLike, type PrecisionEnv } from "./stores.ts";

const TOKEN = "a-sufficiently-long-admin-token-123";
const memoryKv = (): KvLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
};
const put = (path: string, body: unknown, env: PrecisionEnv) =>
  handlePrecision(new Request("https://eti.test" + path, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
const fundamentals = { asOf: new Date().toISOString(), source: "feed", factors: [{ name: "Adoption", bias: 0.7 }] };

test("a dedicated namespace wins; otherwise the existing ETI KV is used", () => {
  const a = memoryKv(), b = memoryKv();
  assert.equal(precisionStore({}), undefined);
  assert.equal(precisionStore({ ETI_EXECUTION_LOG: a }), a);
  assert.equal(precisionStore({ ETI_EXECUTION_LOG: a, ETI_PRECISION_DATA: b }), b);
});

test("writes to the shared ETI namespace stay under the precision: prefix and leave other keys alone", async () => {
  const shared = memoryKv();
  shared.data.set("exec:unrelated", "keep");
  const env = { ETI_EXECUTION_LOG: shared, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  assert.equal((await put("/api/precision/admin/fundamentals/BTC", fundamentals, env)).status, 200);
  assert.equal((await put("/api/precision/admin/news/_market", { asOf: fundamentals.asOf, source: "cal", events: [] }, env)).status, 200);
  assert.deepEqual([...shared.data.keys()].sort(), ["exec:unrelated", "precision:fundamentals:BTC", "precision:news:_market"]);
  assert.equal(shared.data.get("exec:unrelated"), "keep");
  const ctx = await loadContext(env, "BTC", "intraday", Date.now(), 45);
  assert.equal(ctx.storeConfigured, true);
  assert.equal(ctx.fundamentals?.source, "feed");
});

test("with both bound, data goes to the dedicated namespace only", async () => {
  const shared = memoryKv(), dedicated = memoryKv();
  const env = { ETI_EXECUTION_LOG: shared, ETI_PRECISION_DATA: dedicated, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  await put("/api/precision/admin/fundamentals/ETH", fundamentals, env);
  assert.ok(dedicated.data.has("precision:fundamentals:ETH"));
  assert.equal(shared.data.size, 0);
});

test("with no namespace at all the admin route refuses to store and the context is unavailable", async () => {
  const env = { ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  assert.equal((await put("/api/precision/admin/fundamentals/BTC", fundamentals, env)).status, 503);
  const ctx = await loadContext(env, "BTC", "intraday", Date.now(), 45);
  assert.equal(ctx.storeConfigured, false);
  assert.equal(ctx.fundamentals, null);
});

// ---- the shared expectancy store (worker/algo/expectancy.ts) can only make the Precision answer more conservative ----
import { saveRecord, checkRecord } from "../algo/expectancy.ts";
const D = 86_400_000;
const shared = (o: Record<string, unknown> = {}) => { const c = checkRecord({ strategy: "intraday", symbol: "*", source: "replay", expectancyR: 0.25, samples: 50, ciLow95: 0.05, ciHigh95: 0.45, periodEnd: Date.now() - D, periodStart: Date.now() - 60 * D, ...o }, Date.now()); assert.ok(c.ok, JSON.stringify(c)); return (c as any).record; };
const own = (kv: ReturnType<typeof memoryKv>, expectancyR: number) => kv.data.set("precision:expectancy:intraday", JSON.stringify({ expectancyR, samples: 80, asOf: new Date().toISOString(), source: "manual research" }));

test("shared store: negative evidence overrides a more optimistic Precision record", async () => {
  const kv = memoryKv(); own(kv, 0.6); await saveRecord(kv as any, shared({ source: "paper", expectancyR: -0.2, ciLow95: -0.5, ciHigh95: 0.1 }));
  const ctx = await loadContext({ ETI_EXECUTION_LOG: kv }, "BTC", "intraday", Date.now(), 45);
  assert.equal(ctx.expectancy?.expectancyR, -0.2); assert.match(ctx.expectancyNote ?? "", /overrides/);
});
test("shared store: validated evidence caps an optimistic record but never raises a lower one", async () => {
  const kv = memoryKv(); own(kv, 0.6); await saveRecord(kv as any, shared());
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv }, "BTC", "intraday", Date.now(), 45)).expectancy?.expectancyR, 0.25);
  const kv2 = memoryKv(); own(kv2, 0.1); await saveRecord(kv2 as any, shared());
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv2 }, "BTC", "intraday", Date.now(), 45)).expectancy?.expectancyR, 0.1, "the lower (more conservative) value stays");
});
test("shared store: validated evidence is used when Precision has none; unproven evidence leaves the Precision record untouched", async () => {
  const kv = memoryKv(); await saveRecord(kv as any, shared());
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv }, "BTC", "intraday", Date.now(), 45)).expectancy?.expectancyR, 0.25);
  const kv2 = memoryKv(); own(kv2, 0.4); await saveRecord(kv2 as any, shared({ ciLow95: -0.1 }));   // positive but its interval includes zero: unproven
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv2 }, "BTC", "intraday", Date.now(), 45)).expectancy?.expectancyR, 0.4);
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: memoryKv() }, "BTC", "intraday", Date.now(), 45)).expectancy, null);
});
test("shared store: symbol-specific negative evidence applies to that symbol only; other strategies are unaffected", async () => {
  const kv = memoryKv(); own(kv, 0.5); await saveRecord(kv as any, shared({ symbol: "BTCUSDT", expectancyR: -0.3, ciLow95: -0.6, ciHigh95: 0 }));
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv }, "BTC", "intraday", Date.now(), 45, "BTCUSDT")).expectancy?.expectancyR, -0.3);
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv }, "ETH", "intraday", Date.now(), 45, "ETHUSDT")).expectancy?.expectancyR, 0.5);
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: kv }, "BTC", "swing", Date.now(), 45, "BTCUSDT")).expectancy, null);
});
test("shared store: an unreadable store never loosens anything", async () => {
  const kv = memoryKv(); own(kv, 0.5); const flaky = { get: async (k: string) => { if (k.startsWith("algo:")) throw new Error("kv down"); return kv.get(k); }, put: kv.put.bind(kv) };
  assert.equal((await loadContext({ ETI_EXECUTION_LOG: flaky as any }, "BTC", "intraday", Date.now(), 45)).expectancy?.expectancyR, 0.5);
});
