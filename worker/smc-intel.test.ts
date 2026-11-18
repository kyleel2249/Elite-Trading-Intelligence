import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "./market.ts";
import { analyzeSmc, detectInverseFvg, premiumDiscount, SMC_CONFIDENCE_CAP } from "./analysis/smc-intel.ts";
import { detectFVG } from "./analysis/smc.ts";

const T0 = Date.UTC(2026, 0, 1), H = 3600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => [T0 + i * H, o, h, l, c, v];
/** Deterministic oscillating base around 100 (no randomness, so tests are reproducible). */
function base(n: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) { const m = 100 + Math.sin(i / 3) * 2, o = m - 0.2, c = m + 0.2; out.push(bar(i, o, Math.max(o, c) + 0.4, Math.min(o, c) - 0.4, c)); }
  return out;
}
/** Base + an engineered bullish gap: candle 1 high < candle 3 low with a large middle candle. */
function withBullishGap(): { rows: Kline[]; gapLow: number; gapHigh: number; mid: number } {
  const rows = base(40), i = rows.length, p = rows[i - 1][4];
  const c1 = bar(i, p, p + 0.3, p - 0.3, p + 0.1), c2 = bar(i + 1, p + 0.1, p + 4.6, p + 0.1, p + 4.5, 400), c3 = bar(i + 2, p + 4.5, p + 5, p + 3.0, p + 4.8, 150);
  rows.push(c1, c2, c3);
  return { rows, gapLow: c1[2], gapHigh: c3[3], mid: i + 1 };
}

test("fair value gap detections carry timeframe, confirmation, source candles, invalidation and capped confidence", () => {
  const { rows, gapLow, gapHigh } = withBullishGap();
  const a = analyzeSmc(rows, "1h");
  assert.equal(a.status, "ready");
  const fvg = a.detections.find(d => d.kind === "fair_value_gap" && d.direction === "bullish" && Math.abs(d.zone.low - gapLow) < 1e-9);
  assert.ok(fvg, "engineered gap is detected");
  assert.equal(fvg.zone.high, gapHigh);
  assert.equal(fvg.timeframe, "1h");
  assert.equal(fvg.confirmation, "confirmed");
  assert.equal(fvg.sourceCandleTimes.length, 3);
  assert.equal(fvg.invalidation.price, gapLow);
  assert.ok(fvg.confidence > 0 && fvg.confidence <= SMC_CONFIDENCE_CAP);
  assert.equal(fvg.confidenceType, "evidence_quality_not_probability");
  assert.equal(a.submitsOrder, false);
  assert.equal(a.liveExecutionAllowed, false);
});

test("an order block whose displacement is the latest closed candle is labelled unconfirmed", () => {
  const rows = base(40), i = rows.length, p = rows[i - 1][4];
  rows.push(bar(i, p + 0.3, p + 0.35, p - 0.4, p - 0.3, 100));            // last down candle
  rows.push(bar(i + 1, p - 0.3, p + 6, p - 0.35, p + 5.8, 500));          // bullish displacement as the final closed candle
  const a = analyzeSmc(rows, "15m");
  const ob = a.detections.find(d => d.kind === "order_block" && d.direction === "bullish");
  assert.ok(ob, "bullish order block found");
  assert.equal(ob.confirmation, "unconfirmed");
  assert.match(ob.confirmationReason, /no follow-through/);
  const later = analyzeSmc([...rows, bar(i + 2, p + 5.8, p + 6.2, p + 5.5, p + 6, 120)], "15m");
  assert.equal(later.detections.find(d => d.kind === "order_block" && d.direction === "bullish")?.confirmation, "confirmed");
});

test("a close through a bullish FVG creates an inverse (bearish) FVG and a later reclaim invalidates it", () => {
  const { rows, gapLow, gapHigh } = withBullishGap();
  const n = rows.length;
  rows.push(bar(n, rows[n - 1][4], rows[n - 1][4] + 0.2, gapLow - 3, gapLow - 2.5, 300));
  const gaps = detectFVG(rows, 80);
  const inv = detectInverseFvg(rows, gaps).find(f => Math.abs(f.gap.low - gapLow) < 1e-9);
  assert.ok(inv, "inverse FVG found");
  assert.equal(inv.direction, "bearish");
  assert.equal(inv.stillValid, true);
  const a = analyzeSmc(rows, "1h");
  const d = a.detections.find(x => x.kind === "inverse_fvg" && x.direction === "bearish" && Math.abs(x.zone.low - gapLow) < 1e-9);
  assert.ok(d); assert.equal(d.state, "active");
  const n2 = rows.length;
  rows.push(bar(n2, gapLow - 2.5, gapHigh + 1.5, gapLow - 2.6, gapHigh + 1.2, 300));
  const again = detectInverseFvg(rows, detectFVG(rows, 80)).find(f => Math.abs(f.gap.low - gapLow) < 1e-9);
  assert.equal(again?.stillValid, false);
});

test("a wick into a gap without a close through does not create an inverse FVG", () => {
  const { rows, gapLow } = withBullishGap();
  const n = rows.length;
  rows.push(bar(n, rows[n - 1][4], rows[n - 1][4] + 0.1, gapLow - 0.2, gapLow + 1.5, 200));
  assert.equal(detectInverseFvg(rows, detectFVG(rows, 80)).filter(f => Math.abs(f.gap.low - gapLow) < 1e-9).length, 0);
});

test("premium/discount classifies price against the latest confirmed swing range and flags a departed range", () => {
  const rows = base(60), pd = premiumDiscount(rows, "4h");
  assert.ok(pd);
  assert.ok(pd.rangeHigh > pd.rangeLow);
  assert.equal(pd.equilibrium, Number(((pd.rangeHigh + pd.rangeLow) / 2).toFixed(8)));
  assert.ok(["premium", "discount", "equilibrium"].includes(pd.zone));
  assert.equal(pd.outsideRange, pd.positionPct < 0 || pd.positionPct > 100);
  assert.equal(premiumDiscount(rows.slice(0, 5), "4h"), null);
});

test("too little history returns insufficient_history with no detections and no trade capability", () => {
  const a = analyzeSmc(base(10), "1d");
  assert.equal(a.status, "insufficient_history");
  assert.deepEqual(a.detections, []);
  assert.equal(a.canTriggerTrade, false);
});

test("analysis is deterministic and detection ids are stable (no repainting from re-runs)", () => {
  const { rows } = withBullishGap();
  const a = analyzeSmc(rows, "1h"), b = analyzeSmc(rows, "1h");
  assert.deepEqual(a.detections.map(d => d.id), b.detections.map(d => d.id));
  assert.equal(new Set(a.detections.map(d => d.id)).size, a.detections.length, "ids are unique");
});
