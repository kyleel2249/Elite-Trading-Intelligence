import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SMC_INTELLIGENCE_CSS, SMC_INTELLIGENCE_JS } from "./smc-intelligence.ts";

test("SMC Intelligence script parses and contains confluence evidence UI", () => {
  const script = SMC_INTELLIGENCE_JS.replace(/^<script[^>]*>/, "").replace(/<[/]script>$/, "");
  assert.doesNotThrow(() => new vm.Script(script));
  for (const token of ["api/analysis/confluence", "Directional evidence", "Liquidity targets", "Zone confluence", "Evidence score", "cannot place orders"]) assert.ok(SMC_INTELLIGENCE_JS.includes(token), token);
  assert.ok(SMC_INTELLIGENCE_CSS.includes(".eti-smci-grid"));
  assert.doesNotMatch(SMC_INTELLIGENCE_JS, /fetch\(["']\/api\/orders/);
});

test("SMC Intelligence is chart-aware and stale requests are discarded", () => {
  assert.ok(SMC_INTELLIGENCE_JS.includes('$("tt-chart")'));
  assert.ok(SMC_INTELLIGENCE_JS.includes('$("chart")'));
  assert.ok(SMC_INTELLIGENCE_JS.includes('$("p-struct")'));
  assert.ok(SMC_INTELLIGENCE_JS.includes("let busy=false,sequence=0"));
  assert.ok(SMC_INTELLIGENCE_JS.includes("if(seq!==sequence)return"));
  assert.ok(SMC_INTELLIGENCE_JS.includes("Insufficient or stale timeframe coverage"));
});
