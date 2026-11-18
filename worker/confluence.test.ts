import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "./market.ts";
import { analyzeSmc } from "./analysis/smc-intel.ts";
import { confluence, CONFLUENCE_TF_SECS, type ConfluenceTf } from "./analysis/confluence.ts";

/** Deterministic trending series ending at `endMs` for a given period. drift>0 uptrend, <0 downtrend. */
function series(tf: ConfluenceTf, drift: number, n = 120, endMs = Date.UTC(2026, 10, 18, 4, 0)): Kline[] {
  const step = CONFLUENCE_TF_SECS[tf] * 1000, out: Kline[] = []; let p = 100;
  for (let i = 0; i < n; i++) {
    p += drift + Math.sin(i / 2.5) * 1.1; const o = p - 0.3, c = p + 0.3;
    out.push([endMs - (n - i) * step, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c, 100 + (i % 7) * 10]);
  }
  return out;
}
const NOW = Date.UTC(2026, 10, 18, 4, 5);
const frames = (drifts: Partial<Record<ConfluenceTf, number>>) => Object.fromEntries(Object.entries(drifts).map(([tf, d]) => [tf, analyzeSmc(series(tf as ConfluenceTf, d!), tf)]));

test("aligned uptrend across timeframes yields a bullish score with a full evidence ledger", () => {
  const r = confluence({ symbol: "BTCUSDT", frames: frames({ "1M": 0.6, "1w": 0.6, "1d": 0.6, "4h": 0.6, "1h": 0.6, "15m": 0.6, "5m": 0.6 }), entryTimeframe: "15m", now: NOW });
  assert.equal(r.status, "ready");
  assert.deepEqual(r.usedTimeframes.length, 7);
  assert.ok(r.score > 0, `score ${r.score}`);
  assert.ok(r.evidence.length >= 14);
  for (const e of r.evidence) assert.ok(Math.abs(e.points) <= e.max + 1e-9, `${e.id} within its maximum`);
  assert.equal(r.confidenceType, "evidence_quality_not_probability");
  assert.ok(r.confidence <= 85);
  assert.equal(r.submitsOrder, false); assert.equal(r.canTriggerTrade, false); assert.equal(r.liveExecutionAllowed, false);
});

test("higher-timeframe uptrend against a falling entry timeframe is reported as a conflict", () => {
  const r = confluence({ symbol: "BTCUSDT", frames: frames({ "1M": 0.6, "1w": 0.6, "1d": 0.6, "4h": -0.6, "1h": -0.6, "15m": -0.6, "5m": -0.6 }), entryTimeframe: "15m", now: NOW });
  assert.ok(r.conflicts.length >= 1, JSON.stringify(r.conflicts));
  assert.notEqual(r.entry.confirmed, true);
});

test("missing and stale timeframes are excluded and reported, never guessed", () => {
  const f = frames({ "1d": 0.6, "4h": 0.6, "1h": 0.6 });
  f["15m"] = analyzeSmc(series("15m", 0.6, 120, Date.UTC(2026, 10, 10)), "15m"); // a week old
  const r = confluence({ symbol: "ETHUSDT", frames: f, now: NOW });
  assert.ok(r.staleTimeframes.includes("15m"));
  assert.ok(!r.usedTimeframes.includes("15m"));
  assert.ok(r.missingTimeframes.includes("5m") && r.missingTimeframes.includes("1M"));
  assert.ok(r.coverage < 1);
});

test("too few usable timeframes is insufficient with zero confidence", () => {
  const r = confluence({ symbol: "SOLUSDT", frames: frames({ "1h": 0.6 }), now: NOW });
  assert.equal(r.status, "insufficient"); assert.equal(r.stance, "insufficient"); assert.equal(r.confidence, 0);
});

test("order flow counts only when fresh exchange trade data is supplied; estimates and stale data are ignored", () => {
  const f = frames({ "1d": 0.6, "4h": 0.6, "1h": 0.6, "15m": 0.6 });
  const base = confluence({ symbol: "BTCUSDT", frames: f, now: NOW });
  const fresh = confluence({ symbol: "BTCUSDT", frames: f, now: NOW, orderFlow: { deltaPct: 40, coverage: "exchange_trades", asOf: NOW - 30_000, sampleTrades: 500 } });
  const stale = confluence({ symbol: "BTCUSDT", frames: f, now: NOW, orderFlow: { deltaPct: 40, coverage: "exchange_trades", asOf: NOW - 3_600_000, sampleTrades: 500 } });
  const est = confluence({ symbol: "BTCUSDT", frames: f, now: NOW, orderFlow: { deltaPct: 40, coverage: "unavailable", asOf: NOW, sampleTrades: 500 } });
  assert.equal(base.orderFlow.used, false);
  assert.equal(fresh.orderFlow.used, true);
  assert.ok(fresh.evidence.some(e => e.id === "orderflow"));
  for (const r of [stale, est]) { assert.equal(r.orderFlow.used, false); assert.ok(!r.evidence.some(e => e.id === "orderflow")); }
  assert.match(stale.orderFlow.detail, /stale/);
  assert.match(est.orderFlow.detail, /no estimate is substituted/);
});

test("the score is reproducible and bounded", () => {
  const f = frames({ "1w": -0.6, "1d": -0.6, "4h": -0.6, "1h": -0.6, "15m": -0.6 });
  const a = confluence({ symbol: "X", frames: f, now: NOW }), b = confluence({ symbol: "X", frames: f, now: NOW });
  assert.deepEqual(a, b);
  assert.ok(a.score >= -100 && a.score <= 100);
  assert.ok(a.score < 0);
});

// ---------------- API route ----------------
import { handleAnalysis } from "./analysis/api.ts";
const post = (body: unknown, path = "/api/analysis/confluence") => handleAnalysis(new Request("https://eti.test" + path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "cf-" + Math.random() }, body: JSON.stringify(body) }), {});
const live = (tf: ConfluenceTf, d: number) => series(tf, d, 120, Date.now());

test("POST /api/analysis/confluence scores supplied candles and is read-only", async () => {
  const r = await post({ symbol: "BTCUSDT", entry: "15m", include: "detections", candles: { "1d": live("1d", 0.6), "4h": live("4h", 0.6), "1h": live("1h", 0.6), "15m": live("15m", 0.6) } });
  assert.equal(r.status, 200);
  const j = await r.json() as any;
  assert.equal(j.symbol, "BTCUSDT");
  assert.ok(["ready", "insufficient"].includes(j.status));
  assert.deepEqual(j.usedTimeframes.sort(), ["15m", "1d", "1h", "4h"].sort());
  assert.ok(j.missingTimeframes.includes("1M"));
  assert.equal(j.submitsOrder, false); assert.equal(j.liveExecutionAllowed, false); assert.equal(j.canTriggerTrade, false);
  assert.ok(j.detections["1h"].every((d: any) => d.timeframe === "1h" && d.confirmationReason && d.invalidation));
  assert.equal(j.dataQuality.orderFlow, "Not requested (add ?orderflow=1 for Bybit trade-tape delta)");
});

test("confluence route rejects unsupported timeframes, bad entry timeframes and malformed candles", async () => {
  assert.equal((await post({ symbol: "BTCUSDT", candles: { "2h": [] } })).status, 400);
  assert.equal((await post({ symbol: "BTCUSDT", entry: "3m", candles: { "1h": live("1h", 0.6) } })).status, 400);
  assert.equal((await post({ symbol: "BTCUSDT", candles: { "1h": [[1, "x", 2, 3, 4, 5]] } })).status, 400);
  assert.equal((await post({ symbol: "BTCUSDT", candles: [] })).status, 400);
  const e = await handleAnalysis(new Request("https://eti.test/api/analysis/confluence", { method: "DELETE" }), {});
  assert.equal(e.status, 405);
});

test("the analysis index advertises the confluence endpoint", async () => {
  const j = await (await handleAnalysis(new Request("https://eti.test/api/analysis"), {})).json() as any;
  assert.ok(j.endpoints.includes("/api/analysis/confluence"));
});
