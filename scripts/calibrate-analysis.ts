// Walk-forward calibration of the technical engine on REAL history.
//   node scripts/calibrate-analysis.ts BTCUSDT 1h [horizon=10]        (downloads from Binance's public market-data host)
//   node scripts/calibrate-analysis.ts --file candles.json 1d [10]    (JSON array of [openTimeMs,o,h,l,c,v])
// Prints hit rates with 95% intervals against the unconditional baseline. Run it for several markets and timeframes, and distrust a lone positive result.
import { readFileSync } from "node:fs";
import { calibrateTechnical } from "../worker/analysis/calibrate.ts";
import type { Kline } from "../worker/market.ts";
const a = process.argv.slice(2), fileIdx = a.indexOf("--file");
let rows: Kline[], label: string, interval: string, horizon: number;
if (fileIdx >= 0) { rows = JSON.parse(readFileSync(a[fileIdx + 1], "utf8")); label = a[fileIdx + 1]; interval = a[fileIdx + 2] ?? "?"; horizon = Number(a[fileIdx + 3] ?? 10); }
else {
  const [symbol, iv = "1h", h = "10"] = a; if (!symbol) { console.error("usage: calibrate-analysis.ts SYMBOL INTERVAL [horizon] | --file candles.json INTERVAL [horizon]"); process.exit(2); }
  label = symbol; interval = iv; horizon = Number(h); rows = []; let end = Date.now();
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=1000&endTime=${end}`);
    if (!r.ok) { console.error(`Binance HTTP ${r.status}`); process.exit(1); }
    const batch = (await r.json() as any[][]).map(k => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]] as Kline); if (!batch.length) break;
    rows = [...batch, ...rows]; end = batch[0][0] - 1;
  }
}
rows = [...new Map(rows.map(r => [r[0], r])).values()].sort((x, y) => x[0] - y[0]);
const c = calibrateTechnical(rows.slice(0, -1), { timeframe: interval, horizon, maxSamples: 400, detail: "full" });
console.log(`${label} ${interval}: ${rows.length} candles, horizon ${horizon} bars, ${c.samples} samples, baseline up-rate ${c.baselineUpRate}`);
for (const b of c.buckets) console.log(`${b.bucket.padEnd(15)} n=${String(b.n).padStart(3)}  mean fwd ${String(b.meanForwardReturnPct).padStart(7)}%  hit ${b.hitRate ?? "-"}  CI95 ${b.hitRateCI95 ? `[${b.hitRateCI95}]` : "-"}  edge: ${b.edgeVsBaseline}`);
console.log(`\n${c.summary}\n` + c.caveats.map(x => `- ${x}`).join("\n"));
