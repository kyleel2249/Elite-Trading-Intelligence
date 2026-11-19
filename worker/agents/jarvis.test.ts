import test from "node:test";
import assert from "node:assert/strict";
import { parseJarvisCommand, searchJarvisWeb, withJarvis } from "./jarvis.ts";

test("JARVIS routes natural-language market requests to the existing council", () => {
  assert.deepEqual(parseJarvisCommand("Please analyse ETHUSDT on 15m"), {
    intent: "analyze", symbol: "ETHUSDT", interval: "15m", message: "Please analyse ETHUSDT on 15m",
  });
});

test("an explicit trading symbol and timeframe are enough to request analysis", () => {
  assert.equal(parseJarvisCommand("BTCUSDT 15m").intent, "analyze");
});

test("JARVIS recognizes internet research requests", () => {
  assert.equal(parseJarvisCommand("Search the internet for latest Bitcoin ETF news").intent, "web_search");
  assert.equal(parseJarvisCommand("Look up current ETH regulation").intent, "web_search");
});

test("JARVIS recognizes status, audit and explicit deep-review intents", () => {
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

test("JARVIS analysis explains missing setup, account veto and verification gaps", async () => {
  const env: any = {
    ETI_EXECUTION_TOKEN: "jarvis-test-token",
    ETI_EXECUTION_LOG: { async get() { return null; }, async put() {} },
  };
  const analysis = {
    symbol: "BTCUSDT", interval: "1h", generatedAt: "2026-11-19T03:47:33.246Z",
    decision: { action: "NO_TRADE", rationale: ["Risk veto"], proposal: null },
    deliberation: { direction: "short", agreement: -0.71 },
    reports: [{ agent: "technical", summary: "Technical bearish", evidence: [
      { label: "liquidity_fvg_autopilot_eligible", value: false },
      { label: "liquidity_fvg_direction", value: "WAIT" },
    ] }],
    risk: { vetoes: ["account_state"], checks: [{ id: "account_state", passed: false }, { id: "pnl_state_unknown", passed: false }] },
    security: {}, dataQuality: { priceCrossCheck: { status: "not_performed" } }, disclosures: [],
  };
  const app = withJarvis({ fetch: () => Response.json(analysis) });
  const res = await app.fetch(new Request("https://eti.test/api/agents/jarvis", {
    method: "POST", headers: { authorization: "Bearer jarvis-test-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "Analyse Bitcoin" }),
  }), env);
  const data: any = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.result.marketRead.entrySetup.status, "not_actionable");
  assert.equal(data.result.marketRead.entrySetup.entry, null);
  assert.equal(data.result.marketRead.accountState, "missing_or_unverified");
  assert.ok(data.result.nextSteps.some((x: string) => x.includes("account equity")));
  assert.ok(data.result.nextSteps.some((x: string) => x.includes("drawdown")));
  assert.equal(data.safety.riskVetoPreserved, true);
});

test("JARVIS web search normalizes results and rejects non-http URLs", async () => {
  const fakeFetch: any = async (url: string, init: any) => {
    assert.match(url, /api\.search\.brave\.com/);
    assert.equal(init.headers["x-subscription-token"], "test-key");
    return Response.json({ web: { results: [
      { title: "Bitcoin news", url: "https://example.com/story", description: "A useful <b>summary</b>" },
      { title: "Bad URL", url: "javascript:alert(1)", description: "ignore" },
    ] } });
  };
  const result = await searchJarvisWeb("latest Bitcoin news", "test-key", fakeFetch);
  assert.equal(result.status, "complete");
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].snippet, "A useful summary");
  assert.equal(result.results[0].source, "example.com");
});

test("JARVIS exposes web search as optional and reports missing provider configuration", async () => {
  const env: any = { ETI_EXECUTION_TOKEN: "jarvis-test-token" };
  const app = withJarvis({ fetch: () => Response.json({}) });
  const res = await app.fetch(new Request("https://eti.test/api/agents/jarvis", {
    method: "POST", headers: { authorization: "Bearer jarvis-test-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "Search the internet for Bitcoin ETF news" }),
  }), env);
  const data: any = await res.json();
  assert.equal(data.result.kind, "web_research_unavailable");
  assert.equal(data.result.status, "not_configured");
  assert.equal(data.safety.liveExecutionAllowed, false);
});
