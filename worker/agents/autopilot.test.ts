import test from "node:test";
import assert from "node:assert/strict";
import { runAgentAutopilotCycle } from "./autopilot.ts";

function memoryKV() {
  const data = new Map<string, string>();
  return {
    async get(k: string) { return data.get(k) ?? null; },
    async put(k: string, v: string) { data.set(k, v); },
    async delete(k: string) { data.delete(k); },
    async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) {
      return { keys: [...data.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })), list_complete: true };
    },
    data,
  };
}

test("autopilot is disabled unless explicitly enabled", async () => {
  const kv = memoryKV();
  const result = await runAgentAutopilotCycle({ ETI_EXECUTION_LOG: kv as any } as any, { fetch: () => { throw new Error("must not call app"); } }, 1_800_000);
  assert.equal(result.skipped, "autopilot_disabled");
});

test("autopilot preflights Commander, confidence and Risk Manager before paper order submission", async () => {
  const kv = memoryKV();
  const env: any = {
    ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT",
    ETI_AGENT_AUTOPILOT_INTERVAL: "15m", ETI_AGENT_AUTOPILOT_MIN_CONFIDENCE: "0.65",
    ETI_AGENT_AUTOPILOT_MIN_AGREEMENT: "0.65", ETI_EXECUTION_TOKEN: "master-token",
    ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000",
  };
  const calls: { path: string; body: any }[] = [];
  const app = { fetch: async (req: Request) => {
    const path = new URL(req.url).pathname, body = path.endsWith("/execute") || path.endsWith("/analyze") ? await req.json() : {};
    calls.push({ path, body });
    if (path === "/api/omnisignal") return Response.json({ decision: "BUY", tradeable: true, confidence: 82, validation: { hardFailures: [] } });
    if (path.endsWith("/analyze")) return Response.json({ decision: { action: "BUY", confidence: 0.82, consensus: { agreement: 0.78 } }, risk: { approved: true, vetoes: [] }, security: { severity: "none" } });
    return Response.json({ ok: true, decision: { action: "BUY" }, broker: { fill: { price: 100 } } }, { status: 201 });
  } };
  const result = await runAgentAutopilotCycle(env, app, 1_800_000);
  assert.equal(result.submitted, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/api/agents/analyze");
  assert.equal(calls[0].body.execution, undefined, "preflight must remain read-only");
  assert.equal(calls[1].path, "/api/agents/execute");
  assert.equal(calls[1].body.execution.broker, "eti_paper");
  assert.equal(calls[1].body.execution.executionSource.actorType, "automation");
  assert.equal(result.liveOrdersAllowed, false);
});

test("autopilot refuses a trade below configured confidence and agreement", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  const calls: string[] = [];
  const app = { fetch: async (req: Request) => {
    const path = new URL(req.url).pathname; calls.push(path);
    if (path === "/api/omnisignal") return Response.json({ decision: "BUY", tradeable: true, confidence: 82, validation: { hardFailures: [] } });
    return Response.json({ decision: { action: "BUY", confidence: 0.54, consensus: { agreement: 0.9 } }, risk: { approved: true }, security: { severity: "none" } });
  } };
  const result = await runAgentAutopilotCycle(env, app, 2_100_000);
  assert.equal(result.submitted, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/api/agents/analyze");
  assert.equal(result.outcomes[0].status, "no_trade");
});

test("autopilot idempotency claim prevents duplicate symbol-slot runs", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  let calls = 0;
  const app = { fetch: async (req: Request) => { calls++; return new URL(req.url).pathname === "/api/omnisignal" ? Response.json({ decision: "HOLD", tradeable: false, confidence: 20, validation: { hardFailures: [] } }) : Response.json({ decision: { action: "NO_TRADE" } }); } };
  const now = 2_400_000;
  await runAgentAutopilotCycle(env, app, now);
  const second = await runAgentAutopilotCycle(env, app, now);
  assert.equal(calls, 4);
  assert.equal(second.outcomes[0].reason, "already_processed_this_slot");
});
