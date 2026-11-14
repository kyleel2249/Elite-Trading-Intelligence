// Evaluates sentiment models on labelled headlines and prints accuracy, per-class recall and the confusion matrix.
//   node scripts/sentiment-eval.ts            (dev set; add --heldout to also score the frozen held-out set)
import { DEV } from "../worker/analysis/bench/sentiment-dev.ts";
import { polarity } from "../worker/analysis/sentiment.ts";
import { classify, scoreText } from "../worker/analysis/sentiment-model.ts";
import type { Row } from "../worker/analysis/bench/sentiment-dev.ts";
const heldout = process.argv.includes("--heldout") ? ((await import("../worker/analysis/bench/sentiment-heldout.ts")) as { HELDOUT: Row[] }).HELDOUT : null;
export function evaluate(rows: Row[], model: (r: Row) => "p" | "n" | "0") {
  const labels = ["p", "n", "0"] as const, cm: Record<string, Record<string, number>> = Object.fromEntries(labels.map(a => [a, Object.fromEntries(labels.map(b => [b, 0]))])); let ok = 0;
  for (const r of rows) { const g = model(r); cm[r.label][g]++; if (g === r.label) ok++; }
  const recall = Object.fromEntries(labels.map(l => [l, Number((cm[l][l] / Math.max(1, labels.reduce((s, x) => s + cm[l][x], 0))).toFixed(2))]));
  const f1 = labels.map(l => { const tp = cm[l][l], fp = labels.reduce((s, x) => s + (x === l ? 0 : cm[x][l]), 0), fn = labels.reduce((s, x) => s + (x === l ? 0 : cm[l][x]), 0); return tp ? 2 * tp / (2 * tp + fp + fn) : 0; });
  return { accuracy: Number((ok / rows.length).toFixed(3)), n: rows.length, macroF1: Number((f1.reduce((s, x) => s + x, 0) / 3).toFixed(3)), recall, confusion: cm };
}
const v1 = (r: Row) => classify(polarity(r.text).score), v2 = (r: Row) => classify(scoreText(r.text, { cls: r.cls === "fx" ? "fx" : r.cls, ccy: r.ccy }).score);
for (const [name, rows] of [["DEV", DEV], ...(heldout ? [["HELD-OUT (frozen)", heldout] as const] : [])] as const) {
  console.log(`\n== ${name} (${rows.length} headlines)`); for (const [m, f] of [["v1 lexicon", v1], ["v2 model", v2]] as const) { const e = evaluate(rows as Row[], f); console.log(`${m.padEnd(11)} accuracy ${e.accuracy}  macro-F1 ${e.macroF1}  recall p/n/0: ${e.recall.p}/${e.recall.n}/${e.recall["0"]}`); }
}
