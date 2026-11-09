#!/usr/bin/env node
// Prints one compact line with every trade's [openedAt, R] per variant from a replay.json, so results from several runs can be pooled.
//   node scripts/pooldump.mjs replay.json SYMBOL STRATEGY
import { readFileSync } from "node:fs";
const all = JSON.parse(readFileSync(process.argv[2] || "replay.json", "utf8")), out = { symbol: process.argv[3], strategy: process.argv[4], variants: {} };
for (const [k, v] of Object.entries(all)) { if (!v || !Array.isArray(v.trades)) continue; out.variants[k] = { bars: v.bars, bh: v.buyAndHoldReturnPct, ret: v.strategyReturnPct, t: v.trades.filter(t => t.riskAmount > 0).map(t => [Math.round(t.openedAt / 1000), Math.round(t.pnl / t.riskAmount * 1000) / 1000, t.regime || "unknown"]) }; }
console.log("POOLDUMP " + JSON.stringify(out));
