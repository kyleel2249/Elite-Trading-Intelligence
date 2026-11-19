import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SIGNAL_INTEL_JS, withSignalIntelLayer } from "./signal-intel-layer.ts";

test("signal intelligence layer parses and injects only into the live chart page", () => {
  const script = SIGNAL_INTEL_JS.replace(/^<script[^>]*>/, "").replace(/<[/]script>$/, "");
  assert.doesNotThrow(() => new vm.Script(script));
  const page = '<html><head></head><body><div id="stack"></div><canvas id="chart"></canvas><script>function drawChart(){}</script></body></html>';
  const out = withSignalIntelLayer(page);
  assert.ok(out.includes('id="eti-sig-css"') && out.includes('id="eti-sig-js"'));
  assert.equal(withSignalIntelLayer("<html><body>none</body></html>"), "<html><body>none</body></html>");
});
test("layer exposes every overlay control and the explanation panel", () => {
  for (const l of ["BUY / SELL", "Ichimoku", "Supertrend", "Fibonacci", "Entry / SL / TP", "Est. liquidation zones"]) assert.ok(SIGNAL_INTEL_JS.includes(l), l);
  assert.match(SIGNAL_INTEL_JS, /\/api\/analysis\/signal-intel/);
  assert.match(SIGNAL_INTEL_JS, /not a probability of profit/);
  assert.match(SIGNAL_INTEL_JS, /etiSignalPanel/);
});
test("layer is visual-only: no order or execution endpoints", () => {
  assert.doesNotMatch(SIGNAL_INTEL_JS, /\/api\/orders|\/execute|method:\s*["']POST/);
  assert.doesNotMatch(SIGNAL_INTEL_JS, /\\\\"/);
});
test("panel escapes server text before inserting HTML", () => { assert.match(SIGNAL_INTEL_JS, /function esc\(/); });
test("layer reads the field names the API actually emits", async () => {
  const { buildSignalIntel } = await import("../analysis/signal-intel.ts");
  let x = 5, p = 100; const rows: any[] = [], t0 = 1_700_000_000_000;
  for (let i = 0; i < 400; i++) { x = (x * 1664525 + 1013904223) % 4294967296; const o = p, c = p * (1 + 0.001 + (x / 4294967296 - 0.5) * 0.01); rows.push([t0 + i * 3600e3, o, Math.max(o, c) * 1.003, Math.min(o, c) * 0.997, c, 1000]); p = c; }
  const r: any = buildSignalIntel({ symbol: "X", timeframe: "1h", market: "futures", now: rows[399][0] + 7200e3, candles: { "1h": rows } });
  for (const z of r.derivatives.liquidationZones) { assert.ok(["long_liquidations", "short_liquidations"].includes(z.side)); assert.ok(Array.isArray(z.leverages)); }
  assert.match(SIGNAL_INTEL_JS, /long_liquidations/); assert.match(SIGNAL_INTEL_JS, /z\.leverages/);
  for (const k of ["tenkan", "kijun", "cloud", "future"]) assert.ok(k in r.chart.ichimoku);
  assert.ok(Array.isArray(r.chart.supertrend) && "dir" in r.chart.supertrend[0] && "v" in r.chart.supertrend[0]);
  assert.ok(r.chart.markers.every((m: any) => m.label === "BUY" || m.label === "SELL"));
});
