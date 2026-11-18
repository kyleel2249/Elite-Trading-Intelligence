// Offline 13F pipeline: SEC "Form 13F Data Sets" -> aggregated per-CUSIP holdings -> SQL for the D1 table inst_holdings.
//   node scripts/13f-build.ts --current 2026q3_form13f.zip --period 2026-09-30 [--previous 2026q2_form13f.zip --previous-period 2026-06-30]
//        [--out 13f.sql] [--cusip-cache figi-cache.json] [--max-cusips 4000] [--value-multiplier 1]
//   env: OPENFIGI_API_KEY (optional; ~10x faster ticker resolution)
//   then: npx wrangler d1 execute eti-portfolio-db --remote --file 13f.sql
// Data sets: https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets  (download manually or with a descriptive User-Agent; the files are public domain)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { aggregateQuarter, buildSql, resolveTickers, sourceOf } from "./lib/thirteenf.ts";
const a = process.argv.slice(2), arg = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const cur = arg("current"), period = arg("period");
if (!cur || !period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) { console.error("usage: 13f-build.ts --current <zip|dir> --period YYYY-MM-DD [--previous <zip|dir> --previous-period YYYY-MM-DD] [--out file.sql] [--cusip-cache file.json] [--max-cusips N]"); process.exit(2); }
const mult = Number(arg("value-multiplier") ?? 1), maxCusips = Number(arg("max-cusips") ?? 4000), out = arg("out") ?? "13f.sql", cacheFile = arg("cusip-cache") ?? "figi-cache.json";
console.log(`Aggregating ${cur} for ${period} ...`);
const current = await aggregateQuarter(sourceOf(cur), period, { valueMultiplier: mult });
console.log(`  ${current.filings.length} filings, ${current.rowsScanned} rows scanned, ${current.rowsKept} kept, ${current.holdings.size} CUSIPs`);
let previous;
if (arg("previous")) { const pp = arg("previous-period"); if (!pp) { console.error("--previous needs --previous-period"); process.exit(2); } console.log(`Aggregating ${arg("previous")} for ${pp} ...`); previous = await aggregateQuarter(sourceOf(arg("previous")!), pp, { valueMultiplier: mult }); console.log(`  ${previous.holdings.size} CUSIPs`); }
const top = [...current.holdings.values()].sort((x, y) => y.valueUsd - x.valueUsd).slice(0, maxCusips).map(h => h.cusip);
const cache: Record<string, string | null> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
console.log(`Resolving tickers for ${top.length} CUSIPs (${top.filter(c => !(c in cache)).length} not cached) via OpenFIGI ...`);
try { await resolveTickers(top, { apiKey: process.env.OPENFIGI_API_KEY, cache, onProgress: (d, t) => process.stdout.write(`\r  ${d}/${t}`) }); } finally { writeFileSync(cacheFile, JSON.stringify(cache)); }
const names = new Map<string, { cik: string; name: string }>(); for (const f of current.filings) names.set(f.accession, { cik: f.cik, name: f.name });
const { sql, stats } = buildSql({ current, previous, tickers: cache, filerNames: names, source: `SEC Form 13F data set ${cur}`, loadedAt: new Date().toISOString(), maxCusips });
writeFileSync(out, sql);
console.log(`\nWrote ${out}: ${stats.cusips} CUSIPs, ${stats.resolved} with tickers, ${stats.unresolved} unresolved.\nNext: npx wrangler d1 execute eti-portfolio-db --remote --file ${out}`);
