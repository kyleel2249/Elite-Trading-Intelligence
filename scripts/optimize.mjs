#!/usr/bin/env node
// ETI Omnisignal X walk-forward optimizer (offline, read-only; places no orders, needs no credentials, applies nothing).
//   node scripts/optimize.mjs --symbol BTCUSDT --strategy intraday --days 365 [--folds 4] [--out result.json]
//   node scripts/optimize.mjs --csv btc_15m.csv --tf 15m --symbol BTCUSDT --strategy intraday
// Requires Node >= 22.18. Without --csv it downloads public candles from Binance (run where data-api.binance.vision is reachable).
import { readFileSync, writeFileSync } from "node:fs";
import { aggregate } from "../worker/algo/replay.ts";
import { walkForward } from "../worker/algo/optimizer.ts";
import { fetchBinanceKlines, parseCsvKlines } from "../worker/algo/replay-io.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES } from "../worker/algo/timeframes.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : a), []));
const symbol = String(args.symbol || "BTCUSDT").toUpperCase(), strategy = String(args.strategy || "intraday"), days = Number(args.days || 365);
if (!["scalp", "intraday", "swing", "position"].includes(strategy)) { console.error("Unknown --strategy"); process.exit(2); }
const execTf = EXECUTION_TF[strategy]; let history = {};
if (args.csv) {
  const tf = String(args.tf || execTf); if (tf !== execTf) { console.error(`--tf must equal the strategy's execution timeframe (${execTf})`); process.exit(2); }
  const base = parseCsvKlines(readFileSync(String(args.csv), "utf8")).sort((a, b) => a[0] - b[0]), baseMs = TF_SECONDS[tf] * 1000; history[tf] = base;
  for (const t of TIMEFRAMES) { const ms = TF_SECONDS[t] * 1000; if (ms > baseMs && ms % baseMs === 0) history[t] = aggregate(base, ms, baseMs); }
} else {
  const end = Date.now(), start = end - days * 86_400_000;
  for (const t of TIMEFRAMES) { if (TF_SECONDS[t] * 1000 * 100 > end - start && t !== execTf) continue; history[t] = await fetchBinanceKlines(symbol, t, start, end); console.error(`fetched ${history[t].length} ${t} candles`); }
}
const r = await walkForward(history, { folds: Number(args.folds || 4), replay: { symbol, strategy, stepBars: Number(args.step || 4) } });
const text = JSON.stringify(r, (k, v) => (v === Infinity ? "Infinity" : v), 2);
if (args.out) writeFileSync(String(args.out), text);
console.log(text);
console.error(`\nDecision: ${r.promotion.decision}\n${r.promotion.reasons.map(x => " - " + x).join("\n")}\nNothing was applied. Promotion requires a named human approver (ParamRegistry.promote).`);
