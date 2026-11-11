import test from "node:test";
import assert from "node:assert/strict";
import { bodyFor, clean, providerStatus, raiseAlerts, readAlertLog, subjectFor, type AlertEvent } from "./algo/alerts.ts";
import { executionLogAlerts, manageAlerts, paperCycleAlerts, signalAlerts } from "./algo/alert-rules.ts";
import { handleAlerts, pollExecutionAlerts } from "./algo/alerts-api.ts";

const TOKEN = "t".repeat(40), NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
const kv = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } }; };
const envOf = (o: any = {}) => ({ ETI_EXECUTION_LOG: kv(), ETI_ALERT_EMAIL: "owner@example.com", ETI_ALERT_FROM: "alerts@eti.example.com", RESEND_API_KEY: "re_" + "a".repeat(30), ETI_EXECUTION_TOKEN: TOKEN, ...o });
const mailer = (status = 200) => { const sent: any[] = []; const fetchImpl = (async (u: any, init: any) => { sent.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body) }); return new Response(status === 200 ? "{}" : "denied", { status }); }) as typeof fetch; return { sent, fetchImpl }; };
const ev = (o: Partial<AlertEvent> = {}): AlertEvent => ({ type: "new_signal", severity: "info", title: "t", detail: "d", symbol: "BTCUSDT", ...o });

test("provider status names exactly what is missing and never claims delivery", () => {
  assert.deepEqual(providerStatus({} as any).missing.length, 2);
  assert.equal(providerStatus(envOf()).configured, true); assert.equal(providerStatus(envOf()).provider, "resend");
  assert.ok(providerStatus(envOf({ ETI_ALERT_EMAIL: "not-an-email" })).missing.includes("ETI_ALERT_EMAIL"));
  assert.ok(providerStatus(envOf({ ETI_ALERT_FROM: undefined })).missing.includes("ETI_ALERT_FROM"));
});
test("clean redacts credential-shaped text and strips control characters; subject cannot be header-injected", () => {
  assert.equal(clean("key re_" + "x".repeat(30) + " ok"), "key [redacted] ok");
  assert.match(clean("Bearer abc.def.ghi rest"), /\[redacted\]/);
  const s = subjectFor([ev({ title: "bad\r\nBcc: evil@x.com", severity: "critical" })]); assert.ok(!/[\r\n]/.test(s)); assert.match(s, /^\[ETI CRITICAL\]/);
  assert.match(bodyFor([ev()], NOW), /not financial advice/i);
});
test("one digest email per call, logged as delivered, and the same event is not re-sent", async () => {
  const m = mailer(), env = envOf(), e = [ev({ dedupeKey: "a" }), ev({ title: "second", dedupeKey: "b" })];
  const r = await raiseAlerts(env, e, { fetchImpl: m.fetchImpl, now: () => NOW });
  assert.equal(r.delivered, true); assert.equal(m.sent.length, 1); assert.equal(m.sent[0].body.to[0], "owner@example.com"); assert.match(m.sent[0].body.subject, /2 alerts/);
  assert.equal(m.sent[0].headers.authorization.startsWith("Bearer re_"), true);
  const again = await raiseAlerts(env, e, { fetchImpl: m.fetchImpl, now: () => NOW });
  assert.equal(again.sent, 0); assert.equal(again.suppressed, 2); assert.equal(m.sent.length, 1);
  const log = await readAlertLog(env); assert.equal(log.length, 2); assert.ok(log.every(a => a.delivered && a.provider === "resend"));
});
test("a failed send is logged as not delivered and retried next time (not marked seen)", async () => {
  const env = envOf(), bad = mailer(403), ok = mailer();
  const r = await raiseAlerts(env, [ev({ dedupeKey: "x" })], { fetchImpl: bad.fetchImpl, now: () => NOW });
  assert.equal(r.delivered, false); assert.match(r.note, /resend HTTP 403/);
  assert.equal((await readAlertLog(env))[0].delivered, false);
  const r2 = await raiseAlerts(env, [ev({ dedupeKey: "x" })], { fetchImpl: ok.fetchImpl, now: () => NOW }); assert.equal(r2.delivered, true);
});
test("no provider configured: recorded as not delivered with the reason, no network call", async () => {
  const env = envOf({ RESEND_API_KEY: undefined, ETI_ALERT_EMAIL: undefined }), m = mailer();
  const r = await raiseAlerts(env, [ev()], { fetchImpl: m.fetchImpl, now: () => NOW });
  assert.equal(r.delivered, false); assert.equal(m.sent.length, 0); const l = (await readAlertLog(env))[0]; assert.equal(l.delivered, false); assert.match(l.deliveryNote, /not configured/);
});
test("hourly limit drops info alerts but critical alerts always pass", async () => {
  const env = envOf({ ETI_ALERT_MAX_PER_HOUR: "2" }), m = mailer();
  await raiseAlerts(env, [ev({ title: "1" }), ev({ title: "2" })], { fetchImpl: m.fetchImpl, now: () => NOW });
  const r = await raiseAlerts(env, [ev({ title: "3" }), ev({ title: "boom", severity: "critical", type: "protection_failure" })], { fetchImpl: m.fetchImpl, now: () => NOW });
  assert.equal(r.sent, 1); const log = await readAlertLog(env); assert.equal(log.find(a => a.title === "3")!.delivered, false); assert.equal(log.find(a => a.title === "boom")!.delivered, true);
});
test("alerting can be disabled and never throws", async () => {
  assert.equal((await raiseAlerts(envOf({ ETI_ALERTS_DISABLED: "true" }), [ev()], {})).note, "alerts disabled");
  const boom = (async () => { throw new Error("network down"); }) as typeof fetch;
  const r = await raiseAlerts(envOf(), [ev()], { fetchImpl: boom, now: () => NOW }); assert.equal(r.delivered, false); assert.match(r.note, /network down/);
});

test("paper cycle: take profit, break-even, stop, close, open, rejection, kill switch and failures map to alerts", () => {
  const a = paperCycleAlerts({ ran: true, at: "2026-11-11T10:00:00.000Z", killSwitch: true, items: [
    { symbol: "BTCUSDT", action: "tick", events: ["TP1", "BREAKEVEN"] }, { symbol: "ETHUSDT", action: "tick", events: ["STOP", "CLOSED"] },
    { symbol: "SOLUSDT", action: "evaluate", decision: "BUY", event: "OPENED", reasons: ["r"] }, { symbol: "BNBUSDT", action: "evaluate", event: "REJECTED", reasons: ["daily loss limit"] }, { symbol: "XRPUSDT", action: "evaluate", error: "klines 500" }] });
  const types = a.map(x => x.type); for (const t of ["kill_switch", "take_profit_hit", "stop_activated", "stop_loss_hit", "position_closed", "trade_executed", "risk_rejection", "market_data_failure"]) assert.ok(types.includes(t as any), t);
  assert.equal(a.find(x => x.type === "kill_switch")!.severity, "critical"); assert.equal(paperCycleAlerts({ ran: false, at: "", items: [] }).length, 0);
});
test("execution log: only events newer than the cursor alert, with severities; unknown events are ignored", () => {
  const logs = [{ ts: "2026-11-11T10:03:00Z", event: "protective_failed", details: { reasons: ["x"] } }, { ts: "2026-11-11T10:02:00Z", event: "venue_down" }, { ts: "2026-11-11T10:01:00Z", event: "signal_received" }, { ts: "2026-11-11T09:00:00Z", event: "account_halted", details: { reason: "old" } }];
  const { alerts, newest } = executionLogAlerts(logs, "acct", Date.parse("2026-11-11T09:30:00Z"));
  assert.deepEqual(alerts.map(a => a.type).sort(), ["exchange_outage", "protection_failure"]); assert.ok(alerts.every(a => a.severity === "critical")); assert.equal(newest, Date.parse("2026-11-11T10:03:00Z"));
  assert.equal(executionLogAlerts(logs, "acct", Infinity).alerts.length, 0);
});
test("manage alerts: report-only invalidation, failed close, disagreement and unreliable data", () => {
  const o = (x: any) => ({ symbol: "BTCUSDT", entryPrice: 1, decision: "HOLD", evaluable: true, invalidated: false, confirmations: 0, required: 2, action: "none", reasons: [], ...x });
  const a = manageAlerts("acct", [o({ invalidated: true, action: "report_only", reasons: ["r"] }), o({ symbol: "ETHUSDT", action: "close_failed", execution: { status: "x" } }), o({ symbol: "SOLUSDT", agreement: "SWIFT_BULLISH_GAINZ_BEARISH" }), o({ symbol: "BNBUSDT", evaluable: false, reasons: ["bad"] })], NOW);
  assert.deepEqual(a.map(x => x.type), ["thesis_invalidated", "protection_failure", "signal_disagreement", "market_data_failure"]); assert.equal(a[1].severity, "critical");
});
test("signal alerts fire on a new direction only, and high conviction needs a high score", () => {
  const row = (s: string, d: any, score: number) => ({ rank: 1, symbol: s, decision: d, direction: "LONG", opportunityScore: score, validationScore: 80, confidence: 70, riskRewardToTP3: 3, agreement: "BOTH_BULLISH", liquidity: "healthy", entryZone: null, stopLoss: null, reason: "" }) as any;
  const a = signalAlerts({ AAAUSDT: { decision: "BUY", direction: "LONG" } }, [row("AAAUSDT", "BUY", 90), row("BBBUSDT", "BUY", 90), row("CCCUSDT", "SELL", 60), row("DDDUSDT", "HOLD", 99)], "intraday");
  assert.deepEqual(a.map(x => [x.symbol, x.type]), [["BBBUSDT", "high_conviction"], ["CCCUSDT", "new_signal"]]);
});

test("alerts API: auth, test email result is honest, log is readable", async () => {
  const rq = (p: string, m = "GET", t: string | null = TOKEN) => new Request("https://eti.test" + p, { method: m, headers: t ? { authorization: "Bearer " + t } : {} });
  const env = envOf(), m = mailer();
  assert.equal((await handleAlerts(rq("/api/omnisignal/alerts", "GET", null), env)).status, 401);
  assert.equal((await handleAlerts(rq("/api/omnisignal/alerts/test", "GET"), env)).status, 405);
  const bad = await handleAlerts(rq("/api/omnisignal/alerts/test", "POST"), envOf({ RESEND_API_KEY: undefined }), { fetchImpl: m.fetchImpl }); assert.equal(bad.status, 502); assert.equal(((await bad.json()) as any).delivered, false);
  const ok = await handleAlerts(rq("/api/omnisignal/alerts/test", "POST"), env, { fetchImpl: m.fetchImpl, now: () => NOW }); assert.equal(ok.status, 200);
  const g = await (await handleAlerts(rq("/api/omnisignal/alerts"), env)).json() as any; assert.equal(g.delivered, 1); assert.equal(g.provider.configured, true); assert.ok(!JSON.stringify(g).includes("re_aaaa"), "the API key never appears in responses");
});
test("polling: the first run only sets a cursor; later runs alert on new events once", async () => {
  const env = envOf({ ETI_RISK_GATE_URL: "https://api.test/api/risk-gateway/preflight", ETI_RISK_GATE_TOKEN: "gate" }), m = mailer();
  let logs: any[] = [{ ts: new Date(NOW - 60000).toISOString(), event: "venue_down" }];
  const fetchImpl = (async (u: any, init: any) => String(u).startsWith("https://api.resend.com") ? m.fetchImpl(u, init) : new Response(JSON.stringify(logs))) as typeof fetch;
  const d = { fetchImpl, now: () => NOW };
  const a = await pollExecutionAlerts(env, "acct1", d); assert.equal(a.alerts, 0); assert.equal(m.sent.length, 0);
  logs = [{ ts: new Date(NOW + 60000).toISOString(), event: "protective_failed", details: { reasons: ["x"] } }, ...logs];
  const b = await pollExecutionAlerts(env, "acct1", d); assert.equal(b.alerts, 1); assert.equal(m.sent.length, 1);
  const c = await pollExecutionAlerts(env, "acct1", d); assert.equal(c.alerts, 0); assert.equal(m.sent.length, 1);
});
