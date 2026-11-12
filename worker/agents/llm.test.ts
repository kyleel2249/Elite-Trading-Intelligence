import test from "node:test";
import assert from "node:assert/strict";
import { buildBriefInput, parseBrief, requestBrief, SYSTEM_PROMPT } from "./llm.ts";
import { withLlmBrief } from "./llm-route.ts";
import { analyze } from "./orchestrator.ts";
import type { Depth, Integrity, Kline, MarketInput } from "./types.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function candles(n: number): Kline[] { const rnd = lcg(7), out: Kline[] = []; let prev = 100; for (let i = 0; i < n; i++) { const c = prev * (1 + 0.002 + 0.004 * (rnd() - 0.5)); out.push([NOW - 600_000 - (n - 1 - i) * 3_600_000, prev, Math.max(prev, c) * 1.001, Math.min(prev, c) * 0.999, c, 1000 + rnd() * 200]); prev = c; } return out; }
const depthAround = (p: number): Depth => ({ bids: Array.from({ length: 30 }, (_, i) => [p * (1 - 0.0004 - i * 0.0004), 50] as [number, number]), asks: Array.from({ length: 30 }, (_, i) => [p * (1 + 0.0004 + i * 0.0004), 50] as [number, number]) });
const cs = candles(300);
const market: MarketInput = { symbol: "BTCUSDT", interval: "1h", candles: cs, depth: depthAround(cs[cs.length - 1][4]), provider: "test", fetchedAt: NOW, crossCheck: null, benchmark: null, failures: {} };
const integrity: Integrity = { killSwitch: false, liveFlagSet: false, executionTokenConfigured: true, auditLogConfigured: true };
const analysis = () => analyze({ market, integrity, account: { equityUsd: 100_000, dailyPnlPct: 0, drawdownPct: 1, openRiskPct: 0 }, now: NOW, id: "llm-1" });

const goodBrief = { summary: "Evidence is thin outside price data.", agentNotes: [{ agent: "technical", assessment: "Trend aligned.", concern: "No volume confirmation." }, { agent: "not_an_agent", assessment: "x" }], contradictions: ["quant vs technical"], weakEvidence: ["no news"], verifyNext: ["check calendar"], evidenceStrength: "low", extra: "dropped" };
const modelReply = (text: string, status = 200) => new Response(JSON.stringify(status === 200 ? { content: [{ type: "text", text }], model: "claude-sonnet-5-5", usage: { input_tokens: 111, output_tokens: 22 } } : { error: { message: "secret detail" } }), { status });

test("brief parsing is strict: schema enforced, unknown keys and unknown agents dropped, junk rejected", () => {
  const b = parseBrief("Here you go:\n" + JSON.stringify(goodBrief));
  assert.ok(b); assert.equal(b!.agentNotes.length, 1); assert.equal(b!.agentNotes[0].agent, "technical"); assert.equal((b as any).extra, undefined); assert.equal(b!.evidenceStrength, "low");
  assert.equal(parseBrief("no json here"), null); assert.equal(parseBrief("{not json}"), null);
  assert.equal(parseBrief(JSON.stringify({ ...goodBrief, evidenceStrength: "certain" })), null); assert.equal(parseBrief(JSON.stringify({ ...goodBrief, summary: 5 })), null);
  assert.equal(parseBrief(JSON.stringify({ ...goodBrief, summary: "x".repeat(5000) }))!.summary.length, 900);
});

test("the model is sent untrusted-data instructions and the analysis, with the API key only in the header", async () => {
  let seen: any = null;
  const r = await requestBrief({ ANTHROPIC_API_KEY: "sk-secret-123" }, analysis(), (async (u: any, init: any) => { seen = { u: String(u), init, body: JSON.parse(init.body) }; return modelReply(JSON.stringify(goodBrief)); }) as any);
  assert.ok(r.ok); if (r.ok) { assert.equal(r.model, "claude-sonnet-5-5"); assert.equal(r.usage.inputTokens, 111); assert.ok(!JSON.stringify(r).includes("sk-secret-123")); }
  assert.equal(seen.u, "https://api.anthropic.com/v1/messages"); assert.equal(seen.init.headers["x-api-key"], "sk-secret-123"); assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.body.model, "claude-sonnet-5-5"); assert.equal(seen.body.system, SYSTEM_PROMPT); assert.match(SYSTEM_PROMPT, /untrusted/); assert.match(SYSTEM_PROMPT, /Do not recommend buying or selling/);
  assert.ok(!("tools" in seen.body), "the reviewer has no tools"); assert.ok(!seen.body.messages[0].content.includes("sk-secret-123"));
  const doc = JSON.parse(seen.body.messages[0].content.split("\n").slice(1).join("\n")); assert.equal(doc.agents.length, 12); assert.equal(doc.commanderDecision.action, analysis().decision.action);
  assert.equal(buildBriefInput(analysis()).agents.length, 12);
});

test("failures are reported without leaking provider detail, and nothing is sent without a key", async () => {
  let calls = 0; const f = (async () => { calls++; return modelReply("x"); }) as any;
  assert.deepEqual(await requestBrief({}, analysis(), f), { ok: false, error: "llm_not_configured" }); assert.equal(calls, 0);
  const http = await requestBrief({ ANTHROPIC_API_KEY: "k" }, analysis(), (async () => modelReply("", 529)) as any); assert.deepEqual(http, { ok: false, error: "llm_http_error", status: 529 });
  assert.deepEqual(await requestBrief({ ANTHROPIC_API_KEY: "k" }, analysis(), (async () => modelReply("I would buy now.")) as any), { ok: false, error: "invalid_model_output" });
  assert.deepEqual(await requestBrief({ ANTHROPIC_API_KEY: "k" }, analysis(), (async () => { throw new TypeError("net"); }) as any), { ok: false, error: "llm_unreachable" });
});

test("route: bearer, key, KV and hourly cap are enforced before any spend; success leaves the decision untouched", async () => {
  const kv = new Map<string, string>(); let llmCalls = 0;
  const mk = (env: any) => withLlmBrief({ fetch: () => new Response("base") } as any, { loadMarket: async () => market, loadProviders: async () => ({ supplied: {}, status: [] }), now: () => NOW, fetchImpl: (async () => { llmCalls++; return modelReply(JSON.stringify(goodBrief)); }) as any }).fetch.bind(null) as any;
  const app = withLlmBrief({ fetch: () => new Response("base") } as any, { loadMarket: async () => market, loadProviders: async () => ({ supplied: {}, status: [] }), now: () => NOW, fetchImpl: (async () => { llmCalls++; return modelReply(JSON.stringify(goodBrief)); }) as any });
  const env: any = { ETI_EXECUTION_TOKEN: "x".repeat(32), ANTHROPIC_API_KEY: "sk-secret-123", ETI_LLM_MAX_PER_HOUR: "1", ETI_EXECUTION_LOG: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } } };
  const req = (token: string | null = env.ETI_EXECUTION_TOKEN, method = "POST") => new Request("https://e.test/api/agents/brief", { method, headers: token ? { authorization: "Bearer " + token } : {}, body: method === "POST" ? JSON.stringify({ symbol: "BTCUSDT" }) : undefined });
  void mk;
  assert.equal(await (await app.fetch(new Request("https://e.test/other"), env)).text(), "base");
  assert.equal((await app.fetch(req(null), env)).status, 401); assert.equal((await app.fetch(req("y".repeat(32)), env)).status, 401); assert.equal((await app.fetch(req(env.ETI_EXECUTION_TOKEN, "GET"), env)).status, 405);
  assert.equal((await app.fetch(req(), { ...env, ANTHROPIC_API_KEY: undefined })).status, 503); assert.equal((await app.fetch(req(), { ...env, ETI_EXECUTION_LOG: undefined })).status, 503);
  assert.equal(llmCalls, 0, "nothing was spent on refused requests");
  const ok = await app.fetch(req(), env), j: any = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(j)); assert.equal(j.advisory, true); assert.equal(j.brief.evidenceStrength, "low"); // the route has no account state, so the Risk Manager cannot approve a position: compare with the same inputs, not the account-supplied helper
  const same = analyze({ market, integrity: { killSwitch: false, liveFlagSet: false, executionTokenConfigured: true, auditLogConfigured: true }, now: NOW });
  assert.equal(j.decision.action, same.decision.action); assert.equal(j.decision.confidence, same.decision.confidence);
  assert.ok(!JSON.stringify(j).includes("sk-secret-123")); assert.equal(llmCalls, 1);
  const capped = await app.fetch(req(), env); assert.equal(capped.status, 429); assert.equal(((await capped.json()) as any).error, "llm_hourly_cap_reached"); assert.equal(llmCalls, 1);
});
