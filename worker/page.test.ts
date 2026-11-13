import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CALC_CSS, CALC_HTML, CALC_JS } from "./calculator/ui.ts";
import { PORTFOLIO_CSS, PORTFOLIO_HTML, PORTFOLIO_JS, PLAN_HTML } from "./portfolio/ui.ts";
import { PERP_CSS, PERP_HTML, PERP_JS, PERP_ORDER_HTML } from "./perp/ui.ts";
import { VIZ_CSS, VIZ_HTML, VIZ_JS } from "./viz3d/ui.ts";

// Regression: the dashboard HTML lives in a template literal, so escapes like \n are
// cooked before the browser sees them. A bad escape inside the inline <script> silently
// kills the whole dashboard (blank panels). Parse the cooked script to catch that.
test("embedded dashboard script is valid JavaScript after template cooking", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = src.indexOf("const html = `") + "const html = `".length;
  const end = src.indexOf("</script></body></html>`;") + "</script></body></html>".length;
  assert.ok(start > 13 && end > start, "html template not found");
  const cooked = vm.runInNewContext("`" + src.slice(start, end) + "`", { PORTFOLIO_CSS, PORTFOLIO_HTML, PORTFOLIO_JS, PLAN_HTML, CALC_CSS, CALC_HTML, CALC_JS, PERP_CSS, PERP_HTML, PERP_JS, PERP_ORDER_HTML, VIZ_CSS, VIZ_HTML, VIZ_JS }) as string;
  const m = cooked.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "inline script missing");
  assert.doesNotThrow(() => new vm.Script(m![1]), "inline dashboard script has a syntax error");
});

test("portfolio fragments are safe to embed in the dashboard template (no backticks, template holes or backslashes)", () => {
  for (const [name, frag] of Object.entries({ PORTFOLIO_CSS, PORTFOLIO_HTML, PORTFOLIO_JS, PLAN_HTML, CALC_CSS, CALC_HTML, CALC_JS, PERP_CSS, PERP_HTML, PERP_JS, PERP_ORDER_HTML, VIZ_CSS, VIZ_HTML, VIZ_JS })) {
    assert.ok(!frag.includes("`") && !frag.includes("${") && !frag.includes("\\"), name + " contains an unsafe character");
  }
});

test("dashboard ships the 3D motion layer: reduced-motion safe, no external scripts, tilt skips the order panel", async () => {
  const { default: app } = await import("./index.ts"), html = await (await app.fetch(new Request("https://x.test/"), {} as any)).text();
  assert.match(html, /id="eti-motion"/); assert.match(html, /prefers-reduced-motion/); assert.match(html, /execpanel'\)\)return/);
  assert.doesNotMatch(html, /<script[^>]+src=/i, "no external script is loaded");
});

test("/elite is served, loads no external script, and carries none of the reference image's sample figures", async () => {
  const { default: app } = await import("./main.ts"), r = await app.fetch(new Request("https://x.test/elite"), {} as any), html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /ETI Elite Trader Intelligence/); assert.doesNotMatch(html, /<script[^>]+src=/i);
  for (const sample of ["2,450", "68.0%", "24,580", "102,500", "92%", "99.9%"]) assert.equal(html.includes(sample), false, "demo figure present: " + sample);
  assert.doesNotMatch(html, /risk[-_ ]?gateway/i);
});
