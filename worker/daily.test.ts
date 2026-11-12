import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, tradingDayInfo, actionable, type AssetResult, type CollectedData, type ReadinessLite, type SetupLite } from "./daily/report.ts";
import { collectDailyData, parseStocks, pickStock, setupFromPrecision, setupFromSignal, budgetOf } from "./daily/collect.ts";
import { handleDailyReport, runDailyReportCycle, resetDailyMemo, keyFor } from "./daily/api.ts";
import { withDailyReport } from "./daily/route.ts";
import { signalFromCandles } from "./signals.ts";
import { series } from "./algo/fixtures.ts";

const NOW = Date.parse("2026-11-11T09:00:00Z"); // a Wednesday
const TITLES = ["Global market conditions", "Major economic developments", "Important upcoming announcements", "Forex market outlook", "Gold and commodities outlook", "Cryptocurrency outlook", "Stock market outlook", "Best researched opportunities", "Assets to avoid", "Expected volatility", "Market liquidity", "Trading-session recommendations", "High-risk periods", "Strongest validated strategy candidates", "Portfolio risk assessment", "Final market-readiness verdict"];

const readiness = (status: string, over: Partial<ReadinessLite> = {}): ReadinessLite => ({
  status, statusLabel: status.split("_").join(" "), recommendation: "", reasons: [], blockers: [], caps: [], evaluated: 9, notEvaluated: [], schedule: [], eventHits: [], closures: [], liveConditionsApplied: true, label: "next 2 hours",
  factors: [{ id: 2, factor: "Expected volatility", rating: "supportive", headline: "Volatility within its normal range", detail: [] }, { id: 3, factor: "Liquidity", rating: "supportive", headline: "Volume 1.10x baseline", detail: [] }, { id: 5, factor: "Current trends", rating: "supportive", headline: "Strong uptrend", detail: [] }, { id: 10, factor: "Spreads and execution", rating: "supportive", headline: "Spread 1.0 bps", detail: [] }],
  ...over,
});
const setup = (validated: boolean, dir: "BUY" | "SELL" = "BUY", over: Partial<SetupLite> = {}): SetupLite => ({
  source: "precision", direction: validated ? dir : "NO TRADE", lean: dir, validated, blockers: validated ? [] : ["Net reward-to-risk below minimum"], strategy: "intraday", timeframe: "15m", entry: 100, stop: 99, targets: [101, 102, 103], stopPct: 1,
  rewardRisk: 2.1, rewardRiskBasis: "net of estimated costs to TP3", score: 72, scoreBand: "strong", conviction: null, confidenceNote: "confidence is qualitative", winRate: null, samples: 0, atrPercent: 0.6, volatility: "normal", liquidity: "ok",
  invalidation: ["Close beyond 99"], expiresAt: null, asOf: null, costsIncluded: true, hardChecks: { passed: 18, failed: 0, notEvaluated: 0 }, ...over,
});
const asset = (key: AssetResult["key"], label: string, over: Partial<AssetResult> = {}): AssetResult => ({ key, label, instrument: label, market: key === "BTCUSD" ? "crypto" : key === "STOCK" ? "equities" : key === "XAUUSD" ? "commodity" : "forex", status: "evaluated", note: null, readiness: readiness("SELECTIVELY_FAVOURABLE"), setup: setup(false), price: { last: 100, asOf: "2026-11-11T08:00:00.000Z", provider: "test" }, ...over });
const data = (over: Partial<CollectedData> = {}): CollectedData => ({
  now: NOW, calendar: { status: "loaded", error: null, sources: ["test"], events: [{ title: "US CPI", impact: "high", category: "economic", time: "2026-11-11T13:30:00.000Z", currencies: ["USD"], markets: [], symbols: [] }, { title: "ECB speech", impact: "medium", category: "central_bank", time: "2026-11-11T05:00:00.000Z", currencies: ["EUR"], markets: [], symbols: [] }] },
  exchanges: [{ exchange: "NYSE", name: "NYSE/Nasdaq", open: false, reason: "before the open", next: { at: "2026-11-11T14:30:00.000Z", event: "opens" }, closureToday: null }],
  sessions: { crypto: [{ session: "london", label: "London", activeNow: true, status: "SELECTIVELY_FAVOURABLE", statusLabel: "SELECTIVELY FAVOURABLE", reason: "calendar clear" }], forex: [{ session: "london", label: "London", activeNow: true, status: "UNCERTAIN", statusLabel: "UNCERTAIN", reason: "CPI later today" }, { session: "sydney", label: "Sydney", activeNow: false, status: "HIGH_RISK", statusLabel: "HIGH RISK", reason: "thin" }] },
  assets: [asset("EURUSD", "EUR/USD"), asset("XAUUSD", "XAU/USD"), asset("BTCUSD", "BTC/USD"), asset("STOCK", "AAPL")], budget: { limit: 44, used: 42, deferred: [] }, riskPerTradePct: 0.5, ...over,
});

test("report has the 16 sections in the specified order and the opportunity table", () => {
  const r = buildDailyReport(data());
  assert.equal(r.title, "ETI GLOBAL MARKET INTELLIGENCE");
  assert.deepEqual(r.sections.map(s => s.title), TITLES);
  assert.deepEqual(r.sections.map(s => s.number), TITLES.map((_, i) => i + 1));
  assert.deepEqual(r.opportunities.map(o => o.asset), ["EUR/USD", "XAU/USD", "BTC/USD", "AAPL"]);
  assert.ok(r.dateTimeUtc.startsWith("2026-11-11 09:00 UTC (Wednesday)"));
  for (const s of r.sections) assert.ok(s.lines.length > 0);
});

test("only a validated setup carries BUY or SELL; everything else is NO TRADE or N/A", () => {
  const r = buildDailyReport(data({ assets: [
    asset("EURUSD", "EUR/USD", { setup: setup(false, "SELL") }),
    asset("XAUUSD", "XAU/USD", { status: "unavailable", readiness: null, setup: null, note: "No forex price feed is connected" }),
    asset("BTCUSD", "BTC/USD", { setup: setup(true, "BUY") }),
    asset("STOCK", "Selected stock", { status: "deferred", readiness: null, setup: null, note: "Skipped to stay inside the subrequest budget" }),
  ] }));
  const by = Object.fromEntries(r.opportunities.map(o => [o.asset, o]));
  assert.equal(by["EUR/USD"].direction, "NO TRADE");
  assert.equal(by["XAU/USD"].direction, "N/A");
  assert.equal(by["BTC/USD"].direction, "BUY");
  assert.equal(by["BTC/USD"].validated, true);
  assert.equal(by["Selected stock"].direction, "N/A");
  assert.match(by["XAU/USD"].verdict, /NOT ASSESSED/);
  assert.match(by["BTC/USD"].setup, /entry 100\.00000|entry 100\.000/);
  assert.match(by["EUR/USD"].setup, /unvalidated SELL lean/);
});

test("a HIGH RISK readiness verdict overrides a validated setup", () => {
  const a = asset("BTCUSD", "BTC/USD", { readiness: readiness("HIGH_RISK", { blockers: ["Unusually high volatility"] }), setup: setup(true) });
  assert.equal(actionable(a), false);
  const r = buildDailyReport(data({ assets: [asset("EURUSD", "EUR/USD"), asset("XAUUSD", "XAU/USD"), a, asset("STOCK", "AAPL")] }));
  assert.equal(r.opportunities[2].direction, "NO TRADE");
  assert.match(r.opportunities[2].verdict, /do not open new positions/);
  assert.ok(r.sections[8].lines.some(l => l.startsWith("BTC/USD: HIGH RISK")));
  assert.equal(r.finalVerdict.status, "HIGH_RISK");
});

test("final verdict is capped when data is incomplete and never positive without data", () => {
  const ok = buildDailyReport(data());
  assert.equal(ok.finalVerdict.status, "SELECTIVELY_FAVOURABLE");
  const noCal = buildDailyReport(data({ calendar: { status: "not_configured", error: null, sources: [], events: [] } }));
  assert.equal(noCal.finalVerdict.status, "UNCERTAIN");
  assert.match(noCal.finalVerdict.summary, /calendar unverified/);
  assert.match(noCal.sections[1].lines[0], /UNVERIFIED/);
  const partial = buildDailyReport(data({ assets: [asset("EURUSD", "EUR/USD", { status: "unavailable", readiness: null, setup: null }), asset("XAUUSD", "XAU/USD"), asset("BTCUSD", "BTC/USD"), asset("STOCK", "AAPL")] }));
  assert.equal(partial.finalVerdict.status, "UNCERTAIN");
  const none = buildDailyReport(data({ assets: data().assets.map(a => ({ ...a, status: "unavailable" as const, readiness: null, setup: null })) }));
  assert.equal(none.finalVerdict.status, "NOT_ASSESSED");
  assert.match(none.finalVerdict.summary, /Do not trade/);
  assert.equal(none.dataQuality.complete, false);
});

test("same-direction USD candidates are flagged as one exposure and risk is summed", () => {
  const r = buildDailyReport(data({ assets: [asset("EURUSD", "EUR/USD", { setup: setup(true, "BUY") }), asset("XAUUSD", "XAU/USD", { setup: setup(true, "BUY") }), asset("BTCUSD", "BTC/USD"), asset("STOCK", "AAPL")] }));
  const risk = r.sections[14].lines.join("\n");
  assert.match(risk, /Concentrated USD exposure: EUR\/USD and XAU\/USD/);
  assert.match(risk, /1\.00% of equity/);
});

test("high-risk periods use the readiness engine's blackout windows around high-impact events", () => {
  const r = buildDailyReport(data());
  const lines = r.sections[12].lines.join("\n");
  assert.match(lines, /US CPI at 2026-11-11 13:30 UTC: no-trade blackout 13:00-14:00 UTC, high-risk window 11:30-15:30 UTC/);
});

test("markdown follows the requested layout and escapes table pipes", () => {
  const a = asset("EURUSD", "EUR/USD", { note: "a|b" });
  const r = buildDailyReport(data({ assets: [a, asset("XAUUSD", "XAU/USD"), asset("BTCUSD", "BTC/USD"), asset("STOCK", "AAPL")] }));
  assert.ok(r.markdown.startsWith("# ETI GLOBAL MARKET INTELLIGENCE\n\n**Date and time:** 2026-11-11 09:00 UTC"));
  assert.ok(r.markdown.includes("## 16. Final market-readiness verdict"));
  assert.ok(r.markdown.includes("| Asset | Direction | Setup | Risk | ETI verdict |\n|---|---|---|---|---|"));
  for (const line of r.markdown.split("\n").filter(l => l.startsWith("| EUR/USD") || l.startsWith("| AAPL"))) assert.equal(line.split(" | ").length, 5);
});

test("trading-day note distinguishes weekdays from weekends", () => {
  assert.equal(tradingDayInfo(NOW).isTradingDay, true);
  const sat = tradingDayInfo(Date.parse("2026-11-14T09:00:00Z"));
  assert.equal(sat.isTradingDay, false);
  assert.match(sat.note, /only crypto trades/);
});

test("setupFromPrecision maps tradeable signals and failed gates", () => {
  const good = setupFromPrecision({ direction: "BUY", decision: { tradeable: true, reasons: [] }, entry: 100, stopLoss: 99, takeProfits: [{ price: 101 }, { price: 102 }, { price: 103 }], riskReward: { netToFinalTarget: 2.4, finalTarget: "TP3" }, opportunityScore: { value: 74, band: "strong" }, confidence: { type: "qualitative" }, strategy: "intraday", setupTimeframe: "15m", volatility: { atrPercent: 0.5, classification: "normal", stopPercent: 1 }, riskCheckSummary: { passed: 18, failed: 0, notEvaluated: 0 } });
  assert.equal(good.validated, true); assert.equal(good.direction, "BUY"); assert.deepEqual(good.targets, [101, 102, 103]); assert.equal(good.rewardRisk, 2.4); assert.match(good.confidenceNote, /qualitative/);
  const bad = setupFromPrecision({ direction: "NO TRADE", decision: { tradeable: false, reasons: ["Spread too wide"] }, riskChecks: [{ status: "fail", label: "Spread", detail: "12 bps" }, { status: "pass", label: "Stale data", detail: "" }] });
  assert.equal(bad.validated, false); assert.equal(bad.direction, "NO TRADE"); assert.equal(bad.lean, null); assert.deepEqual(bad.blockers, ["Spread: 12 bps", "Spread too wide"]);
  const noTradeFlag = setupFromPrecision({ direction: "BUY", decision: { tradeable: false, reasons: [] }, entry: 100, stopLoss: 99 });
  assert.equal(noTradeFlag.validated, false); assert.equal(noTradeFlag.lean, "BUY");
});

test("setupFromSignal never validates stale candles and stays internally consistent", () => {
  const end = NOW - 30 * 60_000;
  const rows = series(420, { drift: 1, noise: 2, start: 100, seed: 1, stepMs: 3_600_000, end });
  const built = signalFromCandles(rows, "TESTUSD", "fixture", "1h");
  assert.ok(built, "fixture must be long enough for the signal engine");
  const fresh = setupFromSignal(built!.signal, "1h", NOW);
  assert.equal(fresh.validated, fresh.blockers.length === 0);
  assert.equal(fresh.direction === "NO TRADE", !fresh.validated);
  assert.equal(fresh.costsIncluded, false);
  if (fresh.validated) assert.ok(fresh.winRate !== null && fresh.winRate > 50 && fresh.samples >= 20);
  const stale = setupFromSignal(built!.signal, "1h", NOW + 12 * 3_600_000);
  assert.equal(stale.validated, false);
  assert.ok(stale.blockers.some(b => /stale|old/.test(b)));
});

test("watchlist, budget and stock selection helpers", () => {
  assert.deepEqual(parseStocks(undefined), ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(parseStocks("tsla, bad symbol!, amzn, TSLA"), ["TSLA", "AMZN"]);
  assert.equal(budgetOf({}), 44); assert.equal(budgetOf({ ETI_DAILY_SUBREQUEST_BUDGET: "400" }), 400); assert.equal(budgetOf({ ETI_DAILY_SUBREQUEST_BUDGET: "3" }), 44);
  const a = asset("STOCK", "AAA", { readiness: readiness("UNCERTAIN"), setup: setup(false) }), b = asset("STOCK", "BBB", { readiness: readiness("SELECTIVELY_FAVOURABLE"), setup: setup(false) }), c = asset("STOCK", "CCC", { readiness: readiness("HIGH_RISK"), setup: setup(true) });
  assert.equal(pickStock([a, b])!.label, "BBB");
  assert.equal(pickStock([a, b, c])!.label, "CCC", "a validated setup is preferred over a better readiness verdict");
  assert.equal(pickStock([]), null);
});

test("collection degrades to explicit unavailable/partial results when no data source answers", { timeout: 60_000 }, async () => {
  const f = mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  try {
    const d = await collectDailyData({} as any, NOW);
    assert.equal(d.assets.length, 4);
    assert.deepEqual(d.assets.map(a => a.key), ["EURUSD", "XAUUSD", "BTCUSD", "STOCK"]);
    assert.ok(d.assets.every(a => a.status !== "evaluated"), "nothing may be called evaluated without live data");
    assert.ok(d.assets.every(a => !a.setup || !a.setup.validated), "no setup may validate without data");
    assert.equal(d.calendar.status, "not_configured");
    assert.equal(d.budget.used, 42); assert.deepEqual(d.budget.deferred, ["MSFT", "NVDA"]);
    const r = buildDailyReport(d);
    assert.equal(r.sections.length, 16);
    assert.ok(r.opportunities.every(o => o.direction === "N/A" || o.direction === "NO TRADE"));
    assert.notEqual(r.finalVerdict.status, "FAVOURABLE");
  } finally { f.mock.restore(); }
});

const fakeKv = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } } as any; };
const req = (path: string, method = "GET") => new Request(`https://eti.test${path}`, { method });

test("API returns the report, caches it, rate-limits refresh and validates input", async () => {
  resetDailyMemo(); let calls = 0, t = NOW;
  const deps = { collect: async () => { calls++; return data({ now: t }); }, now: () => t };
  const env: any = {};
  const r1 = await handleDailyReport(req("/api/daily-report"), env, deps), b1: any = await r1.json();
  assert.equal(r1.status, 200); assert.equal(b1.sections.length, 16); assert.equal(b1.cache.hit, false); assert.equal(calls, 1);
  assert.equal(r1.headers.get("access-control-allow-origin"), "*");
  const r2 = await handleDailyReport(req("/api/daily-report"), env, deps); assert.equal((await r2.json() as any).cache.hit, true); assert.equal(calls, 1);
  t += 30_000; const r3 = await handleDailyReport(req("/api/daily-report?refresh=1"), env, deps), b3: any = await r3.json();
  assert.equal(b3.cache.hit, true); assert.equal(b3.cache.refreshLimited, true); assert.equal(calls, 1);
  t += 61_000; const r4 = await handleDailyReport(req("/api/daily-report?refresh=1"), env, deps); assert.equal((await r4.json() as any).cache.hit, false); assert.equal(calls, 2);
  const md = await handleDailyReport(req("/api/daily-report?format=markdown"), env, deps);
  assert.equal(md.status, 200); assert.match(md.headers.get("content-type")!, /text\/plain/); assert.match(await md.text(), /^# ETI GLOBAL MARKET INTELLIGENCE/);
  assert.equal((await handleDailyReport(req("/api/daily-report?format=xml"), env, deps)).status, 400);
  assert.equal((await handleDailyReport(req("/api/daily-report?date=nope"), env, deps)).status, 400);
  assert.equal((await handleDailyReport(req("/api/daily-report?date=2026-11-10"), env, deps)).status, 404);
  assert.equal((await handleDailyReport(req("/api/daily-report", "POST"), env, deps)).status, 405);
  assert.equal((await handleDailyReport(req("/api/daily-report/nope"), env, deps)).status, 404);
  assert.equal((await handleDailyReport(req("/api/daily-report", "OPTIONS"), env, deps)).status, 204);
});

test("generation failures are reported, never papered over", async () => {
  resetDailyMemo();
  const res = await handleDailyReport(req("/api/daily-report"), {} as any, { collect: async () => { throw new Error("boom"); }, now: () => NOW });
  assert.equal(res.status, 502); const b: any = await res.json(); assert.equal(b.error, "report_generation_failed"); assert.match(b.detail, /boom/);
  assert.equal(b.sections, undefined);
});

test("reports are stored in KV, served by date, and the scheduler generates once per weekday", async () => {
  resetDailyMemo(); const kv = fakeKv(), env: any = { ETI_EXECUTION_LOG: kv }; let calls = 0;
  const deps = (now: number) => ({ collect: async () => { calls++; return data({ now }); }, now: () => now });
  assert.equal(await runDailyReportCycle({} as any, NOW, deps(NOW)), "no_kv");
  assert.equal(await runDailyReportCycle({ ...env, ETI_DAILY_ENABLED: "false" }, NOW, deps(NOW)), "disabled");
  assert.equal(await runDailyReportCycle(env, Date.parse("2026-11-14T09:00:00Z"), deps(NOW)), "weekend");
  assert.equal(await runDailyReportCycle(env, Date.parse("2026-11-11T03:00:00Z"), deps(NOW)), "too_early");
  assert.equal(calls, 0);
  assert.equal(await runDailyReportCycle(env, NOW, deps(NOW)), "generated"); assert.equal(calls, 1);
  assert.ok(kv.m.has(keyFor("2026-11-11"))); assert.ok(kv.m.has("daily:report:latest"));
  assert.equal(await runDailyReportCycle(env, NOW + 900_000, deps(NOW)), "exists"); assert.equal(calls, 1);
  resetDailyMemo();
  const old = await handleDailyReport(req("/api/daily-report?date=2026-11-11"), env, deps(NOW)), ob: any = await old.json();
  assert.equal(old.status, 200); assert.equal(ob.date, "2026-11-11"); assert.equal(ob.cache.stored, true); assert.equal(calls, 1);
  const today = await handleDailyReport(req("/api/daily-report"), env, deps(NOW + 60_000)); assert.equal((await today.json() as any).cache.hit, true); assert.equal(calls, 1);
});

test("status endpoint reports which inputs are connected without needing live data", async () => {
  const res = await handleDailyReport(req("/api/daily-report/status"), {} as any, { now: () => NOW }), b: any = await res.json();
  assert.equal(res.status, 200); assert.equal(b.submitsOrders, false);
  assert.match(b.inputs.forex_and_gold, /not connected/); assert.match(b.inputs.equities, /not connected/); assert.match(b.inputs.storage, /no KV/);
  assert.equal(b.limits.subrequestBudget, 44); assert.deepEqual(b.limits.watchlist, ["AAPL", "MSFT", "NVDA"]);
});

test("route wrapper serves /daily and the API and delegates everything else untouched", async () => {
  const app = withDailyReport({ fetch: async (r: Request) => new Response(`base:${new URL(r.url).pathname}`) } as any);
  const page = await app.fetch(req("/daily"), {} as any); assert.equal(page.status, 200); assert.match(page.headers.get("content-type")!, /text\/html/);
  const html = await page.text(); assert.match(html, /ETI GLOBAL MARKET INTELLIGENCE/); assert.match(html, /\/api\/daily-report/);
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>")); assert.doesNotThrow(() => new Function(script));
  assert.equal(await (await app.fetch(req("/api/signals"), {} as any)).text(), "base:/api/signals");
  assert.equal((await app.fetch(req("/api/daily-report/status"), {} as any)).status, 200);
});
