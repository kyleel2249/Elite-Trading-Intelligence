import { test } from "node:test";
import assert from "node:assert/strict";
import { proPage } from "./pro/page.ts";
import { withPro } from "./pro/route.ts";

function inlineScript(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "the page has an inline script");
  return m![1];
}

test("the Pro page embeds a script that parses and never contains template-literal hazards", () => {
  const script = inlineScript(proPage());
  assert.ok(script.length > 1000, "the inline script was actually extracted");
  assert.doesNotThrow(() => new Function(script));
  assert.ok(!script.includes("`"), "no backticks in the embedded script");
  assert.ok(!script.includes("${"), "no dollar-brace sequences in the embedded script");
  assert.ok(!script.includes("\\"), "no backslashes in the embedded script");
});

test("the Pro page reads only real ETI endpoints and contains no sample account figures", () => {
  const html = proPage();
  for (const p of ["/api/market/klines", "/api/signals", "/api/readiness", "/api/daily-report", "/api/execution/status", "/api/system/health"]) assert.ok(html.includes(p), p);
  for (const fake of ["2,450", "68.0%", "99.9%", "+$320", "24,580", "TRADE RECOMMENDED"]) assert.ok(!html.includes(fake), `must not contain demo figure ${fake}`);
  assert.match(html, /Withdrawal permissions/);
});

test("the Pro page is wired to the existing exchange, SMC, agent and account services with one venue contract", () => {
  const html = proPage();
  for (const p of ["venue=bybit&market=", "provider=bybit&market=", "bitget-browser", "ETIBitget.marketData", "ETIBitget.candles", "/api/analysis/smc", "/api/agents/analyze", "/api/agents/autopilot", "/api/bybit/account", "/bitget-client.js"]) assert.ok(html.includes(p), p);
  assert.match(html, /id="ven"/);
  assert.match(html, /Full ETI Dashboard/);
  assert.match(html, /id="mkt"/);
  // Bitget signal, SMC and chart share the same candle set: the signal is rejected if candles belong to another selection.
  assert.match(html, /Bitget candles for this selection are not loaded/);
  // A Bybit response served by another provider is flagged, never presented as Bybit.
  assert.match(html, /WRONG VENUE/);
  // A missing Bitget ticker must not be shown as a 0% change.
  assert.match(html, /fails\.ticker/);
  assert.ok(html.includes("async function pollMarket"));
  assert.ok(html.includes("Full ETI Dashboard"));
});

test("the Pro page cannot place orders and never stores the execution token", () => {
  const html = proPage();
  assert.ok(!html.includes("/api/orders"), "no order endpoint");
  assert.ok(!html.includes("/api/agents/execute"), "no agent execution endpoint");
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(html), "no browser storage of the token");
  assert.match(html, /autocomplete="off"/);
});

test("/pro is served with a nonce CSP that allows the Bitget connector and keeps configured origins", async () => {
  const app = withPro({ fetch: async () => new Response("base") } as any);
  const res = await app.fetch(new Request("https://eti.test/pro"), { ETI_CSP_CONNECT: "https://example.test" } as any);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /connect-src[^;]*https:\/\/api\.bitget\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/capi\.bitget\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/example\.test/);
  assert.match(csp, /connect-src[^;]*'self'/);
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  const html = await res.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`), "inline script carries the nonce");
  assert.ok(html.includes(`<style nonce="${nonce}">`), "inline style carries the nonce");
  assert.ok(!/<(script|style)(?![^>]*\snonce=)[\s>]/i.test(html), "every script and style carries the nonce");
});

test("/pro is served and everything else is delegated", async () => {
  const app = withPro({ fetch: async (r: Request) => new Response(`base:${new URL(r.url).pathname}`) } as any);
  const res = await app.fetch(new Request("https://eti.test/pro"), {} as any);
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.equal(await (await app.fetch(new Request("https://eti.test/command"), {} as any)).text(), "base:/command");
  assert.equal(await (await app.fetch(new Request("https://eti.test/pro", { method: "POST" }), {} as any)).text(), "base:/pro");
});
