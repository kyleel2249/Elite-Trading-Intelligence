import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { INDICATOR_OVERLAY_JS, withIndicatorOverlay } from "./indicator-overlay.ts";

const script = INDICATOR_OVERLAY_JS.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
function element() {
  const e: any = { innerHTML: "", textContent: "", style: {}, checked: true, setAttribute() {}, addEventListener() {}, querySelectorAll() { return []; }, parentNode: { insertBefore() {} } };
  return e;
}
function harness() {
  const calls: string[] = [], chart = element(), stack = element(), bar = element(), legend = element();
  const ctx = new Proxy({ globalCompositeOperation: "source-over" } as any, {
    get(t, p: string) { return p in t ? t[p] : (..._a: any[]) => { calls.push(p); }; },
    set(t, p: string, v) { t[p] = v; return true; },
  });
  chart.getContext = () => ctx;
  const elements: Record<string, any> = { chart, stack, symbol: Object.assign(element(), { value: "BTCUSDT" }), interval: Object.assign(element(), { value: "1m" }) };
  let made = 0;
  const rows = Array.from({ length: 260 }, (_, i) => {
    const close = 100 + i * 0.15 + Math.sin(i / 5) * 0.2;
    return [Date.now() - (260 - i) * 60000, close - 0.1, close + 0.25, close - 0.25, close, 100 + i % 9 * 10];
  });
  const sandbox: any = {
    document: { getElementById: (id: string) => elements[id] ?? null, createElement: () => (++made === 1 ? bar : legend) },
    window: { console }, console, Date, candles: rows, chartScale: { top: 10, bot: 400, lo: 90, hi: 150, plotW: 800 },
    drawChart() {}, fmt: (v: number) => v.toFixed(2),
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, calls, bar, legend, elements };
}

test("overlay script parses and is injected only into the real dashboard chart", () => {
  assert.doesNotThrow(() => new vm.Script(script));
  const page = '<html><head></head><body><div id="stack"></div><canvas id="chart"></canvas>function drawChart(){}</body></html>';
  const result = withIndicatorOverlay(page);
  assert.ok(result.includes('id="eti-indicators"'));
  assert.ok(result.includes('id="eti-indicators-js"'));
  assert.equal(withIndicatorOverlay("<html><body>no chart</body></html>"), "<html><body>no chart</body></html>");
});

test("overlay adds readable controls and paints technical lines after chart rendering", () => {
  const h = harness();
  h.sandbox.drawChart();
  assert.match(h.bar.innerHTML, /EMA 20\/50\/200/);
  assert.match(h.bar.innerHTML, /BOS \/ CHoCH \/ Sweeps/);
  assert.match(h.bar.innerHTML, /BUY \/ SELL setup/);
  assert.ok(h.calls.includes("stroke"), "indicator lines are painted");
  assert.ok(h.calls.includes("fillText"), "chart annotations are labelled");
});
