import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { V3_ALPHA_DASHBOARD_JS, withV3AlphaDashboard } from "./v3-alpha-dashboard.ts";

test("V3 Alpha dashboard script parses and mounts only on the main trading dashboard", () => {
  const script = V3_ALPHA_DASHBOARD_JS.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  assert.doesNotThrow(() => new vm.Script(script));
  const page = '<html><head></head><body><section id="institutionalPanel"></section><canvas id="chartAdvanced"></canvas></body></html>';
  const result = withV3AlphaDashboard(page);
  assert.ok(result.includes('id="eti-v3-alpha-css"'));
  assert.ok(result.includes('id="eti-v3-alpha-js"'));
  assert.equal(withV3AlphaDashboard("<html><body>not dashboard</body></html>"), "<html><body>not dashboard</body></html>");
});

test("V3 Alpha dashboard includes live signal evidence, synchronized votes, research gates and D1 history", () => {
  for (const text of ["Signal plan", "Evidence contribution", "Multi-timeframe consensus", "AI agent research gates", "Monte Carlo risk research", "Recorded signal history"]) assert.ok(V3_ALPHA_DASHBOARD_JS.includes(text));
  assert.match(V3_ALPHA_DASHBOARD_JS, /\/api\/algo\/v3-alpha\/intelligence/);
  assert.match(V3_ALPHA_DASHBOARD_JS, /\/api\/algo\/v3-alpha\/signals/);
  assert.match(V3_ALPHA_DASHBOARD_JS, /\/api\/algo\/v3-alpha\/performance/);
  assert.match(V3_ALPHA_DASHBOARD_JS, /submitsOrder=false/);
});

test("V3 Alpha dashboard does not call order submission or execution endpoints", () => {
  assert.doesNotMatch(V3_ALPHA_DASHBOARD_JS, /\/api\/omnisignal\/execute/);
  assert.doesNotMatch(V3_ALPHA_DASHBOARD_JS, /\/api\/orders/);
  assert.doesNotMatch(V3_ALPHA_DASHBOARD_JS, /\/api\/algo\/v3-alpha\/track/);
});
