import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";
import { HOUR, DAY, MIN, easterSunday, exchangeStatus, fxOpen, holidayFlags, lseCalendar, nyseCalendar, nthDow, sessionActive, sessionWindow, structuralSessionFit, utcOffsetMinutes } from "./readiness/calendar.ts";
import { eventHits, loadEvents, parseEvents, severityFor, type MarketEvent } from "./readiness/events.ts";
import { assess, upcomingClosures, type AssessInput } from "./readiness/engine.ts";
import { parseEvidence, summarizeEvidence } from "./readiness/evidence.ts";
import { buildSnapshot, historyStats, returnCorrelation, slippageBps } from "./readiness/snapshot.ts";
import { rateAssetSession, buildReport } from "./readiness/report.ts";
import { handleReadiness } from "./readiness/api.ts";
import { series } from "./algo/fixtures.ts";
import { INTERVAL_SECONDS, type Kline } from "./market.ts";
import type { ClosedTrade } from "./algo/performance.ts";

const realFetch = globalThis.fetch, realNow = Date.now;
test.afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });
const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const NO_EVENTS = { status: "not_configured" as const, sources: [], events: [], invalid: 0, fetchedAt: 0 };
const loaded = (events: MarketEvent[]) => ({ status: "loaded" as const, sources: ["test"], events, invalid: 0, fetchedAt: 0 });
const ev = (over: Partial<MarketEvent> & { time: number }): MarketEvent => ({ id: "e1", title: "US CPI", impact: "high", category: "economic", currencies: ["USD"], markets: [], symbols: [], source: "test", ...over });
const base = (over: Partial<AssessInput> = {}): AssessInput => ({ now: utc(2026, 11, 9, 9), at: utc(2026, 11, 9, 9), scope: "now", market: "forex", symbol: "EURUSD", strategy: "intraday", snapshot: null, events: NO_EVENTS, evidence: null, ...over });

// ------------------------------------------------------------------ market clock
test("DST offsets follow US, UK and Australian rules exactly at the switch instants", () => {
  assert.equal(utcOffsetMinutes("America/New_York", utc(2026, 3, 8, 6, 59)), -300);
  assert.equal(utcOffsetMinutes("America/New_York", utc(2026, 3, 8, 7, 0)), -240);
  assert.equal(utcOffsetMinutes("America/New_York", utc(2026, 11, 1, 5, 59)), -240);
  assert.equal(utcOffsetMinutes("America/New_York", utc(2026, 11, 1, 6, 0)), -300);
  assert.equal(utcOffsetMinutes("Europe/London", utc(2026, 3, 29, 0, 59)), 0);
  assert.equal(utcOffsetMinutes("Europe/London", utc(2026, 3, 29, 1, 0)), 60);
  assert.equal(utcOffsetMinutes("Europe/London", utc(2026, 10, 25, 0, 59)), 60);
  assert.equal(utcOffsetMinutes("Europe/London", utc(2026, 10, 25, 1, 0)), 0);
  assert.equal(utcOffsetMinutes("Australia/Sydney", utc(2026, 4, 4, 15, 59)), 660);
  assert.equal(utcOffsetMinutes("Australia/Sydney", utc(2026, 4, 4, 16, 0)), 600);
  assert.equal(utcOffsetMinutes("Australia/Sydney", utc(2026, 10, 3, 15, 59)), 600);
  assert.equal(utcOffsetMinutes("Australia/Sydney", utc(2026, 10, 3, 16, 0)), 660);
  assert.equal(nthDow(2026, 10, 4, 4), 26); // Thanksgiving 2026
});
test("Easter and the derived NYSE/LSE holiday lists match the published 2026 calendars", () => {
  assert.deepEqual(easterSunday(2026), [3, 5]);
  const ny = nyseCalendar(2026), dates = Object.fromEntries(ny.map(c => [c.name, c.date]));
  assert.equal(dates["Good Friday"], "2026-04-03"); assert.equal(dates["Independence Day"], "2026-07-03"); assert.equal(dates["Thanksgiving Day"], "2026-11-26"); assert.equal(dates["Christmas Day"], "2026-12-25");
  assert.ok(ny.some(c => c.kind === "early_close" && c.date === "2026-11-27"));
  assert.equal(nyseCalendar(2027).find(c => c.name === "New Year's Day")?.date, "2027-01-01");
  assert.equal(nyseCalendar(2022).some(c => c.date === "2021-12-31"), false); // Saturday New Year is not observed on Friday
  const lse = Object.fromEntries(lseCalendar(2026).map(c => [c.name, c.date]));
  assert.equal(lse["Easter Monday"], "2026-04-06"); assert.equal(lse["Boxing Day"], "2026-12-28"); assert.equal(lse["Summer bank holiday"], "2026-08-31");
});
test("the FX week closes Friday 17:00 New York time in both winter and summer", () => {
  assert.equal(fxOpen(utc(2026, 11, 6, 21, 59)).open, true); assert.equal(fxOpen(utc(2026, 11, 6, 22, 0)).open, false);
  assert.equal(fxOpen(utc(2026, 7, 10, 20, 59)).open, true); assert.equal(fxOpen(utc(2026, 7, 10, 21, 0)).open, false);
  assert.equal(fxOpen(utc(2026, 11, 8, 21, 59)).open, false); assert.equal(fxOpen(utc(2026, 11, 8, 22, 0)).open, true);
});
test("sessions, overlap, exchange hours, early closes and holiday flags", () => {
  assert.equal(sessionActive("london_ny_overlap", utc(2026, 11, 9, 13, 0)), true);
  assert.equal(sessionActive("london_ny_overlap", utc(2026, 11, 9, 17, 0)), false);
  assert.equal(sessionActive("asian", utc(2026, 11, 9, 3, 0)), true);
  assert.equal(sessionActive("london", utc(2026, 11, 7, 10, 0)), false); // Saturday
  assert.equal(sessionActive("london", utc(2026, 11, 7, 10, 0), true), true); // crypto clock
  assert.equal(exchangeStatus("NYSE", utc(2026, 11, 26, 15, 0)).open, false);
  assert.equal(exchangeStatus("NYSE", utc(2026, 11, 27, 17, 30)).open, true);
  assert.equal(exchangeStatus("NYSE", utc(2026, 11, 27, 18, 30)).open, false);
  assert.equal(exchangeStatus("LSE", utc(2026, 12, 28, 10, 0)).open, false);
  assert.ok(holidayFlags(utc(2026, 12, 25, 12, 0)).some(f => /US holiday/.test(f)));
  const w = sessionWindow("forex", "london", utc(2026, 11, 9, 15, 0))!; assert.equal(w.active, true); assert.equal(w.start, utc(2026, 11, 9, 8, 0)); assert.equal(w.end, utc(2026, 11, 9, 17, 0));
  assert.equal(structuralSessionFit("EURGBP", "london"), "primary"); assert.equal(structuralSessionFit("EURUSD", "london_ny_overlap"), "primary"); assert.equal(structuralSessionFit("USDJPY", "asian"), "partial"); assert.equal(structuralSessionFit("USDJPY", "london"), "weak"); assert.equal(structuralSessionFit("EURGBP", "asian"), "weak");
  assert.ok(upcomingClosures(utc(2026, 11, 20), 14).some(c => c.name === "Thanksgiving Day"));
});

// ------------------------------------------------------------------ events
test("event parser rejects malformed rows instead of repairing them and never invents events", async () => {
  const t = utc(2026, 11, 9, 13);
  const p = parseEvents([{ title: "FOMC", time: new Date(t + HOUR).toISOString(), impact: "HIGH", currency: "usd", category: "central_bank" }, { title: "", time: t, impact: "high" }, { title: "x", time: "not a date", impact: "high" }, { title: "y", time: t, impact: "huge" }, null], "t", t);
  assert.equal(p.events.length, 1); assert.equal(p.invalid, 4); assert.deepEqual(p.events[0].currencies, ["USD"]); assert.equal(p.events[0].impact, "high");
  assert.equal(parseEvents({ nope: 1 }, "t", t).invalid, 1);
  assert.equal((await loadEvents({}, t)).status, "not_configured");
  assert.equal((await loadEvents({ ETI_EVENT_FEED_URL: "http://insecure.example/feed" }, t)).status, "error");
  assert.equal((await loadEvents({ ETI_EVENTS_JSON: "{bad" }, t)).status, "error");
});
test("event feed is fetched over https with a bearer token; any failure leaves the calendar unverified", async () => {
  const t = utc(2026, 11, 9, 13); let auth = "";
  const ok = (async (_u: unknown, init?: RequestInit) => { auth = String((init?.headers as Record<string, string>).authorization); return new Response(JSON.stringify({ events: [{ title: "NFP", time: t + HOUR, impact: "high", currency: "USD" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const s = await loadEvents({ ETI_EVENT_FEED_URL: "https://calendar.example/v1", ETI_EVENT_FEED_TOKEN: "secret" }, t, ok);
  assert.equal(s.status, "loaded"); assert.equal(s.events.length, 1); assert.equal(auth, "Bearer secret"); assert.ok(!JSON.stringify(s).includes("secret"));
  const bad = await loadEvents({ ETI_EVENT_FEED_URL: "https://calendar.example/v1" }, t, (async () => new Response("no", { status: 503 })) as unknown as typeof fetch);
  assert.equal(bad.status, "error"); assert.match(bad.error!, /503/);
});
test("danger zones around releases: blackout, high-risk and caution", () => {
  const T = utc(2026, 11, 9, 13, 30), hi = ev({ time: T }), med = ev({ time: T, impact: "medium" });
  const at = (m: number, e = hi) => severityFor(e, T + m * MIN, T + m * MIN);
  assert.equal(at(-20), "avoid"); assert.equal(at(20), "avoid"); assert.equal(at(-90), "high_risk"); assert.equal(at(100), "high_risk"); assert.equal(at(-200), "caution"); assert.equal(at(230), "caution"); assert.equal(at(-300), "none"); assert.equal(at(300), "none");
  assert.equal(at(-10, med), "high_risk"); assert.equal(at(-30, med), "caution"); assert.equal(at(-60, med), "none");
  const ctx = { market: "crypto", symbol: "BTCUSDT", currencies: ["USD", "BTC"] };
  assert.equal(eventHits([ev({ time: T, currencies: ["EUR"] })], ctx, T, T).length, 0); // an EUR-only event does not hit a USD-quoted crypto pair
  assert.equal(eventHits([ev({ time: T })], ctx, T, T).length, 1);
});

// ------------------------------------------------------------------ engine decisions
test("weekend: forex is closed and the verdict is AVOID TRADING", () => {
  const a = assess(base({ now: utc(2026, 11, 7, 12), at: utc(2026, 11, 7, 12) }));
  assert.equal(a.status, "AVOID_TRADING"); assert.ok(a.blockers.some(b => /closed/i.test(b))); assert.match(a.recommendation, /Do not open new positions/);
});
test("a US holiday closes the equities market; a normal session without a data feed is never better than UNCERTAIN", () => {
  assert.equal(assess(base({ market: "equities", symbol: "", now: utc(2026, 11, 26, 15), at: utc(2026, 11, 26, 15) })).status, "AVOID_TRADING");
  const open = assess(base({ market: "forex", events: loaded([ev({ time: utc(2026, 11, 20, 13), currencies: ["USD"] })]) }));
  assert.equal(open.status, "UNCERTAIN"); assert.ok(open.notEvaluated.includes("Expected volatility")); assert.ok(open.caps.some(c => /fewer than 5|neither|unverified/i.test(c)));
});
test("an unconfigured calendar is reported as unverified and caps the verdict; it is never called clear", () => {
  const a = assess(base());
  const f1 = a.factors.find(f => f.id === 1)!; assert.equal(f1.rating, "not_evaluated"); assert.match(f1.headline, /UNVERIFIED/);
  assert.ok(["UNCERTAIN", "HIGH_RISK", "AVOID_TRADING"].includes(a.status)); assert.equal(a.factors.length, 12);
});
test("imminent and just-released high-impact events block or restrict trading", () => {
  const now = utc(2026, 11, 9, 13, 20), mk = (mins: number) => assess(base({ now, at: now, market: "forex", events: loaded([ev({ time: now + mins * MIN })]) }));
  assert.equal(mk(10).status, "AVOID_TRADING"); assert.equal(mk(-15).status, "AVOID_TRADING");
  assert.equal(mk(-50).status, "HIGH_RISK"); assert.equal(mk(80).status, "HIGH_RISK");
  assert.ok(mk(10).eventHits[0].severity === "avoid" && /US CPI/.test(mk(10).factors[0].detail.join(" ")));
});
test("a single high-impact release makes a whole session CAUTION, not a blanket ban; central-bank decisions or two releases make it HIGH RISK", () => {
  const now = utc(2026, 11, 9, 7), cpi = ev({ time: utc(2026, 11, 9, 13, 30) }), fomc = ev({ id: "e2", title: "FOMC", category: "central_bank", time: utc(2026, 11, 9, 19) });
  const f1 = (events: MarketEvent[]) => assess(base({ now, at: now, scope: "session", session: "london", market: "forex", events: loaded(events) })).factors[0].rating;
  assert.equal(f1([cpi]), "caution"); assert.equal(f1([cpi, ev({ id: "e3", title: "NFP", time: utc(2026, 11, 9, 14) })]), "adverse"); assert.equal(f1([ev({ ...fomc, time: utc(2026, 11, 9, 14) })]), "adverse");
  const hour = (h: number) => assess(base({ now, at: utc(2026, 11, 9, h), scope: "hour", market: "forex", events: loaded([cpi]) })).factors[0].rating;
  assert.equal(hour(13), "severe"); assert.equal(hour(10), "caution"); assert.equal(hour(14), "adverse");
});
test("tomorrow and hour scopes use schedule and events only, and never pretend to know live conditions", () => {
  const now = utc(2026, 11, 6, 10);
  const tomorrow = assess(base({ now, at: utc(2026, 11, 7), scope: "day", dayKey: "2026-11-07", market: "forex" })); // Saturday
  assert.equal(tomorrow.status, "AVOID_TRADING"); assert.equal(tomorrow.liveConditionsApplied, false);
  const crypto = assess(base({ now, at: utc(2026, 11, 7), scope: "day", dayKey: "2026-11-07", market: "crypto", symbol: "BTCUSDT" }));
  assert.ok(crypto.factors.find(f => f.id === 3)!.headline.length > 0); assert.equal(crypto.factors.find(f => f.id === 6)!.rating, "not_evaluated");
});

// ------------------------------------------------------------------ measured conditions
function hourlyHistory(now: number, days = 40): Kline[] {
  const rows: Kline[] = [], end = Math.floor(now / DAY) * DAY - HOUR; let p = 100, seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = end - days * DAY + HOUR; t <= end; t += HOUR) {
    const h = new Date(t).getUTCHours(), london = h >= 8 && h <= 16, open = p, close = open + (london ? 0.25 : (rnd() - 0.5) * 0.2);
    rows.push([t, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close, london ? 200 : h < 8 ? 50 : 100]); p = close;
  }
  return rows;
}
test("session statistics are measured from candles and rate assets per session without implying profit", () => {
  const now = utc(2026, 11, 9, 12), h = historyStats(hourlyHistory(now), now)!;
  assert.ok(h && h.days >= 35);
  const london = h.sessions.find(s => s.session === "london")!, asian = h.sessions.find(s => s.session === "asian")!;
  assert.ok(london.volumeVsBaseline > 1.4 && london.sampleOk && asian.volumeVsBaseline < 0.7);
  assert.equal(rateAssetSession(h, "london", "TESTUSDT").condition, "favourable");
  assert.equal(rateAssetSession(h, "asian", "TESTUSDT").condition, "unfavourable");
  assert.equal(rateAssetSession(null, "london", "X").condition, "insufficient_data");
  assert.equal(historyStats(hourlyHistory(now, 5), now), null); // too little history: no statistics
});
test("correlation and slippage helpers behave on known inputs", () => {
  const a = series(300, { seed: 5, end: utc(2026, 11, 9), stepMs: HOUR, noise: 1 });
  assert.ok(returnCorrelation(a, a)!.corr > 0.999);
  const inv = a.map(k => [k[0], 1e4 / k[1], 1e4 / k[3], 1e4 / k[2], 1e4 / k[4], k[5]] as Kline);
  assert.ok(returnCorrelation(a, inv)!.corr < -0.99);
  const depth = { bids: [[99.9, 1], [99.8, 1]] as [number, number][], asks: [[100.1, 1], [100.2, 1]] as [number, number][], timestamp: 0 };
  assert.ok(slippageBps(depth, 100).buyBps! > 0); assert.equal(slippageBps(depth, 1e6).buyBps, null);
});

// ------------------------------------------------------------------ strategy evidence
test("strategy evidence is withheld below the minimum sample and judged only on recorded trades", () => {
  const mk = (n: number, winRate: number, win = 20): ClosedTrade[] => Array.from({ length: n }, (_, i) => ({ id: "t" + i, engine: "combined", symbol: "BTCUSDT", openedAt: utc(2026, 10, 5 + (i % 20), 9), closedAt: utc(2026, 10, 5 + (i % 20), 11), pnl: (i * 37) % 100 < winRate * 100 ? win : -10, riskAmount: 10, fees: 0, slippage: 0 }));
  assert.equal(summarizeEvidence(null, "crypto", "london", null).verdict, "no_data");
  const small = summarizeEvidence({ symbol: "BTCUSDT", strategy: "intraday", generatedAt: 1, source: "replay", trades: mk(10, 0.9) }, "crypto", "london", null);
  assert.equal(small.verdict, "inconclusive"); assert.ok(small.buckets.every(b => b.winRate === null)); assert.match(small.note, /minimum 30/);
  const t = mk(40, 0.65), good = summarizeEvidence({ symbol: "BTCUSDT", strategy: "intraday", generatedAt: 1, source: "replay", trades: t }, "crypto", "london", null);
  assert.equal(good.verdict, "supportive");
  const bad = summarizeEvidence({ symbol: "BTCUSDT", strategy: "intraday", generatedAt: 1, source: "replay", trades: mk(60, 0.3, 10) }, "crypto", null, null);
  assert.equal(bad.verdict, "adverse");
  assert.equal(parseEvidence({ symbol: "X", trades: [{ pnl: "x" }] })!.trades.length, 0);
});

// ------------------------------------------------------------------ end to end with mocked public market data
function mockMarket(now: number, o: { spike?: boolean; thinBook?: boolean } = {}) {
  const lastClose = series(1000, { drift: 0.05, noise: 0.6, seed: 7, stepMs: HOUR, end: Math.floor(now / HOUR) * HOUR - HOUR }).at(-1)![4];
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const u = new URL(String((input as Request).url ?? input)); calls.push(u.pathname);
    if (u.pathname.endsWith("/klines")) {
      const iv = u.searchParams.get("interval")!, n = Number(u.searchParams.get("limit")), step = INTERVAL_SECONDS[iv] * 1000;
      const rows = series(n, { drift: 0.05, noise: 0.6, seed: 7, stepMs: step, end: Math.floor(now / step) * step - step });
      if (o.spike) { const l = rows.at(-1)!; l[2] = l[4] * 1.6; l[3] = l[1] * 0.7; }
      return new Response(JSON.stringify(rows.map(r => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5])])), { status: 200 });
    }
    if (u.pathname.endsWith("/depth")) { const w = o.thinBook ? 0.2 : 0.0002, lv = (s: number) => Array.from({ length: 20 }, (_, i) => [String(lastClose * (1 + s * (w + i * 0.0001))), o.thinBook ? "0.01" : "500"]); return new Response(JSON.stringify({ bids: lv(-1), asks: lv(1) }), { status: 200 }); }
    if (u.pathname.endsWith("/ticker/24hr")) return new Response(JSON.stringify({ lastPrice: String(lastClose), priceChangePercent: "1.2", highPrice: String(lastClose * 1.02), lowPrice: String(lastClose * 0.98), volume: "1000", quoteVolume: "100000" }), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}
const get = (path: string, env: Record<string, unknown> = {}) => handleReadiness(new Request("https://eti.test" + path), env as never);

test("API validates input and is read-only", async () => {
  for (const p of ["/api/readiness?scope=week", "/api/readiness?strategy=yolo", "/api/readiness?symbol=BTC%20USDT", "/api/readiness?scope=hour&hour=30", "/api/readiness?scope=session&session=moon", "/api/readiness?scope=day&day=2001-01-01", "/api/readiness?market=bonds", "/api/readiness?market=forex&symbol=EURXYZ"])
    assert.equal((await get(p)).status, 400, p);
  assert.equal((await handleReadiness(new Request("https://eti.test/api/readiness", { method: "POST" }), {} as never)).status, 405);
  assert.equal((await get("/api/readiness/nothing")).status, 404);
  const st = await (await get("/api/readiness/status")).json() as any; assert.equal(st.submitsOrders, false); assert.equal(st.economicCalendar.status, "not_configured");
});
test("crypto report: 12 factors, 5 sessions, calendar unverified, text report in the required format", async () => {
  const calls = mockMarket(Date.now()); Date.now = () => utc(2026, 11, 9, 9, 30) as never; mockMarket(utc(2026, 11, 9, 9, 30));
  const res = await get("/api/readiness?market=crypto&symbol=BTCUSDT&strategy=intraday"), d = await res.json() as any;
  assert.equal(res.status, 200); assert.equal(d.overall.factors.length, 12); assert.equal(d.sessions.length, 5); assert.equal(d.submitsOrder, false); assert.equal(d.liveExecutionAllowed, false);
  assert.equal(d.overall.factors[0].rating, "not_evaluated"); assert.ok(["SELECTIVELY_FAVOURABLE", "UNCERTAIN", "HIGH_RISK", "AVOID_TRADING"].includes(d.overall.status)); assert.notEqual(d.overall.status, "FAVOURABLE");
  assert.equal(d.dataQuality.priceData, "ok"); assert.ok(d.dataQuality.history.bars > 900);
  assert.match(d.text, /^ETI MARKET READINESS REPORT/); assert.match(d.text, /Recommendation:/); assert.match(d.text, /Do not enter simply because/); assert.match(d.text, /London session/i);
  assert.ok(d.disclaimers[0].includes("No session is assumed to be profitable"));
  void calls;
  const txt = await get("/api/readiness?market=crypto&format=text"); assert.match(txt.headers.get("content-type")!, /text\/plain/); assert.match(await txt.text(), /Reason:/);
});
test("crypto report with a calm calendar can be favourable-leaning but a high-impact USD release 10 minutes away forces AVOID TRADING", async () => {
  const now = utc(2026, 11, 9, 9, 30); Date.now = () => now as never; mockMarket(now);
  const far = JSON.stringify([{ title: "Far event", time: new Date(now + 5 * DAY).toISOString(), impact: "high", currency: "USD" }]);
  const calm = await (await get("/api/readiness?market=crypto&symbol=BTCUSDT", { ETI_EVENTS_JSON: far })).json() as any;
  assert.equal(calm.overall.factors[0].rating, "supportive"); assert.notEqual(calm.overall.status, "AVOID_TRADING");
  const soon = JSON.stringify([{ title: "US CPI", time: new Date(now + 10 * MIN).toISOString(), impact: "high", currency: "USD", category: "economic" }]);
  const blocked = await (await get("/api/readiness?market=crypto&symbol=BTCUSDT", { ETI_EVENTS_JSON: soon })).json() as any;
  assert.equal(blocked.overall.status, "AVOID_TRADING"); assert.ok(blocked.overall.reasons.some((r: string) => /announcement/i.test(r))); assert.ok(blocked.overall.eventHits.some((e: any) => e.title === "US CPI"));
});
test("abnormal volatility and a thin order book each lower the verdict", async () => {
  const now = utc(2026, 11, 9, 9, 30); Date.now = () => now as never;
  const cal = { ETI_EVENTS_JSON: "[]" };
  mockMarket(now, { spike: true }); const spike = await (await get("/api/readiness?market=crypto", cal)).json() as any;
  assert.ok(["HIGH_RISK", "AVOID_TRADING"].includes(spike.overall.status), spike.overall.status);
  mockMarket(now, { thinBook: true }); const thin = await (await get("/api/readiness?market=crypto", cal)).json() as any;
  assert.ok(["caution", "adverse"].includes(thin.overall.factors.find((f: any) => f.id === 10).rating));
});
test("data outage fails safe: UNCERTAIN or worse, never favourable", async () => {
  Date.now = () => utc(2026, 11, 9, 9, 30) as never; globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  const d = await (await get("/api/readiness?market=crypto", { ETI_EVENTS_JSON: "[]" })).json() as any;
  assert.equal(d.dataQuality.priceData, "unavailable"); assert.ok(["UNCERTAIN", "HIGH_RISK", "AVOID_TRADING"].includes(d.overall.status)); assert.ok(d.overall.notEvaluated.includes("Expected volatility"));
});
test("forex endpoints: weekend avoid, tomorrow, specific hour and session scopes", async () => {
  Date.now = () => utc(2026, 11, 7, 12) as never; // Saturday
  assert.equal(((await (await get("/api/readiness?market=forex&symbol=EURUSD")).json()) as any).overall.status, "AVOID_TRADING");
  Date.now = () => utc(2026, 11, 9, 9) as never; // Monday
  const day = await (await get("/api/readiness?market=forex&scope=day&day=tomorrow")).json() as any; assert.equal(day.hours.length, 24); assert.equal(day.overall.liveConditionsApplied, false);
  const hr = await (await get("/api/readiness?market=forex&symbol=EURUSD&scope=hour&hour=14")).json() as any; assert.equal(hr.scope, "hour");
  const se = await (await get("/api/readiness?market=forex&symbol=EURUSD&scope=session&session=london_ny_overlap")).json() as any; assert.equal(se.overall.scope, "session");
  assert.equal(se.sessions.find((s: any) => s.session === "london_ny_overlap").structuralFit, "primary");
});
test("per-session asset ratings are measured for crypto and structural-only for forex", async () => {
  const now = utc(2026, 11, 9, 9); Date.now = () => now as never; mockMarket(now);
  const c = await (await get("/api/readiness/sessions?market=crypto&symbols=BTCUSDT,ETHUSDT")).json() as any;
  assert.equal(c.sessions.length, 5); assert.equal(c.sessions[0].assets.length, 2); assert.ok(c.sessions[0].assets[0].condition); assert.match(c.disclaimer, /No session is assumed to be profitable/);
  const f = await (await get("/api/readiness/sessions?market=forex")).json() as any; assert.equal(f.sessions[0].assets[0].basis, "structural_schedule_not_measured"); assert.match(f.sessions[0].note, /not measured/);
  assert.equal((await get("/api/readiness/sessions?market=equities")).status, 400);
});
test("buildReport renders the required plain-text layout", () => {
  const r = buildReport({ ...base({ market: "forex", symbol: "EURUSD", events: loaded([]) }) });
  assert.match(r.text, /^ETI MARKET READINESS REPORT\n\nDate: 2026-11-09\nMarket: Forex \(EURUSD\)/); assert.match(r.text, /Overall: /); assert.match(r.text, /London session[^\n]*: /i);
});
test("the Worker routes /api/readiness and the dashboard exposes the readiness panel", async () => {
  const s = await worker.fetch(new Request("https://eti.test/api/readiness/status"), {} as never); assert.equal(s.status, 200);
  const page = await (await worker.fetch(new Request("https://eti.test/"), {} as never)).text();
  assert.ok(page.includes("ETI Market Readiness Engine") && page.includes("/api/readiness?"));
});
void buildSnapshot;
