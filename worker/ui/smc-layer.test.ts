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
test("SMC layer exposes graphical institutional overlays and per-layer controls", () => {
  for (const label of ["Order blocks", "Mitigated OBs", "Liquidity pools", "BOS / CHoCH", "Sweeps", "POC / VAH / VAL", "Displacement"]) assert.ok(SMC_LAYER_JS.includes(label));
  assert.match(SMC_LAYER_JS, /data\.volumeProfile/);
  assert.match(SMC_LAYER_JS, /data\.displacement/);
  assert.match(SMC_LAYER_JS, /\/api\/analysis\/smc/);
  assert.ok(SMC_LAYER_JS.includes("response&&response.data"));
  assert.ok(SMC_LAYER_JS.includes("finally{busy=false;renderStatus();try{drawChart();}"));
});
test("GainzAlgo V2 and V2 Alpha are surfaced without exposing private signal records", () => {
  assert.match(SMC_LAYER_JS, /GainzAlgo V2 \+ V2 Alpha/);
  assert.match(SMC_LAYER_JS, /\/api\/gainz\/status/);
  assert.match(SMC_LAYER_JS, /V2 \+ V2 Alpha connected/);
  assert.match(SMC_LAYER_JS, /href="\/gainz"/);
  assert.doesNotMatch(SMC_LAYER_JS, /\/api\/gainz\/signals/);
});
test("SMC chart layer is visual-only and never authorises execution", () => {
  assert.match(SMC_LAYER_JS, /window\.etiSmc/);
  assert.doesNotMatch(SMC_LAYER_JS, /fetch\(['"]\/api\/orders/);
  assert.doesNotMatch(SMC_LAYER_JS, /\/api\/gainz\/execute/);
});
