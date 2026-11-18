import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_CENTRE_HTML, COMMAND_CENTRE_JS } from "./command-centre.ts";

test("JARVIS command centre exposes live market, intelligence, risk and health workspaces", () => {
  assert.match(COMMAND_CENTRE_HTML, /Trading Intelligence Command Centre/);
  assert.match(COMMAND_CENTRE_HTML, /AGENT COUNCIL/);
  assert.match(COMMAND_CENTRE_HTML, /RISK &amp; EXECUTION INTELLIGENCE/);
  assert.match(COMMAND_CENTRE_HTML, /SYSTEM HEALTH/);
  assert.match(COMMAND_CENTRE_HTML, /\/terminal/);
});

test("JARVIS dashboard uses live ETI endpoints and never injects API data as HTML", () => {
  for (const endpoint of ["/api/market/ticker", "/api/market/klines", "/api/market/diag", "/api/signals", "/api/omnisignal", "/api/omnisignal/universe", "/api/analysis/technical", "/api/readiness", "/api/execution/status"]) {
    assert.ok(COMMAND_CENTRE_JS.includes(endpoint), "missing " + endpoint);
  }
  assert.ok(COMMAND_CENTRE_JS.includes("textContent"));
  assert.ok(!COMMAND_CENTRE_JS.includes("innerHTML"));
});
