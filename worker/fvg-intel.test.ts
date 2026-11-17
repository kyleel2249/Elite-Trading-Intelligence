import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { Kline } from "./market.ts";
import { detectFvgZones, type FvgZone } from "./analysis/fvg.ts";
import {
  FvgRegistry, fvgLabel, fvgLifecycle, fvgMarketAgreement, fvgMtfAlignmentPoints, formingOpenTime, retrackZone, summarizeFvgDashboard,
} from "./analysis/fvg-intel.ts";
import { assessFvgConfluence } from "./algo/fvg-confluence.ts";
import { FVG_LAYER_JS, withFvgLayer } from "./ui/fvg-layer.ts";
import { FVG_INTEL_JS } from "./ui/fvg-intel-layer.ts";

const H = 3600e3, T0 = 1_700_000_000_000;
const k = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => [T0 + i * H, o, h, l, c, v];
/** 20 quiet candles, then a bullish gap [100.5, 102.5] formed by candles 20-22. */
function bullish(): Kline[] {
  const r: Kline[] = [];
  for (let i = 0; i < 20; i++) r.push(k(i, 100, 100.5, 99.5, 100));
  r.push(k(20, 100, 100.5, 99.5, 100), k(21, 100, 103, 100, 102.8, 300), k(22, 102.8, 104, 102.5, 103.5));
  return r;
}
const zone = (o: Partial<FvgZone> = {}): FvgZone => ({
  id: "1h:bullish:1", timeframe: "1h", direction: "bullish", upper: 102.5, lower: 100.5, mid: 101.5, sizeAbs: 2, sizePct: 2, sizeAtr: 2, formationTime: T0, confirmTime: T0 + H, formationIndex: 1,
  formationPrice: 103.5, status: "fresh", active: true, mitigationPct: 0, endTime: null, touches: 0, ceTouched: false, ageBars: 1, remainingUpper: 102.5, remainingLower: 100.5,
  displacementAtr: 1, volumeRatio: 1, freshness: 1, strength: 50, confluence: [], relevance: 1, ...o,
});

test("lifecycle keeps UNFILLED / PARTIALLY FILLED until the filling candle has closed", () => {
  assert.equal(fvgLifecycle(zone(), null), "unfilled");
  assert.equal(fvgLifecycle(zone({ status: "partially_mitigated", mitigationPct: 40 }), null), "partially_filled");
  const filled = zone({ status: "fully_mitigated", active: false, mitigationPct: 100, endTime: T0 + 5 * H });
  assert.equal(fvgLifecycle(filled, T0 + 5 * H), "filled_pending", "the filling candle is still forming");
  assert.equal(fvgLifecycle(filled, T0 + 6 * H), "filled", "a later candle is forming, so the fill is confirmed");
  assert.equal(fvgLifecycle(filled, null), "filled");
  assert.equal(fvgLifecycle(zone({ status: "invalidated", active: false, endTime: T0 + 5 * H }), null), "invalidated");
  assert.equal(fvgLifecycle(zone({ status: "expired", active: false, endTime: T0 + 5 * H }), T0 + 5 * H), "expired");
  assert.equal(formingOpenTime(bullish(), H, T0 + 22.5 * H), T0 + 22 * H);
  assert.equal(formingOpenTime(bullish(), H, T0 + 40 * H), null);
});

test("labels follow the required wording", () => {
  assert.equal(fvgLabel({ direction: "bullish" }, "unfilled"), "BULLISH FVG – UNFILLED");
  assert.equal(fvgLabel({ direction: "bearish" }, "unfilled"), "BEARISH FVG – UNFILLED");
  assert.equal(fvgLabel({ direction: "bearish" }, "partially_filled"), "BEARISH FVG – PARTIALLY FILLED");
  assert.equal(fvgLabel({ direction: "bullish" }, "filled"), "BULLISH FVG – FILLED");
});

test("registry: no duplicates, fill depth only grows, rolled-off zones keep tracking and confirmed fills are locked", () => {
  const reg = new FvgRegistry(), now = T0 + 100 * H, ctx = (rows: Kline[]) => ({ now, forming: { "1h": null }, rowsByTf: { "1h": rows } });
  const rows = bullish();
  const zs = detectFvgZones(rows, { timeframe: "1h", now });
  assert.equal(zs.length, 1);
  reg.update("spot", zs, ctx(rows)); reg.update("spot", zs, ctx(rows));
  assert.equal(reg.size, 1, "the same zone is never stored twice");
  assert.equal(reg.records()[0].lifecycle, "unfilled");

  rows.push(k(23, 103.5, 103.6, 101.5, 102));
  reg.update("spot", detectFvgZones(rows, { timeframe: "1h", now }), ctx(rows));
  let rec = reg.records("spot")[0];
  assert.equal(rec.lifecycle, "partially_filled"); assert.equal(rec.zone.mitigationPct, 50);

  // the zone scrolls out of the detection window: it is not detected any more but keeps being tracked from the candles that exist
  rows.push(k(24, 102, 102.2, 100.4, 100.9));
  reg.update("spot", [], ctx(rows));
  rec = reg.records("spot")[0];
  assert.equal(rec.lifecycle, "filled"); assert.equal(rec.locked, true);
  assert.equal(rec.zone.status, "fully_mitigated"); assert.equal(rec.zone.mitigationPct, 100);

  // a locked record is never repainted, even if a stale detection reports it fresh again
  reg.update("spot", zs, ctx(rows));
  assert.equal(reg.records("spot")[0].lifecycle, "filled");
  assert.equal(reg.size, 1);

  // other markets keep their own state for the same zone id
  reg.update("futures", zs, ctx(bullish()));
  assert.equal(reg.size, 2);
  assert.equal(reg.records("futures")[0].lifecycle, "unfilled");
});

test("registry never lets a rolling window make a partially filled zone look fresh", () => {
  const reg = new FvgRegistry(), now = T0 + 100 * H, rows = bullish();
  const partial = zone({ status: "partially_mitigated", mitigationPct: 60, remainingUpper: 101.3, freshness: 0.4, touches: 1 });
  reg.update("spot", [partial], { now, forming: {}, rowsByTf: { "1h": rows } });
  reg.update("spot", [zone()], { now, forming: {}, rowsByTf: { "1h": rows } });
  const rec = reg.records("spot")[0];
  assert.equal(rec.lifecycle, "partially_filled"); assert.equal(rec.zone.mitigationPct, 60); assert.equal(rec.zone.remainingUpper, 101.3);
});

test("a forming candle can only make a zone FILL PENDING, and the registry does not lock it", () => {
  const reg = new FvgRegistry(), now = T0 + 24.5 * H;
  const filled = zone({ status: "fully_mitigated", active: false, mitigationPct: 100, endTime: T0 + 24 * H });
  reg.update("spot", [filled], { now, forming: { "1h": T0 + 24 * H }, rowsByTf: {} });
  const rec = reg.records("spot")[0];
  assert.equal(rec.lifecycle, "filled_pending"); assert.equal(rec.locked, false);
});

test("retrackZone only invalidates on closed candles", () => {
  const z = zone({ confirmTime: T0 + 2 * H });
  const rows: Kline[] = [k(3, 103, 103, 102, 102.4), k(4, 102.4, 102.4, 99, 99.5)];
  const closed = retrackZone({ zone: z, trackedThrough: T0 + 3 * H }, rows, T0 + 10 * H);
  assert.equal(closed.status, "invalidated"); assert.equal(closed.endTime, T0 + 4 * H);
  const forming = retrackZone({ zone: z, trackedThrough: T0 + 3 * H }, rows, T0 + 4.5 * H);
  assert.equal(forming.status, "fully_mitigated", "the wick reached the far edge, but the close is not final yet");
});

test("dashboard counts active unfilled bullish and bearish gaps and finds the nearest ones", () => {
  const reg = new FvgRegistry();
  const bear = zone({ id: "1h:bearish:2", direction: "bearish", status: "partially_mitigated", mitigationPct: 40, upper: 108, lower: 106 });
  const hist = zone({ id: "1h:bullish:3", status: "fully_mitigated", active: false, mitigationPct: 100, endTime: T0 + 3 * H });
  reg.update("spot", [zone(), bear, hist], { now: T0 + 50 * H, forming: {}, rowsByTf: {} });
  const d = summarizeFvgDashboard(reg.records("spot"), 104);
  assert.equal(d.bullishUnfilled, 1); assert.equal(d.bearishUnfilled, 0); assert.equal(d.bearishPartial, 1);
  assert.equal(d.bullishActive, 1); assert.equal(d.bearishActive, 1); assert.equal(d.history, 1); assert.equal(d.pending, 0);
  assert.equal(d.nearestBelow?.id, "1h:bullish:1"); assert.equal(d.nearestAbove?.id, "1h:bearish:2");
  assert.deepEqual(d.byTimeframe, { "1h": { bullish: 1, bearish: 1 } });
});

test("market agreement lists the markets that show the same gap", () => {
  const a = zone(), b = zone({ upper: 102.6, lower: 100.6 }), far = zone({ id: "1h:bullish:9", formationTime: T0 + 9 * H, upper: 90, lower: 89 });
  const ag = fvgMarketAgreement({ spot: [a, far], futures: [b], margin: [] });
  assert.deepEqual(ag[a.id], ["futures", "spot"]);
  assert.deepEqual(ag[far.id], ["spot"]);
});

test("multi-timeframe alignment: one timeframe scores nothing, two or more agree or oppose", () => {
  assert.equal(fvgMtfAlignmentPoints(["1h"], []).points, 0);
  assert.equal(fvgMtfAlignmentPoints(["1h", "4h"], []).points, 1);
  assert.equal(fvgMtfAlignmentPoints(["1h", "4h", "1d"], []).points, 1.5);
  assert.equal(fvgMtfAlignmentPoints(["1h", "4h"], ["1d", "1w"]).points, 0);
  assert.equal(fvgMtfAlignmentPoints(["1h"], ["1d", "1w"]).points, -1);
});

test("signal confluence reports the unfilled gaps it weighed", () => {
  const rows: Kline[] = [];
  for (let i = 0; i < 40; i++) rows.push(k(i, 100, 100.5, 99.5, 100));
  rows.push(k(40, 100, 103, 100, 102.8, 300), k(41, 102.8, 104, 102.5, 103.5), k(42, 103.5, 103.8, 103, 103.2), k(43, 103.2, 103.4, 102.9, 103.0));
  const r = assessFvgConfluence({ "1h": rows }, "1h", 1, { entryZone: [102.8, 103.2], stopLoss: 100.2, takeProfits: [{ price: 106 }] }, rows.at(-1)![0] + H);
  assert.ok(r.unfilled && r.unfilled.bullish >= 1 && r.unfilled.timeframes.includes("1h"));
  assert.equal(r.canTriggerTrade, false);
});

// ---------- browser layer ----------
const strip = (s: string) => s.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
const layerScript = strip(FVG_LAYER_JS), intelScript = strip(FVG_INTEL_JS);

function el(): any {
  const kids: Record<string, any> = {}, attrs: Record<string, string> = {};
  const e: any = {
    innerHTML: "", textContent: "", value: "", checked: true, hidden: false, className: "", style: {},
    querySelector: (s: string) => (kids[s] ??= el()), querySelectorAll: () => [],
    setAttribute: (a: string, v: string) => { attrs[a] = v; }, getAttribute: (a: string) => attrs[a] ?? null, addEventListener() {},
    insertBefore() {}, closest: () => null,
  };
  e.parentNode = { insertBefore() {} };
  return e;
}
function recCtx(log: any[]) {
  const store: any = { globalCompositeOperation: "source-over" };
  return new Proxy(store, {
    get: (t, p: string) => (p in t ? t[p] : (...a: any[]) => { log.push({ fn: p, a, op: t.globalCompositeOperation, fill: t.fillStyle }); }),
    set: (t, p: string, v) => { t[p] = v; return true; },
  });
}
function harness(rows: Kline[]) {
  const log: any[] = [], elements: Record<string, any> = {};
  const chart = el(), ctx2d = recCtx(log);
  chart.getContext = () => ctx2d; chart.getBoundingClientRect = () => ({ left: 0, top: 0, width: 916, height: 500 });
  elements.chart = chart; elements.stack = el(); elements.interval = Object.assign(el(), { value: "1h" }); elements.symbol = Object.assign(el(), { value: "BTCUSDT" });
  const sandbox: any = {
    document: { getElementById: (id: string) => elements[id] ?? null, createElement: () => el(), addEventListener() {} },
    window: { console }, console, Date,
    candles: rows, chartScale: { top: 10, bot: 400, lo: 90, hi: 110, plotW: 800 }, FUTURE: 14,
    fp: (v: number) => String(v), mkt: () => "",
    getJson: async () => ({ data: [] }),
    drawChart() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(layerScript, sandbox);
  vm.runInContext(intelScript, sandbox);
  return { sandbox, log, api: sandbox.window.etiFvg, intel: sandbox.window.etiFvgIntel };
}
const texts = (log: any[]) => log.filter(l => l.fn === "fillText").map(l => l.a[0]).join("\n");

test("the intelligence layer is valid, stores nothing in the browser and is injected after the FVG layer", () => {
  assert.doesNotThrow(() => new vm.Script(intelScript));
  assert.doesNotMatch(intelScript, /localStorage|sessionStorage|document\.cookie|eval\(|new Function/);
  const page = withFvgLayer('<html><head></head><body><div id="stack"></div><canvas id="chart"></canvas></body></html>');
  assert.ok(page.includes('id="eti-fvg-js"') && page.includes('id="eti-fvg-intel-js"') && page.includes('id="eti-fvg-intel"'));
  assert.ok(page.indexOf("eti-fvg-js") < page.indexOf("eti-fvg-intel-js"));
});

test("zones carry the required status badge, update live and keep working without a chart", () => {
  const rows = bullish(), h = harness(rows);
  h.sandbox.drawChart();
  const t1 = texts(h.log);
  assert.match(t1, /BULLISH FVG – UNFILLED/);
  assert.match(t1, /FVG ▲ BULL 1h · fresh/, "the existing label is untouched");
  assert.equal(h.intel.records().length, 1);
  rows.push(k(23, 103.5, 103.6, 101.5, 102));
  h.sandbox.drawChart();
  assert.match(texts(h.log), /BULLISH FVG – PARTIALLY FILLED/);
  assert.match(texts(h.log), /50% filled/);
  assert.equal(h.intel.records().length, 1, "still one zone");

  const sandbox: any = { document: { getElementById: () => null }, window: {}, console: { warn() {} } };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(intelScript, sandbox));
});

test("visibility filters hide zones independently", () => {
  const h = harness(bullish());
  h.sandbox.drawChart();
  const f = h.sandbox.window.etiFvgFilter;
  const z = h.api.state().all[0];
  assert.equal(f(z), true);
  h.intel.state().filters.bull = false;
  assert.equal(f(z), false);
  h.intel.state().filters.bull = true; h.intel.state().filters.unf = false;
  assert.equal(f(z), false);
});

test("browser lifecycle, label, retracking and dashboard agree with the TypeScript implementation", () => {
  const h = harness(bullish());
  const cases: FvgZone[] = [
    zone(), zone({ status: "partially_mitigated", mitigationPct: 30 }), zone({ direction: "bearish", status: "fully_mitigated", active: false, endTime: T0 + 5 * H }),
    zone({ status: "invalidated", active: false, endTime: T0 + 5 * H }), zone({ status: "expired", active: false, endTime: T0 + 5 * H }),
  ];
  for (const z of cases) for (const fo of [null, T0 + 5 * H, T0 + 9 * H]) {
    const lc = fvgLifecycle(z, fo);
    assert.equal(h.intel.life(z, fo), lc);
    assert.equal(h.intel.label(z, lc), fvgLabel(z, lc));
  }
  const rows: Kline[] = [k(3, 103, 103, 102, 102.4), k(4, 102.4, 102.4, 101, 101.8)];
  const rec = { zone: zone({ confirmTime: T0 + 2 * H }), trackedThrough: T0 + 3 * H };
  const a = retrackZone(rec, rows, T0 + 10 * H), b = h.intel.retrack(rec, rows, T0 + 10 * H);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  const reg = new FvgRegistry();
  reg.update("spot", [zone(), zone({ id: "1h:bearish:2", direction: "bearish", status: "partially_mitigated", mitigationPct: 40, upper: 108, lower: 106 })], { now: T0, forming: {}, rowsByTf: {} });
  const recs = reg.records("spot");
  assert.deepEqual(JSON.parse(JSON.stringify(h.intel.dashboard(recs, 104))), JSON.parse(JSON.stringify(summarizeFvgDashboard(recs, 104))));
});
