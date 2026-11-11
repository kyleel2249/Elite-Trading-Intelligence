import { test } from "node:test";
import assert from "node:assert/strict";
import { proPage } from "./pro/page.ts";
import { withPro } from "./pro/route.ts";

test("the Pro page embeds a script that parses and never contains template-literal hazards", () => {
  const html = proPage();
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
  assert.ok(!script.includes("`"), "no backticks in the embedded script");
  assert.ok(!script.includes("${"), "no dollar-brace sequences in the embedded script");
});

test("the Pro page reads only real ETI endpoints and contains no sample account figures", () => {
  const html = proPage();
  for (const p of ["/api/market/klines", "/api/signals", "/api/readiness", "/api/daily-report", "/api/execution/status", "/api/system/health"]) assert.ok(html.includes(p), p);
  for (const fake of ["2,450", "68.0%", "99.9%", "+$320", "24,580", "TRADE RECOMMENDED"]) assert.ok(!html.includes(fake), `must not contain demo figure ${fake}`);
  assert.match(html, /Withdrawal permissions/);
});

test("/pro is served and everything else is delegated", async () => {
  const app = withPro({ fetch: async (r: Request) => new Response(`base:${new URL(r.url).pathname}`) } as any);
  const res = await app.fetch(new Request("https://eti.test/pro"), {} as any);
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.equal(await (await app.fetch(new Request("https://eti.test/command"), {} as any)).text(), "base:/command");
  assert.equal(await (await app.fetch(new Request("https://eti.test/pro", { method: "POST" }), {} as any)).text(), "base:/pro");
});
