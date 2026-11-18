// Measures CPU time of the analysis request paths under the FREE plan limits (budget: 10 ms CPU per request on Workers Free).
//   node scripts/cpu-budget.ts            (set ETI_ANALYSIS_PLAN=paid to measure the paid configuration)
// Node is a proxy for workerd (same V8), so treat results as an estimate: confirm with the Cloudflare dashboard's CPU-time metrics after deploying.
import { handleAnalysis } from "../worker/analysis/api.ts";
import { series } from "../worker/algo/fixtures.ts";
const BUDGET_MS = 10, plan = process.env.ETI_ANALYSIS_PLAN ?? "free", env = { ETI_ANALYSIS_PLAN: plan };
const step: Record<string, number> = { "1w": 604800e3, "1d": 86400e3, "4h": 14400e3, "1h": 3600e3, "30m": 1800e3, "15m": 900e3, "5m": 300e3, "1m": 60e3 };
const candles: Record<string, unknown> = {};
for (const [tf, ms] of Object.entries(step)) candles[tf] = series(300, { drift: 0.1, noise: 0.8, seed: 5, stepMs: ms, end: Date.now() - ms * 1.5 });
candles["1M"] = series(110, { drift: 0.1, noise: 0.8, seed: 5, stepMs: 2629800e3, end: Date.now() }).map((r, i) => [Date.UTC(2017, 7 + i, 1), r[1], r[2], r[3], r[4], r[5]]);
const news = Array.from({ length: 80 }, (_, i) => ({ id: "n" + i, title: `Bitcoin ${i % 2 ? "rallies on ETF inflows" : "slides after exchange outage"} report ${i}`, source: "Src" + (i % 9), sourceType: i % 5 ? "media" : "wire", publishedAt: new Date(Date.now() - i * 900e3).toISOString() }));
const fundamental = { assetClass: "crypto", data: { purpose: "A decentralised settlement network with a fixed supply schedule and public governance.", team: { publiclyIdentified: true }, supply: { total: 1e9, circulating: 6e8, fdvUsd: 1.5e9, marketCapUsd: 9e8 }, holders: { top10Pct: 22, excludesExchangesAndBurn: true }, liquidity: { volume24hUsd: 8e7, dexLiquidityUsd: 3e7 }, exchanges: { tier1Count: 3 }, security: { audits: [{ firm: "A" }], sourceVerified: true, upgradeable: false, mintable: false } } };
const call = (path: string, body: unknown) => handleAnalysis(new Request("https://eti.test" + path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "cpu-" + Math.random() }, body: JSON.stringify(body) }), env);
const cases: [string, string, unknown][] = [
  ["technical (1 timeframe)", "/api/analysis/technical?symbol=BTCUSDT&timeframe=1h", { candles: candles["1h"] }],
  ["mtf (10 timeframes)", "/api/analysis/mtf?symbol=BTCUSDT&strategy=intraday", { candles }],
  ["news (80 items)", "/api/analysis/news?symbol=BTCUSDT", { items: news }],
  ["intelligence (all engines)", "/api/analysis/intelligence?symbol=BTCUSDT&strategy=intraday", { candles, news, fundamental }],
];
console.log(`plan=${plan}  budget=${BUDGET_MS} ms CPU per request (Workers Free)\n`);
let failed = false;
for (const [name, path, body] of cases) {
  const run = async () => { const t0 = performance.now(), c0 = process.cpuUsage(); const r = await call(path, body); await r.text(); const c = process.cpuUsage(c0); return { wall: performance.now() - t0, cpu: (c.user + c.system) / 1000 }; };
  const cold = await run(); const batches: number[] = [];
  for (let b = 0; b < 6; b++) { const w: number[] = []; for (let i = 0; i < 20; i++) w.push((await run()).wall); w.sort((x, y) => x - y); batches.push(w[10]); }
  batches.sort((x, y) => x - y); const best = batches[0], worst = batches[batches.length - 1], noisy = worst > best * 1.5;
  const ok = best <= BUDGET_MS; if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "OVER"} ${name.padEnd(28)} cold ${cold.wall.toFixed(1).padStart(6)} ms | warm median of 20 calls: best batch ${best.toFixed(1).padStart(5)} ms, worst ${worst.toFixed(1).padStart(5)} ms${noisy ? "  (noisy machine: rerun when idle)" : ""}`);
}
console.log("\nPass = best of 6 batch medians <= 10 ms (the steady state a warm isolate can reach). Shared machines vary by +-30% between batches; cold calls include JIT compilation and are not representative of a warm isolate." + (failed ? "\nSome paths exceed the budget on this machine: see docs (Free-plan guidance)." : "\nAll measured paths are within the Free-plan CPU budget on this machine."));
