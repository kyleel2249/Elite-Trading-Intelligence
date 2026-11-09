#!/usr/bin/env node
// Trade-level diagnostics for a replay.json produced with --compare (read-only). Separates what costs take from what the signals earn.
//   node scripts/diagnose.mjs replay.json [variant=combined]
import { readFileSync } from "node:fs";
const all = JSON.parse(readFileSync(process.argv[2] || "replay.json", "utf8")), key = process.argv[3] || "combined", r = all[key] || all;
const T = r.trades.filter(t => t.riskAmount > 0), n = T.length, sum = a => a.reduce((x, y) => x + y, 0), mean = a => (a.length ? sum(a) / a.length : null), q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const R = t => t.pnl / t.riskAmount, gross = t => (t.pnl + t.fees + t.slippage) / t.riskAmount, cost = t => (t.fees + t.slippage) / t.riskAmount;
const grp = (f) => { const m = {}; for (const t of T) (m[f(t)] ??= []).push(t); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { trades: v.length, netR: mean(v.map(R)), grossR: mean(v.map(gross)), winRate: v.filter(t => t.pnl > 0).length / v.length }])); };
const rs = T.map(R), holdH = T.map(t => (t.closedAt - t.openedAt) / 3.6e6);
const out = {
  variant: key, trades: n, netExpectancyR: mean(rs), grossExpectancyR_beforeFeesAndSlippage: mean(T.map(gross)), avgCostR: mean(T.map(cost)), medianCostR: q(T.map(cost), 0.5),
  avgWinR: mean(rs.filter(x => x > 0)), avgLossR: mean(rs.filter(x => x <= 0)), winRate: rs.filter(x => x > 0).length / n,
  rDistribution: { p10: q(rs, 0.1), p25: q(rs, 0.25), p50: q(rs, 0.5), p75: q(rs, 0.75), p90: q(rs, 0.9) },
  fullStopLosses_netR_below_m0_9: rs.filter(x => x < -0.9).length / n, nearBreakeven_between_m0_2_and_0_2: rs.filter(x => Math.abs(x) <= 0.2).length / n, bigWinners_above_1R: rs.filter(x => x > 1).length / n,
  holdHours: { median: q(holdH, 0.5), p90: q(holdH, 0.9) },
  byEngine: grp(t => t.engine), byRegime: grp(t => t.regime || "unknown"),
  byHour: Object.fromEntries(Object.entries(grp(t => String(new Date(t.openedAt).getUTCHours()).padStart(2, "0"))).filter(([, v]) => v.trades >= 10)),
  byMonth: grp(t => new Date(t.openedAt).toISOString().slice(0, 7)),
  byConfidence: grp(t => (t.confidence == null ? "n/a" : String(Math.floor(t.confidence / 10) * 10))),
  paperRejections: r.paperRejections, decisions: r.decisions, agreements: r.agreements, evaluations: r.evaluations, buyAndHoldReturnPct: r.buyAndHoldReturnPct,
};
console.log(JSON.stringify(out, (k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v), 2));
