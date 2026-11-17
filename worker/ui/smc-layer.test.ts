import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SMC_LAYER_JS, withSmcLayer } from "./smc-layer.ts";

test("SMC layer parses and is injected only into the live dashboard chart", () => {
  const script = SMC_LAYER_JS.replace(/^<script[^>]*>/, "").replace(/<[/]script>$/, "");
  assert.doesNotThrow(() => new vm.Script(script));
  const page = '<html><head></head><body><div id="stack"></div><canvas id="chart"></canvas><script>function drawChart(){}</script></body></html>';
  const result = withSmcLayer(page);
  assert.ok(result.includes('id="eti-smc-css"'));
  assert.ok(result.includes('id="eti-smc-js"'));
  assert.equal(withSmcLayer("<html><body>no chart</body></html>"), "<html><body>no chart</body></html>");
});
test("SMC layer exposes controls for order blocks, liquidity pools, BOS/CHoCH and sweeps", () => {
  for (const label of ["Order blocks", "Show mitigated OBs", "Liquidity pools", "BOS / CHoCH", "Liquidity sweeps"]) assert.ok(SMC_LAYER_JS.includes(label));
  assert.match(SMC_LAYER_JS, /destination-over/);
  assert.match(SMC_LAYER_JS, /\/api\/analysis\/smc/);
});
test("SMC chart layer is visual-only and never authorises execution", () => {
  assert.match(SMC_LAYER_JS, /window\.etiSmc/);
  assert.doesNotMatch(SMC_LAYER_JS, /fetch\(['"]\/api\/orders/);
});
