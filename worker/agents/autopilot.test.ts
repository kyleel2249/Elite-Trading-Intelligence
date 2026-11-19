import test from "node:test";
import assert from "node:assert/strict";
import { agreementMagnitudeMeetsThreshold, readAutopilotConfig, runAgentAutopilotCycle, scheduleAgentAutopilot } from "./autopilot.ts";

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

test("signed council agreement uses magnitude for both bullish and bearish consensus", () => {
  assert.equal(agreementMagnitudeMeetsThreshold(0.78, 0.65), true);
  assert.equal(agreementMagnitudeMeetsThreshold(-0.78, 0.65), true);
  assert.equal(agreementMagnitudeMeetsThreshold(-0.64, 0.65), false);
  assert.equal(agreementMagnitudeMeetsThreshold(0, 0.65), false);
  assert.equal(agreementMagnitudeMeetsThreshold(Number.NaN, 0.65), false);
});

test("consolidated autopilot JSON config supplies all strategy and risk settings", () => {
  const config = readAutopilotConfig({ ETI_AGENT_AUTOPILOT_CONFIG: JSON.stringify({
    symbols: "BTCUSDT,ETHUSDT", interval: "1h", maxPerCycle: 1, minConfidence: 0.7,
    minAgreement: 0.75, maxPositions: 2, strategies: "intraday,swing",
    minStrategyAgreement: 2, minOmniConfidence: 68,
  }) } as any);
  assert.deepEqual(config, { symbols: "BTCUSDT,ETHUSDT", interval: "1h", maxPerCycle: 1, minConfidence: 0.7, minAgreement: 0.75, maxPositions: 2, strategies: "intraday,swing", minStrategyAgreement: 2, minOmniConfidence: 68 });
});

test("five-minute autopilot is scheduled even when the universe scanner uses the same cron", async () => {
  const kv = memoryKV();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { waits.push(p); } };
  const scheduled = scheduleAgentAutopilot("*/5 * * * *", {
    ETI_AGENT_AUTOPILOT_ENABLED: "false", ETI_EXECUTION_LOG: kv as any,
  } as any, { fetch: () => { throw new Error("disabled autopilot must not call app"); } }, ctx);
  assert.equal(scheduled, true);
  assert.equal(waits.length, 1, "shared five-minute cron must enqueue the autopilot");
  await Promise.all(waits);
  const last = JSON.parse(kv.data.get("agent-autopilot:last") || "null");
  assert.equal(last.skipped, "autopilot_disabled");
  assert.equal(last.submitted, 0);
  const heartbeat = JSON.parse(kv.data.get("agent-autopilot:heartbeat") || "null");
  assert.equal(heartbeat.status, "completed");
  assert.equal(heartbeat.cron, "*/5 * * * *");
  assert.equal(heartbeat.mode, "internal_paper_only");
  assert.equal(heartbeat.liveOrdersAllowed, false);
  assert.equal(heartbeat.skipped, "autopilot_disabled");
  assert.ok(Date.parse(heartbeat.at) > 0);
  assert.ok(Date.parse(heartbeat.completedAt) >= Date.parse(heartbeat.at));
});

test("autopilot scheduler ignores unrelated cron expressions", () => {
  const waits: Promise<unknown>[] = [];
  const scheduled = scheduleAgentAutopilot("* * * * *", {} as any, { fetch: () => { throw new Error("must not call"); } }, { waitUntil(p: Promise<unknown>) { waits.push(p); } });
  assert.equal(scheduled, false);
  assert.equal(waits.length, 0);
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

test("autopilot preserves classified analysis failures and skips downstream calls", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  const calls: string[] = [];
  const app = { fetch: async (req: Request) => {
    const path = new URL(req.url).pathname; calls.push(path);
    return Response.json({ error: "market_data_unavailable", detail: ["bybit:timeout"], submitsOrder: false }, { status: 503 });
  } };
  const result = await runAgentAutopilotCycle(env, app, 2_250_000);
  assert.equal(result.submitted, 0);
  assert.equal(calls.length, 1, "failed council preflight must short-circuit FVG and strategy calls");
  assert.equal(result.outcomes[0].reason, "agent_analysis_unavailable");
  assert.deepEqual(result.outcomes[0].analysisFailure, { httpStatus: 503, error: "market_data_unavailable", detail: ["bybit:timeout"], dataQuality: null });
  assert.equal(result.outcomes[0].downstreamChecksSkipped, true);
});

test("autopilot records council abstention diagnostics and skips downstream gates", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  const calls: string[] = [];
  const app = { fetch: async (req: Request) => {
    const path = new URL(req.url).pathname; calls.push(path);
    return Response.json({
      decision: { action: "NO_TRADE", confidence: 0, consensus: { direction: "short", agreement: -0.668, coverage: 0.8, participating: ["quant","technical","crypto"], abstaining: [] }, proposal: null, vetoedBy: null, rationale: ["Consensus favoured SELL but no valid proposal could be built (ATR unavailable); standing aside."] },
      deliberation: { direction: "short", agreement: -0.668, reason: "Weighted agreement -0.67 ≤ -0.35.", coverage: 0.8, participating: ["quant","technical","crypto"], abstaining: [] },
      risk: null, security: { severity: "none" }, auditPersistence: "d1", dataQuality: { provider: "bybit", candles: 300, orderBook: "rest_snapshot" },
      reports: [{ agent: "technical", status: "ok", stance: "bearish", confidence: 0.8, summary: "Technical bearish", missingInputs: [] }],
    });
  } };
  const result = await runAgentAutopilotCycle(env, app, 2_550_000);
  assert.equal(result.submitted, 0);
  assert.deepEqual(calls, ["/api/agents/analyze"], "no FVG/Omnisignal requests should follow a council NO_TRADE");
  assert.equal(result.outcomes[0].reason, "agent_council_or_risk_gate_not_met");
  assert.equal(result.outcomes[0].councilDiagnostics.deliberation.direction, "short");
  assert.equal(result.outcomes[0].councilDiagnostics.proposalAvailable, false);
  assert.match(result.outcomes[0].councilDiagnostics.rationale[0], /ATR unavailable/);
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
  assert.equal(calls.length, 1, "low-confidence council must short-circuit downstream gates");
  assert.equal(calls[0], "/api/agents/analyze");
  assert.equal(result.outcomes[0].status, "no_trade");
  assert.equal(result.outcomes[0].downstreamChecksSkipped, true);
});

test("autopilot idempotency claim prevents duplicate symbol-slot runs", async () => {
  const kv = memoryKV();
  const env: any = { ETI_AGENT_AUTOPILOT_ENABLED: "true", ETI_AGENT_AUTOPILOT_SYMBOLS: "BTCUSDT", ETI_EXECUTION_TOKEN: "master-token", ETI_EXECUTION_LOG: kv, ETI_PAPER_START_BALANCE: "10000" };
  let calls = 0;
  const app = { fetch: async (req: Request) => { calls++; const path = new URL(req.url).pathname; if (path === "/api/analysis/liquidity-fvg") return Response.json({ autopilotEligible: true, direction: "BUY", score: 91, safety: { submitsOrder: false, bypassesRiskManager: false }, blocks: [] }); return path === "/api/omnisignal" ? Response.json({ decision: "HOLD", tradeable: false, confidence: 20, validation: { hardFailures: [] } }) : Response.json({ decision: { action: "NO_TRADE" } }); } };
  const now = 2_400_000;
  await runAgentAutopilotCycle(env, app, now);
  const second = await runAgentAutopilotCycle(env, app, now);
  assert.equal(calls, 1, "a NO_TRADE council result must not call downstream gates");
  assert.equal(second.outcomes[0].reason, "already_processed_this_slot");
});
