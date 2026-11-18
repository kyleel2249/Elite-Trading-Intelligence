import { test } from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "./market.ts";
import { detectFvgZones, analyzeFvgMtf, closedCount, FVG_RULES } from "./analysis/fvg.ts";
import { series } from "./algo/fixtures.ts";

const H = 3600e3, T0 = 1_700_000_000_000;
/** 20 quiet candles around 100 (range ~1), ATR ~1. */
function base(): Kline[] {
  const rows: Kline[] = [];
  for (let i = 0; i < 20; i++) rows.push([T0 + i * H, 100, 100.5, 99.5, 100, 100]);
  return rows;
}
const k = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => [T0 + i * H, o, h, l, c, v];
/** Bullish gap: c1 high 100.5, displacement candle, c3 low 102.5 -> zone [100.5, 102.5]. */
function bullish(): Kline[] {
  const r = base();
  r.push(k(20, 100, 100.5, 99.5, 100), k(21, 100, 103, 100, 102.8, 300), k(22, 102.8, 104, 102.5, 103.5));
  return r;
}
function bearish(): Kline[] {
  const r = base();
  r.push(k(20, 100, 100.5, 99.5, 100), k(21, 100, 100, 97, 97.2, 300), k(22, 97.2, 97.5, 96, 96.5));
  return r;
}
const opt = { timeframe: "1h" };

test("bullish three-candle imbalance is detected with exact boundaries", () => {
  const z = detectFvgZones(bullish(), opt);
  assert.equal(z.length, 1);
  assert.equal(z[0].direction, "bullish");
  assert.equal(z[0].lower, 100.5); assert.equal(z[0].upper, 102.5); assert.equal(z[0].mid, 101.5);
  assert.equal(z[0].formationPrice, 103.5);
  assert.equal(z[0].status, "fresh"); assert.equal(z[0].active, true);
  assert.equal(z[0].formationTime, T0 + 21 * H);
});

test("bearish three-candle imbalance is detected with exact boundaries", () => {
  const z = detectFvgZones(bearish(), opt);
  assert.equal(z.length, 1);
  assert.equal(z[0].direction, "bearish");
  assert.equal(z[0].upper, 99.5); assert.equal(z[0].lower, 97.5);
});

test("overlapping wicks and gaps below the ATR floor are not FVGs", () => {
  const r = base(); r.push(k(20, 100, 101, 99.5, 100.8), k(21, 100.8, 102, 100.5, 101.8), k(22, 101.8, 102.5, 100.9, 102)); // c1.high 101 > c3.low 100.9
  assert.equal(detectFvgZones(r, opt).length, 0);
  const t = base(); t.push(k(20, 100, 100.5, 99.5, 100), k(21, 100, 101, 100, 100.9), k(22, 100.9, 101.2, 100.55, 101)); // gap 0.05 << 0.15 ATR
  assert.equal(detectFvgZones(t, opt).length, 0);
});

test("a still-forming candle never creates a zone, and the same data without `now` is stable", () => {
  const r = bullish();
  const now = r[22][0] + H / 2; // third candle still open
  assert.equal(closedCount(r, H, now), 22);
  assert.equal(detectFvgZones(r, { timeframe: "1h", now }).length, 0);
  assert.equal(detectFvgZones(r, { timeframe: "1h", now: r[22][0] + H }).length, 1);
});

test("partial mitigation tracks wick depth and keeps the zone active", () => {
  const r = bullish(); r.push(k(23, 103.5, 103.6, 101.5, 102)); // wick to the midpoint
  const z = detectFvgZones(r, opt)[0];
  assert.equal(z.status, "partially_mitigated"); assert.equal(z.active, true);
  assert.equal(z.mitigationPct, 50); assert.equal(z.ceTouched, true); assert.equal(z.touches, 1);
  assert.equal(z.remainingUpper, 101.5); assert.equal(z.remainingLower, 100.5);
  assert.equal(z.endTime, null);
});

test("a wick through the far edge fully mitigates; a close beyond it invalidates (checked first)", () => {
  const f = bullish(); f.push(k(23, 103, 103, 100.4, 100.7)); // wick reaches 100.4 <= lower, close inside
  const fz = detectFvgZones(f, opt)[0];
  assert.equal(fz.status, "fully_mitigated"); assert.equal(fz.active, false); assert.equal(fz.endTime, T0 + 23 * H);
  const v = bullish(); v.push(k(23, 103, 103, 99, 100)); // closes below lower
  const vz = detectFvgZones(v, opt)[0];
  assert.equal(vz.status, "invalidated"); assert.equal(vz.active, false);
});

test("zones expire after maxAgeBars", () => {
  const r = bullish();
  for (let i = 23; i < 40; i++) r.push(k(i, 104, 104.5, 103.6, 104));
  assert.equal(detectFvgZones(r, { ...opt, maxAgeBars: 10 })[0].status, "expired");
  assert.equal(detectFvgZones(r, opt)[0].status, "fresh");
});

test("detection is non-repainting: appending candles never changes an existing zone's identity or boundaries", () => {
  const a = detectFvgZones(bullish(), opt)[0];
  const r = bullish(); r.push(k(23, 103.5, 105, 103.4, 104.5));
  const b = detectFvgZones(r, opt)[0];
  assert.equal(a.id, b.id); assert.equal(a.upper, b.upper); assert.equal(a.lower, b.lower); assert.equal(a.formationPrice, b.formationPrice);
});

test("strength rises with freshness and falls after mitigation", () => {
  const fresh = detectFvgZones(bullish(), opt)[0];
  const r = bullish(); r.push(k(23, 103.5, 103.6, 101.5, 102));
  assert.ok(fresh.strength > detectFvgZones(r, opt)[0].strength);
  assert.ok(fresh.strength >= 0 && fresh.strength <= 100);
});

test("MTF: overlapping same-direction zones on two timeframes are confluent; ranking and caps hold", () => {
  const ltf = bullish();
  const htf: Kline[] = [];
  for (let i = 0; i < 21; i++) htf.push([T0 + i * 4 * H, 101, 102, 100.6, 101, 400]);
  // HTF zone [102, 103.5] overlaps the 1h zone [100.5, 102.5] by a third of the smaller one: confluent, but not a duplicate.
  htf.push([T0 + 21 * 4 * H, 101, 105, 101, 104.8, 1200], [T0 + 22 * 4 * H, 104.8, 106, 103.5, 105, 400]);
  const res = analyzeFvgMtf("1h", [{ timeframe: "1h", rows: ltf }, { timeframe: "4h", rows: htf }], { price: 103.5 });
  const l = res.zones.find(z => z.timeframe === "1h")!, h = res.zones.find(z => z.timeframe === "4h")!;
  assert.ok(l && h);
  assert.equal(l.confluence[0].timeframe, "4h"); assert.equal(h.confluence[0].timeframe, "1h");
  assert.equal(res.canTriggerTrade, false);
  assert.equal(res.summary.nearestSupport?.direction, "bullish");
  assert.ok(analyzeFvgMtf("1h", [{ timeframe: "1h", rows: ltf }], { maxZones: 0 }).zones.length === 0);
});

test("noisy random series never produce malformed zones", () => {
  const rows = series(400, { noise: 1.2, drift: 0.02, seed: 7, end: T0 });
  const zs = detectFvgZones(rows, opt);
  assert.ok(zs.length > 0);
  for (const z of zs) {
    assert.ok(z.upper > z.lower && z.mid > z.lower && z.mid < z.upper);
    assert.ok(z.sizeAtr >= FVG_RULES.minSizeAtr - 1e-9);
    assert.ok(z.mitigationPct >= 0 && z.mitigationPct <= 100);
    assert.equal(z.active, z.status === "fresh" || z.status === "partially_mitigated");
  }
});

import worker from "./index.ts";
test("/api/analysis/fvg returns zones for supplied candles, is read-only and validates input", async () => {
  const post = (body: unknown) => worker.fetch(new Request("https://x.test/api/analysis/fvg", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {} as any, {} as any);
  const res = await post({ symbol: "BTCUSDT", timeframe: "1h", candles: { "1h": bullish() } });
  assert.equal(res.status, 200);
  const j: any = await res.json();
  assert.equal(j.canTriggerTrade, false); assert.equal(j.submitsOrder, false); assert.equal(j.liveExecutionAllowed, false);
  assert.equal(j.zones.length, 1); assert.equal(j.zones[0].upper, 102.5); assert.equal(j.zones[0].lower, 100.5);
  assert.equal((await post({ symbol: "BTCUSDT", timeframe: "7h", candles: {} })).status, 400);
  assert.equal((await post({ symbol: "BTCUSDT", timeframe: "1h", candles: { "1h": [[1, 2]] } })).status, 400);
  assert.equal((await post({ symbol: "BTCUSDT", timeframe: "1h", candles: { "5m": bullish() } })).status, 400);
});
