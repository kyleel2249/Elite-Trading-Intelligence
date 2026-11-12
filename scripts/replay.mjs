#!/usr/bin/env node
// ETI Omnisignal X historical replay (read-only; places no orders and needs no credentials).
//
//   node scripts/replay.mjs --symbol BTCUSDT --strategy intraday --days 120 [--compare] [--out report.json]
//   node scripts/replay.mjs --csv btc_15m.csv --tf 15m --symbol BTCUSDT --strategy intraday
//
// Requires Node >= 22.18 (runs the TypeScript sources directly). Without --csv it downloads public candles from
// Binance, so it must be run where api access to data-api.binance.vision is available.
import { readFileSync, writeFileSync } from "node:fs";
import { aggregate, compareEngines, replay } from "../worker/algo/replay.ts";
import { fetchBinanceKlines, parseCsvKlines } from "../worker/algo/replay-io.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES } from "../worker/algo/timeframes.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : a), []));
const symbol = String(args.symbol || "BTCUSDT").toUpperCase(), strategy = String(args.strategy || "intraday"), days = Number(args.days || 120);
if (!["scalp", "intraday", "swing", "position"].includes(strategy)) { console.error("Unknown --strategy"); process.exit(2); }
const execTf = EXECUTION_TF[strategy];

let history = {};
if (args.csv) {
  const tf = String(args.tf || execTf); if (!TIMEFRAMES.includes(tf)) { console.error("Unknown --tf"); process.exit(2); }
  if (tf !== execTf) { console.error(`--tf must equal the strategy's execution timeframe (${execTf}) so higher timeframes can be aggregated from it`); process.exit(2); }
  const base = parseCsvKlines(readFileSync(String(args.csv), "utf8")).sort((a, b) => a[0] - b[0]);
  const baseMs = TF_SECONDS[tf] * 1000; history[tf] = base;
  for (const t of TIMEFRAMES) { const ms = TF_SECONDS[t] * 1000; if (ms > baseMs && ms % baseMs === 0) history[t] = aggregate(base, ms, baseMs); }
} else {
  const end = Date.now(), start = end - days * 86_400_000;
  for (const t of TIMEFRAMES) { if (TF_SECONDS[t] * 1000 * 100 > end - start && t !== execTf) continue; history[t] = await fetchBinanceKlines(symbol, t, start, end); console.error(`fetched ${history[t].length} ${t} candles`); }
}
const cfg = { symbol, strategy, stepBars: Number(args.step || 4) };
const result = args.compare ? await compareEngines(history, cfg) : await replay(history, cfg);
const slim = r => ({ ...r, trades: r.trades.length, fills: r.fills.length });
const text = JSON.stringify(args.compare ? Object.fromEntries(Object.entries(result).map(([k, v]) => [k, slim(v)])) : slim(result), (k, v) => (v === Infinity ? "Infinity" : v), 2);
if (args.out) { writeFileSync(String(args.out), JSON.stringify(result, (k, v) => (v === Infinity ? "Infinity" : v), 2)); console.error(`full report (with trades) written to ${args.out}`); }
console.log(text);
