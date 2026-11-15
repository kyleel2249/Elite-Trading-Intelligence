import test from "node:test";
import assert from "node:assert/strict";
import { treasuryPage } from "./ui.ts";
import { withTreasury } from "./route.ts";
import { isSimulatedSource } from "./guards.ts";
import { CONTRIBUTION_ACCOUNTS, allocationLines, validateLines } from "./model.ts";

const base = { fetch: () => new Response("base") };
const app = withTreasury(base as any);
const post = (body: unknown) => app.fetch(new Request("https://eti.test/api/treasury/profit-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {} as any);

test("the treasury page is served and its script compiles", async () => {
  const res = await app.fetch(new Request("https://eti.test/treasury"), {} as any);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /ETI Corporate Treasury/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || "";
  assert.ok(script.length > 2000);
  assert.doesNotThrow(() => new Function(script));
});

test("the page works under the nonce CSP: no inline event handlers, no external scripts, no stored tokens", () => {
  const html = treasuryPage();
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie/);
});

test("the page names the environment on every request and never combines the two", () => {
  const html = treasuryPage();
  assert.match(html, /Object\.assign\(\{environment:env\(\)\}/);
  assert.match(html, /'environment='\+encodeURIComponent\(env\(\)\)/);
  assert.match(html, /SIMULATED: test balances only/);
  assert.match(html, /ACTUAL FUNDS/);
  assert.doesNotMatch(html, /\/balances\?/);
});

test("owner contributions can never fund operating funds", () => {
  assert.ok(!(CONTRIBUTION_ACCOUNTS as readonly string[]).includes("1300"));
  assert.deepEqual([...CONTRIBUTION_ACCOUNTS], ["1100", "1400", "1500"]);
  assert.equal(validateLines(allocationLines([{ account: "1300", cents: 5, reason: "x" }])), null);
});

test("simulated sources are recognised, real ones are not", () => {
  for (const s of ["ETI paper trading", "eti_paper", "Binance testnet", "sandbox account", "demo", "Simulated run", "backtest Q3", "dry-run", "mock exchange"]) assert.equal(isSimulatedSource(s), true, s);
  for (const s of ["Binance settlement 2026-11", "Bank statement 4471", "Custody account A", "Interactive Brokers", "", undefined, 42]) assert.equal(isSimulatedSource(s), false, String(s));
});

test("an actual profit batch from a simulated source is refused before it reaches the API", async () => {
  for (const source of ["ETI paper trading", "Alpaca paper", "Binance testnet"]) {
    const res = await post({ environment: "actual", source, grossCents: 100 });
    assert.equal(res.status, 400, source);
    assert.equal(((await res.json()) as any).error, "simulated_source_in_actual_environment");
  }
  const viaDescription = await post({ environment: "actual", source: "Binance", description: "results of the demo account", grossCents: 100 });
  assert.equal(viaDescription.status, 400);
});

test("the same source is allowed in the simulated environment and real sources pass through to authentication", async () => {
  assert.equal((await post({ environment: "simulated", source: "ETI paper trading", grossCents: 100 })).status, 401);
  assert.equal((await post({ environment: "actual", source: "Binance settlement 2026-11", grossCents: 100 })).status, 401);
});

test("other routes are delegated unchanged", async () => {
  const res = await app.fetch(new Request("https://eti.test/market"), {} as any);
  assert.equal(await res.text(), "base");
});
