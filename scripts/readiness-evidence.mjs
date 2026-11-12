#!/usr/bin/env node
// Produces the strategy-evidence file used by the Market Readiness Engine (factor 12) from the existing replay lab.
// Read-only: places no orders. Needs Node >= 22.18 and access to data-api.binance.vision.
//   node scripts/readiness-evidence.mjs --symbol BTCUSDT --strategy intraday --days 120 --out evidence.json
import { writeFileSync } from "node:fs";
import { replay } from "../worker/algo/replay.ts";
import { fetchBinanceKlines } from "../worker/algo/replay-io.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES } from "../worker/algo/timeframes.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : a), []));
const symbol = String(args.symbol || "BTCUSDT").toUpperCase(), strategy = String(args.strategy || "intraday"), days = Number(args.days || 120), out = String(args.out || "evidence.json");
if (!["scalp", "intraday", "swing", "position"].includes(strategy)) { console.error("Unknown --strategy"); process.exit(2); }
const end = Date.now(), start = end - days * 86_400_000, history = {};
for (const t of TIMEFRAMES) { if (TF_SECONDS[t] * 1000 * 100 > end - start && t !== EXECUTION_TF[strategy]) continue; history[t] = await fetchBinanceKlines(symbol, t, start, end); console.error(`fetched ${history[t].length} ${t}`); }
const r = await replay(history, { symbol, strategy });
const file = { symbol, strategy, generatedAt: Date.now(), periodStart: r.periodStart, periodEnd: r.periodEnd, source: `ETI replay lab, ${days} days of Binance public candles, fixed default parameters`, trades: r.trades };
writeFileSync(out, JSON.stringify(file));
console.error(`wrote ${out}: ${r.trades.length} trades (win rates are only reported by the engine at >= 30 matching trades)`);
