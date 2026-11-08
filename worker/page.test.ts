import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Regression: the dashboard HTML lives in a template literal, so escapes like \n are
// cooked before the browser sees them. A bad escape inside the inline <script> silently
// kills the whole dashboard (blank panels). Parse the cooked script to catch that.
test("embedded dashboard script is valid JavaScript after template cooking", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = src.indexOf("const html = `") + "const html = `".length;
  const end = src.indexOf("</script></body></html>`;") + "</script></body></html>".length;
  assert.ok(start > 13 && end > start, "html template not found");
  const cooked = vm.runInNewContext("`" + src.slice(start, end) + "`") as string;
  const m = cooked.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "inline script missing");
  assert.doesNotThrow(() => new vm.Script(m![1]), "inline dashboard script has a syntax error");
});
