import test from "node:test";
import assert from "node:assert/strict";
import { readAutopilotConfig, runAgentAutopilotCycle } from "./autopilot.ts";

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

test("consolidated autopilot JSON config supplies all strategy and risk settings", () => {
  const config = readAutopilotConfig({ ETI_AGENT_AUTOPILOT_CONFIG: JSON.stringify({
    symbols: "BTCUSDT,ETHUSDT", interval: "1h", maxPerCycle: 1, minConfidence: 0.7,
    minAgreement: 0.75, maxPositions: 2, strategies: "intraday,swing",
    minStrategyAgreement: 2, minOmniConfidence: 68,
  }) } as any);
  assert.deepEqual(config, { symbols: "BTCUSDT,ETHUSDT", interval: "1h", maxPerCycle: 1, minConfidence: 0.7, minAgreement: 0.75, maxPositions: 2, strategies: "intraday,swing", minStrategyAgreement: 2, minOmniConfidence: 68 });
});

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
    if (path === "/api/analysis/liquidity-fvg") return Response.json({ autopilotEligible: true, direction: "BUY", score: 91, manipulation: { level: "moderate" }, safety: { submitsOrder: false, bypassesRiskManager: false }, blocks: [] });
    if (path === "/api/omnisignal") return Response.json({ decision: "BUY", tradeable: true, confidence: 82, validation: { hardFailures: [] } });
    if (path.endsWith("/analyze")) return Response.json({ decision: { action: "BUY", confidence: 0.82, consensus: { agreement: 0.78 } }, risk: { approved: true, vetoes: [] }, security: { severity: "none" } });
    return Response.json({ ok: true, decision: { action: "BUY" }, broker: { fill: { price: 100 } } }, { status: 201 });
  } };
  const result = await runAgentAutopilotCycle(env, app, 1_800_000);
  assert.equal(result.submitted, 1);
  assert.equal(calls.length, 7);
  assert.equal(calls[0].path, "/api/agents/analyze", "the full council must run before strategy gates");
  assert.equal(calls[1].path, "/api/analysis/liquidity-fvg", "fusion gate must be evaluated");
  assert.equal(calls.slice(2, 6).every(x => x.path === "/api/omnisignal"), true, "all four strategy engines must be consulted");
  assert.equal(calls[0].body.execution, undefined, "preflight must remain read-only");
  assert.equal(calls[0].body.record, true, "automatic council decisions must be durably recorded");
  assert.equal(calls[6].path, "/api/agents/execute");
  assert.equal(calls[6].body.execution.broker, "eti_paper");
  assert.equal(calls[6].body.execution.executionSource.actorType, "automation");
  assert.equal(result.liveOrdersAllowed, false);
});

test("autopilot runs and records the full council before abstaining on strategy disagreement", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  const calls: string[] = [];
  const app = { fetch: async (req: Request) => {
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path === "/api/analysis/liquidity-fvg") return Response.json({ autopilotEligible: true, direction: "BUY", score: 91, manipulation: { level: "moderate" }, safety: { submitsOrder: false, bypassesRiskManager: false }, blocks: [] });
    if (path.endsWith("/analyze")) return Response.json({ decision: { action: "BUY", confidence: 0.82, consensus: { agreement: 0.78 } }, risk: { approved: true }, security: { severity: "none" }, auditPersistence: "d1" });
    const strategy = new URL(req.url).searchParams.get("strategy");
    return Response.json({ decision: strategy === "scalp" || strategy === "intraday" ? "BUY" : "HOLD", tradeable: true, confidence: 80, validation: { hardFailures: [] } });
  } };
  const result = await runAgentAutopilotCycle(env, app, 1_950_000);
  assert.equal(result.submitted, 0);
  assert.equal(calls.length, 6);
  assert.equal(calls[0], "/api/agents/analyze");
  assert.equal(calls[1], "/api/analysis/liquidity-fvg");
  assert.equal(calls.slice(2).every(x => x === "/api/omnisignal"), true);
  assert.equal(result.outcomes[0].reason, "omnisignal_strategy_consensus_not_met");
  assert.equal(result.outcomes[0].council.auditPersistence, "d1");
});

test("autopilot refuses a trade below configured confidence and agreement", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  const calls: string[] = [];
  const app = { fetch: async (req: Request) => {
    const path = new URL(req.url).pathname; calls.push(path);
    if (path === "/api/analysis/liquidity-fvg") return Response.json({ autopilotEligible: true, direction: "BUY", score: 91, manipulation: { level: "moderate" }, safety: { submitsOrder: false, bypassesRiskManager: false }, blocks: [] });
    if (path === "/api/omnisignal") return Response.json({ decision: "BUY", tradeable: true, confidence: 82, validation: { hardFailures: [] } });
    return Response.json({ decision: { action: "BUY", confidence: 0.54, consensus: { agreement: 0.9 } }, risk: { approved: true }, security: { severity: "none" }, auditPersistence: "d1" });
  } };
  const result = await runAgentAutopilotCycle(env, app, 2_100_000);
  assert.equal(result.submitted, 0);
  assert.equal(calls.length, 6);
  assert.equal(calls[0], "/api/agents/analyze");
  assert.equal(calls.slice(1).every(x => x === "/api/omnisignal"), true);
  assert.equal(result.outcomes[0].status, "no_trade");
});

test("autopilot idempotency claim prevents duplicate symbol-slot runs", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  let calls = 0;
  const app = { fetch: async (req: Request) => { calls++; const path = new URL(req.url).pathname; if (path === "/api/analysis/liquidity-fvg") return Response.json({ autopilotEligible: true, direction: "BUY", score: 91, safety: { submitsOrder: false, bypassesRiskManager: false }, blocks: [] }); return path === "/api/omnisignal" ? Response.json({ decision: "HOLD", tradeable: false, confidence: 20, validation: { hardFailures: [] } }) : Response.json({ decision: { action: "NO_TRADE" } }); } };
  const now = 2_400_000;
  await runAgentAutopilotCycle(env, app, now);
  const second = await runAgentAutopilotCycle(env, app, now);
  assert.equal(calls, 6, "one council analysis, one liquidity-FVG gate and four strategy checks run in the first slot");
  assert.equal(second.outcomes[0].reason, "already_processed_this_slot");
});
