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

// Regression: Bybit is the only market-data venue, so the dashboard must never ask the market API for another one
// (it used to request venue=all and venue=bitget, which the API rejects with 400 unsupported_venue).
test("dashboard market requests use only the Bybit venue and are accepted by the market API", async () => {
  const { default: app } = await import("./index.ts"), html = await (await app.fetch(new Request("https://x.test/"), {} as any)).text();
  const marketCalls = html.match(/\/api\/market\/(?:symbols|klines)\?[^'"`)]*/g) ?? [];
  assert.ok(marketCalls.length >= 2, "dashboard should request the pair list and candles");
  for (const call of marketCalls) assert.doesNotMatch(call, /venue=(?!bybit\b)/, "non-Bybit venue requested: " + call);
  assert.doesNotMatch(html.match(/function mkt\(\)\{[^}]*\}/)?.[0] ?? "", /venue|[?&]pt=/, "chart requests must not carry a venue or product type");
  assert.match(html, /const SYM=\{all:\[\],market:'spot',venue:'bybit'/);

  const { handleMarket } = await import("./market.ts");
  const realFetch = globalThis.fetch, now = Date.now();
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname === "/v5/market/kline") return new Response(JSON.stringify({ retCode: 0, result: { list: [[String(now), "100", "103", "99", "102", "12", "0"]] } }));
    return new Response(JSON.stringify({ retCode: 0, result: { list: [], nextPageCursor: "" } }));
  }) as typeof fetch;
  try {
    const call = (path: string) => handleMarket(new Request("https://x.test" + path), {} as any);
    assert.equal((await call("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5")).status, 200);
    assert.equal((await call("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5&market=futures")).status, 200);
    assert.notEqual((await call("/api/market/symbols?venue=bybit")).status, 400);
    for (const bad of ["venue=all", "venue=bitget", "venue=binance"]) {
      assert.equal((await call("/api/market/symbols?" + bad)).status, 400, bad);
      assert.equal((await call("/api/market/klines?symbol=BTCUSDT&interval=1m&" + bad)).status, 400, bad);
    }
  } finally { globalThis.fetch = realFetch; }
});
