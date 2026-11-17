import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { FVG_LAYER_JS, withFvgLayer } from "./fvg-layer.ts";

const script = FVG_LAYER_JS.replace(/^<script[^>]*>/, "").replace(/<[/]script>$/, "");

test("FVG browser layer parses and is injected only into the dashboard chart", () => {
  assert.doesNotThrow(() => new vm.Script(script));
  const page = '<html><head></head><body><div id="stack"></div><canvas id="chart"></canvas></body></html>';
  const result = withFvgLayer(page);
  assert.ok(result.includes('id="eti-fvg"'));
  assert.ok(result.includes('id="eti-fvg-js"'));
  assert.equal(withFvgLayer("<html><body>no chart</body></html>"), "<html><body>no chart</body></html>");
});

test("FVG layer labels fresh and partially mitigated zones explicitly", () => {
  assert.match(FVG_LAYER_JS, /UNFILLED/);
  assert.match(FVG_LAYER_JS, /PARTIALLY FILLED/);
  assert.match(FVG_LAYER_JS, /% FILLED/);
  assert.match(FVG_LAYER_JS, /unfilled portion/i);
  assert.match(FVG_LAYER_JS, /unfilledActive/);
  assert.match(FVG_LAYER_JS, /partiallyFilledActive/);
});

test("FVG layer keeps the existing read-only and risk-safe integration", () => {
  assert.match(FVG_LAYER_JS, /canTriggerTrade:false/);
  assert.match(FVG_LAYER_JS, /loadHtf/);
  assert.match(FVG_LAYER_JS, /destination-over/);
  assert.match(FVG_LAYER_JS, /drawChart=function/);
  assert.match(FVG_LAYER_JS, /FVG zones/);
});
