import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { withAgents } from "./route.ts";
import { JARVIS_COMMAND_CENTRE_HTML } from "./command-centre.ts";

test("JARVIS command centre is a live ETI workspace, not a simulated trading screen", () => {
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /api\\/agents\\/jarvis/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /api\\/agents\\/runtime/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /api\\/agents\\/autopilot/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /Commander and Risk Manager/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /sessionStorage/);
  assert.match(JARVIS_COMMAND_CENTRE_HTML, /READ-ONLY INTELLIGENCE/);
  assert.doesNotMatch(JARVIS_COMMAND_CENTRE_HTML, /api\\/orders\\/live/);
});

test("JARVIS command centre inline script parses and the route serves the integrated screen", async () => {
  const scriptStart = JARVIS_COMMAND_CENTRE_HTML.indexOf("<script>") + "<script>".length;
  const scriptEnd = JARVIS_COMMAND_CENTRE_HTML.lastIndexOf("</script>");
  const script = scriptStart >= "<script>".length && scriptEnd > scriptStart
    ? JARVIS_COMMAND_CENTRE_HTML.slice(scriptStart, scriptEnd) : undefined;
  assert.ok(script, "command centre script is present");
  assert.doesNotThrow(() => new vm.Script(script));
  const app = withAgents({ fetch: () => new Response("fallback") });
  const response = await app.fetch(new Request("https://eti.test/jarvis"), {} as any);
  assert.equal(response.status, 200);
  assert.ok((response.headers.get("content-type") || "").includes("text/html"));
  assert.match(await response.text(), /Institutional Trading Command Centre/);
});
