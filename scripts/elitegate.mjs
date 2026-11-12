#!/usr/bin/env node
// A/B test of the Elite Trader gate on real data (read-only). Same history, same parameters, gate off versus on.
//   node scripts/elitegate.mjs --symbol BTCUSDT --strategy intraday --days 180
import { bootstrapMeanR, replay } from "../worker/algo/replay.ts";
import { fetchBinanceKlines } from "../worker/algo/replay-io.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES } from "../worker/algo/timeframes.ts";
const a = Object.fromEntries(process.argv.slice(2).reduce((x, v, i, all) => (v.startsWith("--") ? [...x, [v.slice(2), all[i + 1]]] : x), []));
const symbol = String(a.symbol || "BTCUSDT").toUpperCase(), strategy = String(a.strategy || "intraday"), days = Number(a.days || 120), execTf = EXECUTION_TF[strategy];
const end = Date.now(), start = end - days * 86_400_000, history = {};
for (const t of TIMEFRAMES) { if (TF_SECONDS[t] * 1000 * 100 > end - start && t !== execTf) continue; history[t] = await fetchBinanceKlines(symbol, t, start, end); }
const cfg = { symbol, strategy, stepBars: 4 };
const sum = (r) => { const T = r.trades.filter(t => t.riskAmount > 0), rs = T.map(t => t.pnl / t.riskAmount); return { trades: T.length, meanR: rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : null, winRate: rs.length ? rs.filter(x => x > 0).length / rs.length : null, bootstrap: bootstrapMeanR(T), oosTrades: r.outOfSample.trades, oosExpectancyR: r.outOfSample.expectancyR }; };
const off = await replay(history, cfg), on = await replay(history, { ...cfg, eliteGate: true });
const out = { symbol, strategy, days, gateOff: sum(off), gateOn: sum(on), tradesRemoved: off.trades.length - on.trades.length };
console.log(JSON.stringify(out, (k, v) => (v === Infinity ? "Infinity" : typeof v === "number" ? Math.round(v * 1000) / 1000 : v)));
