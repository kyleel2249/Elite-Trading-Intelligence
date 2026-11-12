// Strict type-check of the analysis engine. Pre-existing type errors elsewhere in the repo (e.g. worker/market.ts) are reported but do not fail this gate.
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["tsc", "-p", "tsconfig.analysis.json"], { encoding: "utf8", shell: process.platform === "win32" });
const lines = `${r.stdout}${r.stderr}`.split("\n").filter(l => /error TS/.test(l));
const mine = lines.filter(l => l.startsWith("worker/analysis"));
const other = lines.length - mine.length;
if (other) console.log(`note: ${other} pre-existing type error(s) outside worker/analysis ignored`);
if (mine.length) { console.error(mine.join("\n")); console.error(`\n${mine.length} type error(s) in worker/analysis`); process.exit(1); }
console.log("worker/analysis: strict type-check passed");
