import { test } from "node:test";
import assert from "node:assert/strict";
import { walletPage } from "./wallet/page.ts";
import { withWallet } from "./wallet/route.ts";

test("wallet page script parses and has no template-literal hazards", () => {
  const html = walletPage();
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
  assert.ok(!script.includes("`") && !script.includes("${") && !script.includes("\\"));
  assert.ok(html.includes("/api/portfolio/state") && html.includes("/api/auth/session"));
});

test("/wallet is served by the Worker without a backend and other routes pass through", async () => {
  const app = withWallet({ fetch: async () => new Response("next", { status: 418 }) });
  const ok = await app.fetch(new Request("https://x.test/wallet"), {});
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") || "", /text\/html/);
  assert.match(await ok.text(), /Wallet/);
  assert.equal((await app.fetch(new Request("https://x.test/wallet/"), {})).status, 200);
  assert.equal((await app.fetch(new Request("https://x.test/other"), {})).status, 418);
  assert.equal((await app.fetch(new Request("https://x.test/wallet", { method: "POST" }), {})).status, 418);
});

import { injectWallet } from "./wallet/inject.ts";

test("the dashboard gets a Wallet section, nav link, styles and script", async () => {
  const page = '<html><head><style>a{}</style></head><body><header><a href="/alpha" style="color:var(--blue)">Global</a></header><main><div class="grid"><section class="panel"><h2>Live Market Chart</h2></section></div></main></body></html>';
  const out = injectWallet(page);
  assert.ok(out.includes('id="walletPanel"') && out.includes('href="#walletPanel"') && out.includes("walletInit();") && out.includes(".wlk{"));
  assert.ok(out.indexOf('id="walletPanel"') < out.indexOf("Live Market Chart"));
  assert.equal(injectWallet(out), out, "idempotent");
  const app = withWallet({ fetch: async () => new Response(page, { headers: { "content-type": "text/html" } }) });
  assert.match(await (await app.fetch(new Request("https://x.test/"), {})).text(), /id="walletPanel"/);
});
