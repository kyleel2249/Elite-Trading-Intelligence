import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_IDS, AGENT_ROSTER, makeReport, noData, validateReport } from "./types.ts";
import type { Depth, Integrity, Kline, MarketInput } from "./types.ts";
import { buildProposal } from "./analysts.ts";
import { fundamentalAnalyst } from "./fundamental.ts";
import { evaluateDecision, riskManager, securityAnalyst } from "./controls.ts";
import type { DecisionRecord } from "./controls.ts";
import { deliberate, finalize } from "./commander.ts";
import { analyze } from "./orchestrator.ts";
import { mergeSupplied, withAgents } from "./route.ts";
import { applyFilters, parseBinanceFilters } from "./filters.ts";
import { filterForAsset, parseFred, parseRss, valueDaysBefore, baseOf } from "./providers.ts";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function candles(n: number, drift: number, noise: number, seed = 7): Kline[] {
  const rnd = lcg(seed), out: Kline[] = []; let prev = 100;
  for (let i = 0; i < n; i++) {
    const c = prev * (1 + drift + noise * (rnd() - 0.5)), o = prev;
    out.push([NOW - 600_000 - (n - 1 - i) * 3_600_000, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, 1000 + rnd() * 200]); prev = c;
  }
  return out;
}
const depthAround = (p: number): Depth => ({
  bids: Array.from({ length: 30 }, (_, i) => [p * (1 - 0.0004 - i * 0.0004), 50] as [number, number]),
  asks: Array.from({ length: 30 }, (_, i) => [p * (1 + 0.0004 + i * 0.0004), 50] as [number, number]),
});
const market = (cs: Kline[]): MarketInput => ({ symbol: "BTCUSDT", interval: "1h", candles: cs, depth: depthAround(cs[cs.length - 1][4]), provider: "test", fetchedAt: NOW, crossCheck: null, benchmark: null, failures: {} });
const integrity: Integrity = { killSwitch: false, liveTradingEnabled: false, liveCapsConfigured: false, riskGateConfigured: true, executionTokenConfigured: true, auditLogConfigured: true };
const account = { equityUsd: 100_000, dailyPnlPct: 0, drawdownPct: 1, openRiskPct: 0 };

test("roster has the 12 specified agents in order", () => {
  assert.equal(AGENT_ROSTER.length, 12);
  assert.deepEqual(AGENT_ROSTER.map((a) => a.id), [...AGENT_IDS]);
  assert.equal(AGENT_ROSTER[0].name, "ETI COMMANDER"); assert.equal(AGENT_ROSTER[11].name, "FRAUD AND SECURITY ANALYST");
});

test("report schema validation accepts valid and rejects malformed reports", () => {
  assert.deepEqual(validateReport(makeReport("quant", { summary: "x", confidence: 0.5 })), []);
  assert.ok(validateReport({ schema: "eti.agent.report/1", agent: "nobody" }).length > 0);
  assert.ok(validateReport(null).length > 0);
  assert.equal(noData("macro", "none", ["macro"]).stance, "no_data");
});

test("full analysis yields 12 valid structured reports and never allows live execution", () => {
  const r = analyze({ market: market(candles(300, 0.002, 0.004)), integrity, account, now: NOW, id: "t-1" });
  assert.equal(r.reports.length, 12);
  assert.deepEqual(r.reports.map((x) => x.agent), [...AGENT_IDS]);
  for (const rep of r.reports) assert.deepEqual(validateReport(rep), [], rep.agent);
  assert.equal(r.decision.liveExecutionAllowed, false);
  assert.ok(r.messages.length >= 9 && r.messages.every((m) => m.schema === "eti.agent.message/1"));
  assert.equal(r.reports.find((x) => x.agent === "fundamental")!.status, "insufficient_data");
  assert.equal(r.reports.find((x) => x.agent === "news")!.status, "insufficient_data");
  if (r.risk && !r.risk.approved) { assert.equal(r.decision.action, "NO_TRADE"); assert.equal(r.decision.executionEligible, false); assert.equal(r.decision.vetoedBy, "risk"); }
  if (r.decision.action !== "NO_TRADE") assert.equal(r.risk!.approved, true);
});

test("technical agent reads a persistent uptrend as bullish", () => {
  const r = analyze({ market: market(candles(300, 0.002, 0.004)), integrity, account, now: NOW });
  assert.equal(r.reports.find((x) => x.agent === "technical")!.stance, "bullish");
});

test("risk manager approves/reduces a sane trade and sizes within limits", () => {
  const cs = candles(300, 0.002, 0.004), m = market(cs), proposal = buildProposal("BTCUSDT", "buy", cs)!;
  const r = riskManager({ proposal, market: m, account, integrity, security: { severity: "none" }, hazard: null, now: NOW });
  assert.equal(r.approved, true, JSON.stringify(r.vetoes));
  assert.ok(r.sizing && r.sizing.quantity > 0 && r.sizing.notionalUsd <= 20_000 + 1 && r.sizing.riskPctOfEquity <= 1 + 1e-9);
});

test("risk manager vetoes: kill switch, missing account, event hazard, high security severity, stale data", () => {
  const cs = candles(300, 0.002, 0.004), m = market(cs), proposal = buildProposal("BTCUSDT", "buy", cs)!, base = { proposal, market: m, account, integrity, security: { severity: "none" as const }, hazard: null, now: NOW };
  assert.ok(riskManager({ ...base, integrity: { ...integrity, killSwitch: true } }).vetoes.includes("kill_switch"));
  assert.ok(riskManager({ ...base, account: undefined }).vetoes.includes("account_state"));
  assert.ok(riskManager({ ...base, hazard: { active: true, events: [{ name: "FOMC", minutesUntil: 20, impact: "high" }] } }).vetoes.includes("event_hazard"));
  assert.ok(riskManager({ ...base, security: { severity: "high" } }).vetoes.includes("security_severity"));
  assert.ok(riskManager({ ...base, now: NOW + 10 * 3_600_000 }).vetoes.includes("data_fresh"));
  assert.equal(riskManager({ ...base, account: undefined }).sizing, null);
});

test("risk veto overrides a unanimous bullish consensus and is explained", () => {
  const mk = (a: any, c: number) => makeReport(a, { stance: "bullish", confidence: c, summary: a + " bullish" });
  const reports = [mk("technical", 0.9), mk("quant", 0.8), mk("researcher", 0.6), makeReport("crypto", { stance: "neutral", confidence: 0.2, summary: "crypto flat" })];
  const d = deliberate(reports, null); assert.equal(d.direction, "long");
  const cs = candles(300, 0.002, 0.004), proposal = buildProposal("BTCUSDT", "buy", cs)!;
  const risk = riskManager({ proposal, market: market(cs), account, integrity: { ...integrity, killSwitch: true }, security: { severity: "none" }, hazard: null, now: NOW });
  const f = finalize({ id: "x", deliberation: d, proposal, risk, securitySeverity: "none" });
  assert.equal(f.action, "NO_TRADE"); assert.equal(f.vetoedBy, "risk"); assert.equal(f.executionEligible, false);
  assert.ok(f.disagreements.some((x) => x.topic === "risk_veto"));
});

test("Commander surfaces conflicting analyst opinions instead of hiding them", () => {
  const reports = [
    makeReport("quant", { stance: "bearish", confidence: 0.7, summary: "negative drift" }), makeReport("technical", { stance: "bullish", confidence: 0.7, summary: "uptrend" }),
    makeReport("crypto", { stance: "neutral", confidence: 0.2, summary: "flat" }), makeReport("researcher", { stance: "neutral", confidence: 0.3, summary: "mixed" }),
    noData("fundamental", "none", ["f"]), noData("macro", "none", ["m"]), noData("news", "none", ["n"]),
  ];
  const d = deliberate(reports, null);
  assert.equal(d.direction, "none"); assert.equal(d.disputes.length, 1);
  const text = JSON.stringify(d.disputes[0]); assert.match(text, /quant/); assert.match(text, /technical/);
  assert.equal(d.abstaining.length, 3); assert.equal(d.dissent.length, 2);
});

test("too few participating agents yields no consensus", () => {
  const d = deliberate([makeReport("quant", { stance: "bullish", confidence: 0.9, summary: "x" }), makeReport("technical", { stance: "bullish", confidence: 0.9, summary: "y" })], null);
  assert.equal(d.direction, "none");
});

test("security analyst flags provider disagreement and unsafe live configuration", () => {
  const cs = candles(300, 0.002, 0.004), m = market(cs), last = cs[cs.length - 1][4];
  const s = securityAnalyst({ market: { ...m, crossCheck: { provider: "other", price: last * 1.03 } }, supplied: {}, now: NOW, integrity: { ...integrity, liveTradingEnabled: true } });
  assert.equal(s.severity, "critical");
  assert.ok(s.flags.some((f) => f.id === "provider_price_disagreement") && s.flags.some((f) => f.id === "live_without_caps"));
});

test("performance auditor replays outcomes stop-first", () => {
  const rec: DecisionRecord = { schema: "eti.agent.decision/1", id: "r1", at: new Date(1_000_000).toISOString(), symbol: "BTCUSDT", interval: "1h", action: "BUY", confidence: 0.5, entry: 100, stop: 98, targets: [102, 104, 106], riskDecision: "approve", stances: {}, disputes: 0, vetoedBy: null };
  const fill: Kline = [2_000_000, 100, 100.5, 99, 100, 1];
  assert.equal(evaluateDecision(rec, [fill, [3_000_000, 100, 104.5, 97.5, 100, 1]]).status, "loss");
  const w = evaluateDecision(rec, [fill, [3_000_000, 100, 104.5, 99.5, 104, 1]]); assert.equal(w.status, "win"); assert.equal(w.rMultiple, 2);
  assert.equal(evaluateDecision(rec, [[2_000_000, 105, 106, 104, 105, 1]]).status, "unfilled");
  assert.equal(evaluateDecision({ ...rec, action: "NO_TRADE" }, [fill]).status, "not_applicable");
});

test("exchange filters: rounding, minimums, and fail-closed parsing", () => {
  const f = { stepSize: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 10 };
  const b = applyFilters({ side: "buy", quantity: 0.12345, limitPrice: 100.456 }, f);
  assert.ok(b.ok); if (b.ok) { assert.equal(b.quantity, 0.123); assert.equal(b.limitPrice, 100.45); assert.equal(b.adjustments.length, 2); }
  const s = applyFilters({ side: "sell", quantity: 0.5, limitPrice: 100.456 }, f);
  assert.ok(s.ok); if (s.ok) assert.equal(s.limitPrice, 100.46);
  assert.deepEqual(applyFilters({ side: "buy", quantity: 0.05, limitPrice: 100 }, f), { ok: false, reason: "below_min_notional" });
  assert.deepEqual(applyFilters({ side: "buy", quantity: 0.0004, limitPrice: 100 }, f), { ok: false, reason: "quantity_or_price_rounds_to_zero" });
  assert.equal(parseBinanceFilters({}), null);
  const parsed = parseBinanceFilters({ symbols: [{ filters: [{ filterType: "LOT_SIZE", minQty: "0.001", maxQty: "9000", stepSize: "0.001" }, { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" }, { filterType: "NOTIONAL", minNotional: "5" }] }] });
  assert.equal(parsed?.stepSize, 0.001); assert.equal(parsed?.minNotional, 5);
});

test("providers: RSS parsing, asset filtering, FRED helpers, symbol base", () => {
  const xml = "<rss><channel><item><title><![CDATA[Bitcoin ETF inflows surge]]></title><pubDate>Mon, 09 Nov 2026 11:00:00 GMT</pubDate></item><item><title>Unrelated gadget news</title><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate></item><item><title>No date item</title></item></channel></rss>";
  const items = parseRss(xml, "Test");
  assert.equal(items.length, 2); assert.equal(items[0].headline, "Bitcoin ETF inflows surge"); assert.equal(items[0].publishedAt, "2026-11-09T11:00:00.000Z");
  assert.equal(filterForAsset(items, ["bitcoin"], "BTC").length, 1);
  const obs = parseFred({ observations: [{ date: "2026-11-01", value: "2.0" }, { date: "2026-10-20", value: "." }, { date: "2026-10-01", value: "1.5" }] });
  assert.equal(obs.length, 2); assert.equal(valueDaysBefore(obs, 30)?.value, 1.5); assert.equal(valueDaysBefore(obs, 400), undefined);
  assert.equal(baseOf("ETHUSDT"), "ETH"); assert.equal(baseOf("SOLBTC"), "SOL");
});

test("fundamental agent can form a view from provider tokenomics alone, and abstains without data", () => {
  const cs = candles(300, 0.002, 0.004), ctx = { market: market(cs), supplied: {}, now: NOW, integrity };
  assert.equal(fundamentalAnalyst(ctx).status, "insufficient_data");
  const r = fundamentalAnalyst({ ...ctx, supplied: { fundamentals: { tokenomics: { marketCapUsd: 1e9, fdvUsd: 4e9, circulatingSupply: 40, totalSupply: 100 } } } });
  assert.equal(r.status, "ok"); assert.equal(r.stance, "bearish");
});

test("caller-supplied data wins over provider data", () => {
  const m = mergeSupplied({ macro: { a: 1 }, news: { items: [] } }, { macro: { b: 2 } });
  assert.deepEqual(m.macro, { b: 2 }); assert.deepEqual(m.news, { items: [] });
});

test("routes: dashboard, roster, providers feed agents, auth, and structural veto on execute", async () => {
  let baseCalls = 0, brokerCalls = 0;
  const base = { fetch: () => { baseCalls++; return new Response("base"); } };
  const cs = candles(300, 0.002, 0.004), fresh = (h: string) => ({ headline: h, source: "T", publishedAt: new Date(NOW - 3_600_000).toISOString() });
  const status = [{ provider: "rss:T", ok: true, latencyMs: 1, fetchedAt: new Date(NOW).toISOString(), items: 2 }];
  const app = withAgents(base as any, {
    loadMarket: async () => market(cs), now: () => NOW,
    loadProviders: async () => ({ supplied: { news: { items: [fresh("Bitcoin ETF inflows surge"), fresh("Bitcoin rally continues")] } }, status }),
    loadAccount: async () => ({}), loadFilters: async () => null,
  });
  const env: any = { ETI_EXECUTION_TOKEN: "x".repeat(32), ETI_RISK_GATE_URL: "https://example.invalid", ETI_RISK_GATE_TOKEN: "t" };
  const realFetch = globalThis.fetch; globalThis.fetch = (async () => { brokerCalls++; return new Response("{}"); }) as any;
  try {
    assert.equal(await (await app.fetch(new Request("https://e.test/other"), env)).text(), "base"); assert.equal(baseCalls, 1);
    const page = await app.fetch(new Request("https://e.test/agents"), env); assert.equal(page.status, 200); assert.match(await page.text(), /ETI Agent Intelligence Center/);
    const roster: any = await (await app.fetch(new Request("https://e.test/api/agents"), env)).json(); assert.equal(roster.agents.length, 12); assert.equal(roster.liveExecutionAllowed, false);
    const a: any = await (await app.fetch(new Request("https://e.test/api/agents/analyze?symbol=BTCUSDT&interval=1h"), env)).json();
    assert.equal(a.reports.length, 12); assert.deepEqual(a.providers, status); assert.equal(a.reports.find((x: any) => x.agent === "news").status, "ok");
    const off: any = await (await app.fetch(new Request("https://e.test/api/agents/analyze?symbol=BTCUSDT&providers=0"), env)).json();
    assert.equal(off.reports.find((x: any) => x.agent === "news").status, "insufficient_data"); assert.deepEqual(off.providers, []);
    assert.equal((await app.fetch(new Request("https://e.test/api/agents/analyze?symbol=bad!"), env)).status, 400);
    assert.equal((await app.fetch(new Request("https://e.test/api/agents/execute", { method: "POST", body: "{}" }), env)).status, 401);
    const body = JSON.stringify({ symbol: "BTCUSDT", interval: "1h", execution: { broker: "binance", clientOrderId: "test-order-0001", riskConfirmed: true } });
    const res = await app.fetch(new Request("https://e.test/api/agents/execute", { method: "POST", headers: { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN }, body }), env);
    const j: any = await res.json(); assert.equal(res.status, 409); assert.equal(j.error, "blocked_by_agents");
    assert.equal(brokerCalls, 0, "no broker/risk-gate call may occur when blocked (no account state supplied)");
  } finally { globalThis.fetch = realFetch; }
});
