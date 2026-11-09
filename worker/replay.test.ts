import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, bootstrapMeanR, closedWindow, compareEngines, replay, type History } from "./algo/replay.ts";
import { series, rangeSeries } from "./algo/fixtures.ts";
import type { Kline } from "./market.ts";
import type { ClosedTrade } from "./algo/performance.ts";

const M15 = 900_000, T0 = Date.UTC(2026, 0, 1);
/** Chained regime segments (up, range, down, up...) on a continuous 15m grid, so the replay sees several market regimes. */
function regimes(n: number, seed = 3): Kline[] {
  const out: Kline[] = []; let price = 100;
  const plan: [string, number][] = [["up", 0.9], ["range", 0], ["down", -0.9], ["up", 1.2], ["range", 0], ["down", -1.1]];
  const per = Math.floor(n / plan.length);
  plan.forEach(([kind, drift], k) => {
    const seg = kind === "range" ? rangeSeries(per, { base: price, noise: 0.6 * price / 100, seed: seed + k, stepMs: M15, end: 0 }) : series(per, { drift: drift * price / 1000, noise: 0.35 * price / 100, start: price, seed: seed + k, stepMs: M15, end: 0 });
    for (const r of seg) {
      const i = out.length, gap = i === 0 ? 0 : ((((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 0.002; // deterministic +/-0.1% open gaps, as real markets have
      const o = i === 0 ? r[1] : out[i - 1][4] * (1 + gap);
      out.push([T0 + i * M15, o, Math.max(r[2], o), Math.min(r[3], o), r[4], r[5]]);
    }
    price = out.at(-1)![4];
  });
  return out;
}
const build = (base: Kline[]): History => ({ "15m": base, "30m": aggregate(base, 1_800_000, M15), "1h": aggregate(base, 3_600_000, M15), "4h": aggregate(base, 14_400_000, M15) });
const BASE = regimes(4800), HIST = build(BASE);
const cfg = { symbol: "TESTUSDT", strategy: "intraday" as const, stepBars: 4 };

test("aggregate builds aligned OHLCV buckets and drops partial ones", () => {
  const rows: Kline[] = Array.from({ length: 10 }, (_, i) => [T0 + i * M15, 10 + i, 20 + i, 5 + i, 11 + i, 1]);
  const a = aggregate(rows, 3_600_000, M15);
  assert.equal(a.length, 2); assert.equal(a[0][0], T0); assert.equal(a[0][1], 10); assert.equal(a[0][4], 14); assert.equal(a[0][2], 23); assert.equal(a[0][3], 5); assert.equal(a[0][5], 4);
  assert.equal(aggregate(rows.slice(1), 3_600_000, M15).length, 1, "a bucket missing its first candle is not emitted");
});
test("closedWindow never exposes a candle that has not closed by 'now'", () => {
  const rows = HIST["1h"]!, t = rows[50][0];
  assert.equal(closedWindow(rows, "1h", t, 1000).at(-1)![0], rows[49][0], "candle opening exactly at now is still forming");
  assert.equal(closedWindow(rows, "1h", t + 3_600_000, 1000).at(-1)![0], rows[50][0], "candle is visible once its close time is reached");
  assert.equal(closedWindow(rows, "1h", t + 3_599_999, 1000).at(-1)![0], rows[49][0]);
  assert.equal(closedWindow(rows, "1h", t + 3_600_000, 10).length, 10);
});
test("replay rejects short or unordered history instead of producing numbers", async () => {
  await assert.rejects(() => replay({ "15m": BASE.slice(0, 100) }, cfg), /at least 200/);
  const bad = BASE.slice(0, 400).map(r => [...r] as Kline); bad[200][0] = bad[199][0];
  await assert.rejects(() => replay({ "15m": bad }, cfg), /strictly ascending/);
});
test("replay is deterministic and its bookkeeping is internally consistent", async () => {
  const a = await replay(HIST, cfg), b = await replay(HIST, cfg);
  assert.deepEqual(a.trades, b.trades); assert.deepEqual(a.decisions, b.decisions);
  assert.equal(Object.values(a.decisions).reduce((s, v) => s + v, 0) > 0, true);
  assert.ok(a.evaluations >= Object.values(a.decisions).reduce((s, v) => s + v, 0), "every decision came from an evaluation");
  assert.equal(a.inSample.trades + a.outOfSample.trades, a.trades.length);
  assert.ok(a.caveats.some(c => /not a forecast/.test(c)) && a.caveats.some(c => /order-book/.test(c)));
  assert.equal(a.report.status === "ok", a.trades.length >= 30);
  assert.equal(a.expectancyForValidator === null, !(a.report.status === "ok"));
});
test("no lookahead: a replay on truncated history reproduces the earlier trades exactly", async () => {
  const cut = 3600, full = await replay(HIST, cfg), part = await replay(build(BASE.slice(0, cut)), cfg);
  const endTs = BASE[cut - 1][0] + M15, expected = full.trades.filter(t => t.closedAt <= endTs);
  assert.ok(expected.length > 0, "fixture should produce trades before the cut");
  assert.deepEqual(part.trades.map(t => [t.id, t.openedAt, t.closedAt, t.pnl]), expected.map(t => [t.id, t.openedAt, t.closedAt, t.pnl]));
});
test("fills happen on exec-bar opens, stop-outs cost roughly the planned risk, and nothing opens during warm-up", async () => {
  const r = await replay(HIST, cfg), opens = new Set(BASE.map(b => b[0])), first = BASE[120][0];
  assert.ok(r.trades.length > 0);
  for (const t of r.trades) { assert.ok(opens.has(t.openedAt), "fill time is a bar open"); assert.ok(t.openedAt > first); assert.ok(t.closedAt > t.openedAt); assert.ok(t.pnl > -1.6 * t.riskAmount, `loss ${t.pnl} vs risk ${t.riskAmount}`); assert.ok(t.fees > 0); }
  assert.ok(r.maxDrawdownPct >= 0 && Number.isFinite(r.strategyReturnPct) && Number.isFinite(r.buyAndHoldReturnPct));
});
test("paper-engine limits still bind in replay (position cap of zero blocks every trade)", async () => {
  const r = await replay(HIST, { ...cfg, paper: { maxOpenPositions: 0 } });
  assert.equal(r.trades.length, 0); assert.ok(Object.values(r.paperRejections).reduce((s, v) => s + v, 0) >= 0);
  assert.ok(Object.keys(r.paperRejections).every(k => /Max open positions/.test(k)));
});
test("strategy competition runs swift-only, gainz-only and combined on identical data", async () => {
  const c = await compareEngines(HIST, cfg);
  assert.deepEqual(Object.keys(c).sort(), ["combined", "gainz_only", "swift_only"]);
  for (const r of Object.values(c)) assert.equal(r.bars, BASE.length);
  const dec = (k: string) => Object.entries(c[k].decisions).reduce((s, [d, v]) => s + (d === "BUY" || d === "SELL" ? v : 0), 0);
  assert.ok(dec("combined") + dec("swift_only") + dec("gainz_only") > 0);
});
test("bootstrap interval is withheld under 30 trades and brackets the mean otherwise", () => {
  const mk = (n: number): ClosedTrade[] => Array.from({ length: n }, (_, i) => ({ id: "t" + i, engine: "combined", symbol: "X", openedAt: i, closedAt: i + 1, pnl: i % 3 === 0 ? -50 : 75, riskAmount: 50, fees: 0, slippage: 0 }));
  assert.equal(bootstrapMeanR(mk(29)), null);
  const b = bootstrapMeanR(mk(90), 1000, 5)!, again = bootstrapMeanR(mk(90), 1000, 5)!;
  assert.deepEqual(b, again); assert.ok(b.low95 < b.meanR && b.meanR < b.high95); assert.ok(Math.abs(b.meanR - ((30 * -1 + 60 * 1.5) / 90)) < 1e-9);
});

test("entries are offered the NEXT bar's open, never the signal bar's close", async () => {
  const r = await replay(HIST, cfg), byTs = new Map(BASE.map(b => [b[0], b]));
  assert.ok(r.fills.length > 0 && r.fills.length === r.trades.length + r.openAtEnd);
  let differs = 0;
  for (const f of r.fills) { assert.equal(f.marketPrice, byTs.get(f.ts)![1], "price equals that bar's open"); if (f.marketPrice !== f.signalBarClose) differs++; }
  assert.ok(differs > 0, "fixture must distinguish next-open from signal-close, otherwise this test proves nothing");
});

// ---------- data loading ----------
import { fetchBinanceKlines, parseCsvKlines } from "./algo/replay-io.ts";
const row = (t: number, p = 100): (string | number)[] => [t, String(p), String(p + 1), String(p - 1), String(p + 0.5), "10", t + M15 - 1, "0", 1, "0", "0", "0"];
test("Binance loader pages, de-duplicates, drops the forming candle and sends read-only GETs", async () => {
  const urls: string[] = [], now = T0 + 2500 * M15 + 1;
  const pages = [Array.from({ length: 1000 }, (_, i) => row(T0 + i * M15)), Array.from({ length: 1000 }, (_, i) => row(T0 + (999 + i) * M15)), Array.from({ length: 502 }, (_, i) => row(T0 + (1998 + i) * M15))];
  let n = 0;
  const f = async (u: string) => { urls.push(u); return { ok: true, status: 200, json: async () => pages[n++] ?? [] }; };
  const rows = await fetchBinanceKlines("BTCUSDT", "15m", T0, T0 + 3000 * M15, f, now);
  assert.ok(urls.every(u => u.startsWith("https://data-api.binance.vision/api/v3/klines?") && !/api\/v3\/(order|account)/.test(u)));
  assert.equal(rows.length, 2500 - 0, "2500 distinct candles after de-duplication"); assert.ok(rows.every((r, i) => i === 0 || r[0] > rows[i - 1][0]));
  assert.ok(rows.at(-1)![0] + M15 <= now, "forming candle excluded");
});
test("Binance loader fails loudly on HTTP errors, bad shapes and bad symbols", async () => {
  await assert.rejects(() => fetchBinanceKlines("BTCUSDT", "1h", T0, T0 + 1e9, async () => ({ ok: false, status: 451, json: async () => ({}) })), /HTTP 451/);
  await assert.rejects(() => fetchBinanceKlines("BTCUSDT", "1h", T0, T0 + 1e9, async () => ({ ok: true, status: 200, json: async () => ({ msg: "x" }) })), /unexpected response shape/);
  await assert.rejects(() => fetchBinanceKlines("BTCUSDT", "1h", T0, T0 + 1e9, async () => ({ ok: true, status: 200, json: async () => [[1, "a", "b", "c", "d", "e"]] })), /non-numeric/);
  await assert.rejects(() => fetchBinanceKlines("btc/usdt", "1h", T0, T0 + 1e9), /Invalid symbol/);
});
test("CSV parser accepts headers and ms/seconds/ISO times, and rejects inconsistent rows with a line number", () => {
  const ok = parseCsvKlines("time,open,high,low,close,volume\n1767225600000,100,101,99,100.5,10\n1767226500,100.5,102,100,101,12\n2026-01-01T00:30:00Z,101,103,100.5,102,8\n");
  assert.equal(ok.length, 3); assert.equal(ok[1][0], 1767226500000); assert.equal(ok[2][0], Date.parse("2026-01-01T00:30:00Z"));
  assert.throws(() => parseCsvKlines("1767225600000,100,99,101,100,10"), /line 1: inconsistent/);
  assert.throws(() => parseCsvKlines("1767225600000,100,101,99,x,10"), /line 1: non-numeric/);
  assert.throws(() => parseCsvKlines("1767225600000,100,101"), /expected 6 columns/);
});

import { BINANCE_HOSTS } from "./algo/replay-io.ts";
test("fetchBinanceKlines falls back across hosts and reports every failure", async () => {
  const row = (t: number) => [t, "1", "2", "0.5", "1.5", "10"], calls: string[] = [];
  const f = async (u: string) => { calls.push(new URL(u).host); return u.includes("api.binance.com") ? { ok: true, status: 200, json: async () => [row(0), row(900000)] } : { ok: false, status: 451, json: async () => ({}) }; };
  const k = await fetchBinanceKlines("BTCUSDT", "15m", 0, 3_600_000, f as any, 10_000_000);
  assert.equal(k.length, 2); assert.deepEqual(calls.slice(0, 2), ["data-api.binance.vision", "api.binance.com"]);
  const dead = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(fetchBinanceKlines("BTCUSDT", "15m", 0, 3_600_000, dead as any), (e: Error) => BINANCE_HOSTS.every(h => e.message.includes(new URL(h).host)));
});
