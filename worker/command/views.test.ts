import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { commandPageFull } from "./views.ts";
import { withCommand } from "./route.ts";

const html = commandPageFull();
const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || "";

test("composed page serves from /command and still delegates other routes", async () => {
  const app = withCommand({ fetch: async () => new Response("base") } as any);
  const page = await (await app.fetch(new Request("https://eti.test/command"), {})).text();
  assert.match(page, /id="v-portfolio"/); assert.match(page, /id="v-scanner"/);
  assert.equal(await (await app.fetch(new Request("https://eti.test/x"), {})).text(), "base");
});

test("composed script is valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(script), "composed script has a syntax error");
});

test("every static element id the composed script looks up exists", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const dynamic = new Set(["chart", "sigDetail", "sigMore", "agRaw", "pfc"]);
  const used = [...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used)].filter(id => !ids.has(id) && !dynamic.has(id)), []);
  for (const k of ["pf", "pfcurve", "pfanom", "pfpos", "pford", "pfhist", "scan"]) assert.ok(ids.has("b-" + k), "b-" + k);
});

test("Portfolio and Market Scanner are real navigation items; unbuilt items stay disabled", () => {
  assert.match(html, /data-view="portfolio" href="#portfolio">Portfolio</);
  assert.match(html, /data-view="scanner" href="#scanner">Market Scanner</);
  assert.doesNotMatch(html, /Portfolio <em>soon/); assert.doesNotMatch(html, /Market Scanner <em>soon/);
  for (const name of ["Crawler Intel", "Trade Journal", "Analytics", "Reports"]) assert.match(html, new RegExp(name + " <em>soon</em>"));
});

test("the new views contain no hard-coded figures and say what is not met", () => {
  assert.doesNotMatch(html, /\+\$2,450|68\.0%|99\.9%|1,247/);
  assert.match(script, /target is not met/);
  assert.match(script, /Analysis only: this scanner never submits orders/);
  assert.match(script, /not statistically meaningful/);
});

test("health, risk and auto-trade panels read the in-process safeguards engine, not the removed external gateway", () => {
  const last = (name: string) => script.slice(script.lastIndexOf("async function " + name));
  assert.match(last("loadRisk").slice(0, 2500), /Duplicate-order protection/);
  assert.match(last("loadHealth").slice(0, 3000), /In-process safeguards/);
  assert.doesNotMatch(last("loadRisk").slice(0, 2500), /risk_gate_configured/);
  assert.match(last("autoStatus").slice(0, 600), /live_trading_available/);
});
