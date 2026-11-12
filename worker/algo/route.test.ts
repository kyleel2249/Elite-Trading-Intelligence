import test from "node:test";
import assert from "node:assert/strict";
import { withAlgo } from "./route.ts";

test("algo route is served by the wrapper; every other route is delegated to the existing app unchanged", async () => {
  const seen: string[] = [];
  const app = withAlgo({ fetch: async (r: Request) => { seen.push(new URL(r.url).pathname); return new Response("base", { status: 200 }); } });
  const algo = await app.fetch(new Request("https://eti.test/api/algo/signal?symbol=BAD%20X"), {});
  assert.equal(algo.status, 400); assert.deepEqual(seen, []);
  for (const p of ["/", "/api/signals", "/api/orders", "/api/system/health", "/api/algo/other"]) {
    const r = await app.fetch(new Request("https://eti.test" + p), {});
    assert.equal(await r.text(), "base");
  }
  assert.deepEqual(seen, ["/", "/api/signals", "/api/orders", "/api/system/health", "/api/algo/other"]);
});
