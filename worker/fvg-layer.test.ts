import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { Kline } from "./market.ts";
import { FVG_LAYER_JS, withFvgLayer } from "./ui/fvg-layer.ts";
import { withMotion } from "./ui/motion.ts";
import { detectFvgZones, analyzeFvgMtf } from "./analysis/fvg.ts";
import { series, regimeSeries } from "./algo/fixtures.ts";
import worker from "./index.ts";

const script = FVG_LAYER_JS.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
const H = 3600e3, T0 = 1_700_000_000_000;
const k = (i: number, o: number, h: number, l: number, c: number, v = 100, step = H): Kline => [T0 + i * step, o, h, l, c, v];
function bullish(): Kline[] {
  const r: Kline[] = [];
  for (let i = 0; i < 20; i++) r.push(k(i, 100, 100.5, 99.5, 100));
  r.push(k(20, 100, 100.5, 99.5, 100), k(21, 100, 103, 100, 102.8, 300), k(22, 102.8, 104, 102.5, 103.5));
  return r;
}
/** 4h candles ending inside the 1h fixture's time span, so the higher-timeframe zone starts on the visible chart. */
function htfRows(): Kline[] {
  const r: Kline[] = [], t = (i: number) => T0 - 80 * H + i * 4 * H;
  for (let i = 0; i < 21; i++) r.push([t(i), 101, 102, 100.6, 101, 400]);
  r.push([t(21), 101, 105, 101, 104.8, 1200], [t(22), 104.8, 106, 103.5, 105, 400]);
  return r;
}

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
function harness(rows: Kline[], interval = "1h") {
  const log: any[] = [], elements: Record<string, any> = {};
  const chart = el(); const ctx2d = recCtx(log);
  chart.getContext = () => ctx2d; chart.getBoundingClientRect = () => ({ left: 0, top: 0, width: 916, height: 500 });
  const clicks: Function[] = []; chart.addEventListener = (_: string, f: Function) => clicks.push(f);
  elements.chart = chart; elements.stack = el(); elements.interval = Object.assign(el(), { value: interval }); elements.symbol = Object.assign(el(), { value: "BTCUSDT" });
  const urls: string[] = [];
  const sandbox: any = {
    document: { getElementById: (id: string) => elements[id] ?? null, createElement: () => el(), addEventListener() {} },
    window: { console }, console, Date,
    candles: rows, chartScale: { top: 10, bot: 400, lo: 90, hi: 110, plotW: 800 }, FUTURE: 14,
    fp: (v: number) => String(v), mkt: () => "",
    getJson: async (u: string) => { urls.push(u); return { data: u.includes("interval=4h") ? htfRows() : [] }; },
    drawChart() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, log, urls, elements, clicks, api: sandbox.window.etiFvg };
}

test("the layer is valid JavaScript, stores nothing in the browser and is injected into the served dashboard", async () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie|eval\(|new Function/);
  const body = await (await worker.fetch(new Request("https://x.test/"), {} as any, {} as any)).text();
  assert.ok(body.includes('id="eti-fvg"') && body.includes('id="eti-fvg-js"'));
  assert.ok(body.indexOf("eti-chartview-js") < body.indexOf("eti-fvg-js"), "wraps the chart-view draw function");
  assert.equal(withFvgLayer("<html><head></head><body>x</body></html>"), "<html><head></head><body>x</body></html>");
  assert.ok(withMotion("<head></head><body><div id=\"stack\"></div><canvas id=\"chart\"></canvas>const BARS=120</body>").includes("eti-fvg-js"));
});

test("browser detection is identical to the TypeScript engine (parity)", () => {
  const h = harness(bullish());
  const cases: Kline[][] = [bullish(), ...[3, 7, 11].map(seed => series(300, { noise: 1.1, drift: 0.03, seed, end: T0 })), regimeSeries(300, { seed: 5, end: T0 })];
  for (const rows of cases) {
    const a = detectFvgZones(rows, { timeframe: "1h" });
    const b = h.api.detect(rows, { timeframe: "1h" });
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  }
  const inputs = [{ timeframe: "1h", rows: bullish() }, { timeframe: "4h", rows: htfRows() }];
  const a = analyzeFvgMtf("1h", inputs, { includeInactive: true }), b = h.api.analyze("1h", inputs, { includeInactive: true });
  for (const f of ["zones", "summary", "price", "atr", "totalDetected", "canTriggerTrade"]) assert.deepEqual(JSON.parse(JSON.stringify(b[f])), JSON.parse(JSON.stringify((a as any)[f])), f);
});

test("zones are painted behind the candles at exact price positions and labelled", () => {
  const h = harness(bullish());
  h.sandbox.drawChart();
  const sc = h.sandbox.chartScale, step = sc.plotW / (23 + 14), py = (v: number) => sc.bot - (v - sc.lo) / (sc.hi - sc.lo) * (sc.bot - sc.top);
  const fills = h.log.filter(l => l.fn === "fillRect" && l.op === "destination-over");
  assert.ok(fills.length >= 1, "a zone rectangle is painted with destination-over");
  const [x, y, w, hh] = fills[0].a;
  assert.ok(Math.abs(x - 21 * step) < 1e-6, "starts at the displacement candle");
  assert.ok(Math.abs(y - py(102.5)) < 1e-6 && Math.abs(y + hh - py(100.5)) < 1e-6, "top/bottom sit exactly on the gap boundaries");
  assert.ok(Math.abs(x + w - sc.plotW) < 1e-6, "an active zone extends to the live edge");
  assert.match(fills[0].fill, /^rgba\(33, ?214, ?154/, "bullish zones use the bullish colour");
  const text = h.log.filter(l => l.fn === "fillText").map(l => l.a[0]).join("\n");
  assert.match(text, /FVG ▲ BULL 1h · UNFILLED · 0% FILLED/);
  assert.match(text, /gap 2 \(/); assert.match(text, /formed @103.5/);
  assert.equal(h.api.state().hits, 1);
});

test("higher-timeframe zones load from the market-data API, are tagged and show confluence", async () => {
  const h = harness(bullish());
  h.sandbox.drawChart();
  await new Promise(r => setImmediate(r));
  assert.ok(h.urls.some(u => u.includes("interval=4h") && u.includes("symbol=BTCUSDT")));
  assert.ok(h.urls.some(u => u.includes("interval=1d")));
  const zs = h.api.state().zones;
  const tfs: string[] = Array.from(zs, (z: any) => z.timeframe as string).sort();
  assert.equal(tfs.join(","), "1h,4h");
  assert.ok(zs.every((z: any) => z.confluence.length === 1));
  const text = h.log.filter(l => l.fn === "fillText").map(l => l.a[0]).join("\n");
  assert.match(text, /4h/); assert.match(text, /MTF×2/);
});

test("live ticks mitigate a zone and the layer follows without a reload", () => {
  const rows = bullish(), h = harness(rows);
  h.sandbox.drawChart();
  assert.equal(h.api.state().zones[0].status, "fresh");
  rows.push(k(23, 103.5, 103.6, 101.5, 102));
  h.sandbox.drawChart();
  const z = h.api.state().zones.find((q: any) => q.timeframe === "1h");
  assert.equal(z.status, "partially_mitigated"); assert.equal(z.mitigationPct, 50);
  rows.push(k(24, 102, 102.2, 99, 99.5));
  h.sandbox.drawChart();
  assert.equal(h.api.state().zones.filter((q: any) => q.timeframe === "1h" && q.direction === "bullish").length, 0, "the invalidated bullish zone leaves the active set");
});

test("a page without a chart or scale does nothing and never throws", () => {
  const warn: any[] = [];
  const sandbox: any = { document: { getElementById: () => null }, window: {}, console: { warn: (...a: any[]) => warn.push(a) } };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(script, sandbox));
});
