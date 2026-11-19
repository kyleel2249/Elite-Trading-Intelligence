import test from "node:test";
import assert from "node:assert/strict";
import { agentRuntimeStatus } from "./health.ts";

test("runtime inventory reports deterministic agents and advisory-only LLM status", () => {
  const status = agentRuntimeStatus({});
  assert.equal(status.orchestration.agentCount, 12);
  assert.equal(status.orchestration.decisionModel, "deterministic_specialist_modules");
  assert.equal(status.orchestration.llmAssistance, "not_configured");
  assert.equal(status.autopilot.liveOrdersAllowed, false);
  assert.equal(status.bitget.agentCouncilExecutionIntegrated, false);
});

test("Bitget gateway readiness requires all independent safety prerequisites", () => {
  const base = {
    ETI_BITGET_LIVE_ENABLED: "true",
    ETI_BITGET_EGRESS_VERIFIED: "true",
    BITGET_API_KEY: "key",
    BITGET_API_SECRET: "secret",
    BITGET_API_PASSPHRASE: "passphrase",
    ETI_EXECUTION_LOG: {},
  };
  assert.equal(agentRuntimeStatus(base).bitget.gatewayPreflightReady, true);
  assert.equal(agentRuntimeStatus({ ...base, ETI_KILL_SWITCH: "true" }).bitget.gatewayPreflightReady, false);
  assert.equal(agentRuntimeStatus({ ...base, ETI_BITGET_EGRESS_VERIFIED: "false" }).bitget.gatewayPreflightReady, false);
  assert.equal(agentRuntimeStatus({ ...base, BITGET_API_SECRET: "" }).bitget.gatewayPreflightReady, false);
});

test("runtime status identifies the actual Worker provider order and paper-only autopilot", () => {
  const status = agentRuntimeStatus({
    MARKET_PROVIDER_ORDER: "bybit,bitget",
    ETI_AGENT_AUTOPILOT_ENABLED: "true",
    ETI_EXECUTION_TOKEN: "configured",
    ETI_EXECUTION_LOG: {},
    ETI_PORTFOLIO_DB: {},
  });
  assert.deepEqual(status.marketData.workerProviderOrder, ["bybit", "bitget"]);
  assert.equal(status.marketData.bitgetServerSideScheduledAnalysis, false);
  assert.equal(status.autopilot.enabled, true);
  assert.equal(status.autopilot.mode, "internal_paper_only");
  assert.equal(status.autopilot.liveOrdersAllowed, false);
});


test("LLM review readiness requires the provider key, bearer token and KV usage binding", () => {
  const configured = { ANTHROPIC_API_KEY: "key", ETI_EXECUTION_TOKEN: "token", ETI_EXECUTION_LOG: {} };
  const ready = agentRuntimeStatus(configured);
  assert.equal(ready.orchestration.llmAssistance, "configured_advisory_only");
  assert.equal(ready.orchestration.llmReviewReady, true);
  assert.deepEqual(ready.orchestration.llmReviewBlockers, []);
  const missingKv = agentRuntimeStatus({ ANTHROPIC_API_KEY: "key", ETI_EXECUTION_TOKEN: "token" });
  assert.equal(missingKv.orchestration.llmReviewReady, false);
  assert.deepEqual(missingKv.orchestration.llmReviewBlockers, ["execution_kv_binding_missing"]);
});
