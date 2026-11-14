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
