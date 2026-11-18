import test from "node:test";
import assert from "node:assert/strict";
import { JARVIS_COMMAND_CENTRE_HTML } from "./command-centre.ts";

test("JARVIS command centre is a live ETI workspace, not a simulated trading screen", () => {
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /api\/agents\/jarvis/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /api\/agents\/runtime/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /api\/agents\/autopilot/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /Commander and Risk Manager/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /sessionStorage/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /READ-ONLY INTELLIGENCE/);
  assert.doesNotMatch(JARVIS_COMMAND_CENTRE_HTML, /api\/orders\/live/);
});
