import test from "node:test";
import assert from "node:assert/strict";
import { parseJarvisCommand, withJarvis } from "./jarvis.ts";

test("JARVIS routes natural-language market requests to the existing council", () => {
  assert.deepEqual(parseJarvisCommand("Please analyse ETHUSDT on 15m"), {
    intent: "analyze", symbol: "ETHUSDT", interval: "15m", message: "Please analyse ETHUSDT on 15m",
  });
});

test("an explicit trading symbol and timeframe are enough to request analysis", () => {\n  assert.equal(parseJarvisCommand("BTCUSDT 15m").intent, "analyze");
});
\ntest("JARVIS recognizes status, audit and explicit deep-review intents", () => {
  assert.equal(parseJarvisCommand("Check system health and autopilot").intent, "status");
  assert.equal(parseJarvisCommand("Show performance audit").intent, "audit");
  assert.equal(parseJarvisCommand("Give me a deep review of BTCUSDT 1h").intent, "deep_review");
});

test("JARVIS requires bearer authentication before exposing capabilities", async () => {
  const app = withJarvis({ fetch: () => Response.json({ delegated: true }) });
  const res = await app.fetch(new Request("https://eti.test/api/agents/jarvis"), {} as any);
  assert.equal(res.status, 401);
});

test("JARVIS help is bounded, authenticated and does not delegate execution", async () => {
  const env: any = {
    ETI_EXECUTION_TOKEN: "jarvis-test-token",
    ETI_EXECUTION_LOG: {
      values: new Map<string, string>(),
      async get(k: string) { return this.values.get(k) ?? null; },
      async put(k: string, v: string) { this.values.set(k, v); },
    },
  };
  const calls: string[] = [];
  const app = withJarvis({ fetch: (req: Request) => { calls.push(new URL(req.url).pathname); return Response.json({}); } });
  const res = await app.fetch(new Request("https://eti.test/api/agents/jarvis", {
    method: "POST", headers: { authorization: "Bearer jarvis-test-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "What can you do?" }),
  }), env);
  const data: any = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.result.kind, "help");
  assert.equal(data.safety.liveExecutionAllowed, false);
  assert.deepEqual(calls, []);
  assert.equal(data.memory.saved, true);
});
