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
