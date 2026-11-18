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
  assert.match(html, /<script[^>]+src="\/bitget-client\.js"/i, "the same-origin Bitget adapter is loaded");
  assert.match(html, /lightweight-charts@4\.1\.3\/dist\/lightweight-charts\.standalone\.production\.js/, "the Pro terminal chart library is reused");
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\/(?!cdn\.jsdelivr\.net\/npm\/lightweight-charts@4\.1\.3)/i, "only the pinned chart library may load from a CDN");
});

test("/elite is served, loads no external script, and carries none of the reference image's sample figures", async () => {
  const { default: app } = await import("./main.ts"), r = await app.fetch(new Request("https://x.test/elite"), {} as any), html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /ETI Elite Trader Intelligence/); assert.doesNotMatch(html, /<script[^>]+src=/i);
  for (const sample of ["2,450", "68.0%", "24,580", "102,500", "92%", "99.9%"]) assert.equal(html.includes(sample), false, "demo figure present: " + sample);
  assert.doesNotMatch(html, /risk[-_ ]?gateway/i);
});

// Regression: the dashboard explicitly loads Bybit and Bitget catalogs and routes chart requests to the selected venue/product.
test("dashboard supports Bybit Worker routes and Bitget browser-direct spot, margin and futures", async () => {
  const { default: app } = await import("./index.ts"), html = await (await app.fetch(new Request("https://x.test/"), {} as any)).text();
  assert.match(html, /venue=bybit/);
  assert.match(html, /market=margin/);
  assert.match(html, /usdt-futures/);
  assert.match(html, /Bitget \(spot, margin &amp; futures\)/);
  assert.match(html, /window\.ETIBitget\.symbols\('all'\)/);
  assert.match(html, /window\.ETIBitget\.symbols\('margin'\)/);
  assert.match(html, /window\.ETIBitget\.marketData/);
  assert.match(html, /bitget-browser/);
  assert.match(html, /function mkt\(\)\{[^}]*venue=/);
  assert.match(html, /const SYM=\{all:\[\],market:'spot',venue:'bybit'/);

  const { handleMarket } = await import("./market.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname === "/v5/market/kline") return new Response(JSON.stringify({ retCode: 0, result: { list: [[String(Date.now()), "100", "103", "99", "102", "12", "0"]] } }));
    return new Response(JSON.stringify({ retCode: 0, result: { list: [], nextPageCursor: "" } }));
  }) as typeof fetch;
  try {
    const call = (path: string) => handleMarket(new Request("https://x.test" + path), {} as any);
    assert.equal((await call("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5")).status, 200);
    assert.equal((await call("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5&market=futures")).status, 200);
    for (const bad of ["venue=all", "venue=binance"]) {
      assert.equal((await call("/api/market/symbols?" + bad)).status, 400, bad);
      assert.equal((await call("/api/market/klines?symbol=BTCUSDT&interval=1m&" + bad)).status, 400, bad);
    }
  } finally { globalThis.fetch = realFetch; }
});

test("dashboard serves an installable PWA manifest, root-scoped service worker and app icon", async () => {
  const { default: app } = await import("./index.ts");
  const call = (path: string) => app.fetch(new Request("https://x.test" + path), {} as any);
  const manifestResponse = await call("/manifest.webmanifest");
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type") || "", /application\/manifest\+json/);
  const manifest: any = await manifestResponse.json();
  assert.equal(manifest.name, "ETI — Elite Trading Intelligence");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/");
  assert.ok(manifest.icons.some((x: any) => x.src === "/app-icon.svg"));
  const sw = await call("/sw.js");
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
  const swText = await sw.text();
  assert.ok(swText.includes('url.pathname.startsWith("/api/")'));
  assert.ok(swText.includes('url.pathname.startsWith("/api/")'));
  const icon = await call("/app-icon.svg");
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") || "", /image\/svg\+xml/);
  const html = await (await call("/")).text();
  assert.match(html, /rel="manifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /eti-install-app/);
  assert.match(html, /register\(['"]\/sw\.js/);
});


test("main dashboard Live Market Chart uses the Pro-style advanced chart and retains its native fallback and analysis panes", async () => {
  const { default: app } = await import("./index.ts"), html = await (await app.fetch(new Request("https://x.test/"), {} as any)).text();
  assert.match(html, /id="chartAdvanced"/);
  assert.match(html, /id="chartFit"/);
  assert.match(html, /id="chartStyle"/);
  assert.match(html, /function initAdvancedLiveChart\(/);
  assert.match(html, /function renderAdvancedLiveChart\(/);
  assert.match(html, /addCandlestickSeries/);
  assert.match(html, /addHistogramSeries/);
  assert.match(html, /pricePrecision/);
  assert.match(html, /minimumFractionDigits:pricePrecision/);
  assert.match(html, /maximumFractionDigits:pricePrecision/);
  assert.match(html, /coordinateToPrice/);
  assert.match(html, /id="paneRsi"/);
  assert.match(html, /id="paneMacd"/);
  assert.match(html, /id="paneAdx"/);
  assert.match(html, /id="paneScore"/);
  assert.match(html, /classList.add\('legacy'\)/);
});
