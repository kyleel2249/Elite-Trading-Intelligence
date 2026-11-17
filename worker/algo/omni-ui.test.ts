import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { OMNI_HTML, OMNI_JS } from "./omni-ui.ts";

test("Omnisignal dashboard script parses and exposes venue, derivatives and trade-plan controls", () => {
  assert.doesNotThrow(() => new vm.Script(OMNI_JS));
  for (const marker of ['id="market"', 'id="equity"', 'id="risk"', 'id="contract-value"', 'id="derivatives"', 'id="trade-plan"']) assert.ok(OMNI_HTML.includes(marker), marker);
  assert.match(OMNI_JS, /method:"POST"/);
  assert.match(OMNI_JS, /renderDerivatives/);
  assert.match(OMNI_JS, /renderTradePlan/);
});
