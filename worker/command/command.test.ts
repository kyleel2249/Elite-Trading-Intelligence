import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { commandPage } from "./page.ts";
import { withCommand } from "./route.ts";
import { assessToken, handleIntel, parseArxiv, parseSec } from "./intel.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const get = (path: string, env: any = {}) => handleIntel(new Request("https://eti.test" + path), env) as Promise<Response>;

const SEC_XML = `<?xml version="1.0"?><feed><entry><title>13F-HR - Example Capital LP (0001234567) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1234567/x-index.htm"/><summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-11-06 &lt;b&gt;AccNo:&lt;/b&gt; 0001234567-26-000001</summary><updated>2026-11-06T16:45:10-05:00</updated></entry><entry><title>4 - SMITH JOHN (0009999999) (Reporting)</title><link href="https://www.sec.gov/y"/><summary>Filed: 2026-11-05</summary><updated>2026-11-05T09:00:00-05:00</updated></entry></feed>`;
const ARXIV_XML = `<feed><entry><id>http://arxiv.org/abs/2611.00001v1</id><updated>2026-11-06T00:00:00Z</updated><published>2026-11-05T12:00:00Z</published><title>Order flow &amp; liquidity
 in crypto markets</title><summary>We study   microstructure.</summary><author><name>A. Author</name></author><author><name>B. Author</name></author><arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="q-fin.TR" scheme="x"/></entry></feed>`;

test("SEC parser separates form, filer, CIK and the filing date from the acceptance time", () => {
  const items = parseSec(SEC_XML);
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].form, items[0].company, items[0].cik, items[0].role, items[0].filedDate], ["13F-HR", "Example Capital LP", "0001234567", "Filer", "2026-11-06"]);
  assert.match(items[0].acceptedAt!, /2026-11-06T16:45/);
  assert.equal(items[1].form, "4");
});

test("arXiv parser decodes entities, collapses whitespace and reads the primary category", () => {
  const [p] = parseArxiv(ARXIV_XML);
  assert.equal(p.title, "Order flow & liquidity in crypto markets");
  assert.deepEqual(p.authors, ["A. Author", "B. Author"]);
  assert.equal(p.category, "q-fin.TR");
});

test("token assessment: a honeypot is CRITICAL and elevates the action", () => {
  const a = assessToken({ is_honeypot: "1", is_open_source: "1", is_mintable: "0", buy_tax: "0", sell_tax: "0.05", creator_percent: "0.01", owner_percent: "0", holders: [{ percent: "0.1" }], lp_holders: [{ percent: "1", is_locked: 1 }], dex: [{ liquidity: "500000" }] });
  assert.equal(a.level, "CRITICAL");
  assert.ok(a.findings.some(f => f.id === "is_honeypot" && f.severity === "CRITICAL" && /is_honeypot = 1/.test(f.evidence)));
  assert.match(a.recommendedAction, /Do not buy/);
});

test("token assessment: missing data is UNKNOWN and is never reported as safe", () => {
  const a = assessToken({ token_name: "X" });
  assert.equal(a.level, "UNKNOWN");
  assert.ok(a.unknown.length >= 7);
  assert.doesNotMatch(a.recommendedAction, /^No flags/);
  assert.match(a.recommendedAction, /not .*safe/i);
});

test("token assessment: clean data is LOW but explicitly not a guarantee; unlocked liquidity and high taxes are flagged", () => {
  const clean = assessToken({ is_honeypot: "0", is_open_source: "1", is_mintable: "0", is_proxy: "0", hidden_owner: "0", buy_tax: "0.01", sell_tax: "0.01", creator_percent: "0.02", owner_percent: "0", holders: [{ percent: "0.05" }], lp_holders: [{ percent: "0.9", is_locked: 1 }], dex: [{ liquidity: "250000" }] });
  assert.equal(clean.level, "LOW");
  assert.match(clean.recommendedAction, /not a safety guarantee/);
  const risky = assessToken({ is_honeypot: "0", is_open_source: "1", is_mintable: "0", buy_tax: "0.12", sell_tax: "0.35", lp_holders: [{ percent: "1", is_locked: 0 }], dex: [{ liquidity: "800" }] });
  const ids = risky.findings.map(f => f.id);
  for (const id of ["buy_tax", "sell_tax", "lp_unlocked", "low_liquidity"]) assert.ok(ids.includes(id), id);
  assert.equal(risky.level, "CRITICAL");
  assert.ok(risky.score <= 100);
});

test("security route validates input before touching the network", async () => {
  globalThis.fetch = (async () => { throw new Error("network must not be called"); }) as typeof fetch;
  assert.equal((await get("/api/intel/security/token?chain=999&address=0x" + "a".repeat(40))).status, 400);
  assert.equal((await get("/api/intel/security/token?chain=1&address=nope")).status, 400);
  assert.equal((await get("/api/intel/sec?form=EVIL")).status, 400);
  assert.equal((await handleIntel(new Request("https://eti.test/api/intel/sec", { method: "POST" }), {}))!.status, 405);
});

test("an upstream failure is reported as an error, never as invented data", async () => {
  globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as typeof fetch;
  for (const p of ["/api/intel/sec", "/api/intel/research", "/api/intel/dex/latest", "/api/intel/security/token?chain=1&address=0x" + "b".repeat(40)]) {
    const r = await get(p); const b = await r.json() as any;
    assert.equal(r.status, 502, p); assert.equal(b.error, "upstream_unavailable"); assert.equal(b.items, undefined); assert.equal(b.level, undefined);
  }
});

test("security route: empty provider result is UNKNOWN with no score; real result carries source and evidence", async () => {
  const addr = "0x" + "c".repeat(40);
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 1, result: {} }), { status: 200 })) as typeof fetch;
  const empty = await (await get("/api/intel/security/token?chain=56&address=" + addr)).json() as any;
  assert.equal(empty.level, "UNKNOWN"); assert.equal(empty.score, null); assert.match(empty.recommendedAction, /not evidence of safety/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: { [addr]: { token_name: "Scam", token_symbol: "SCM", is_honeypot: "1", is_open_source: "0", is_mintable: "1" } } }), { status: 200 })) as typeof fetch;
  const hit = await (await get("/api/intel/security/token?chain=56&address=" + addr.toUpperCase().replace("0X", "0x"))).json() as any;
  assert.equal(hit.level, "CRITICAL"); assert.equal(hit.tokenSymbol, "SCM"); assert.equal(hit.source, "GoPlus Security"); assert.ok(hit.fetchedAt && hit.sourceUrl); assert.ok(hit.findings.every((f: any) => f.evidence));
});

test("SEC and research routes pass through parsed items with source, time and caveat", async () => {
  globalThis.fetch = (async (u: any) => new Response(String(u).includes("sec.gov") ? SEC_XML : ARXIV_XML, { status: 200 })) as typeof fetch;
  const sec = await (await get("/api/intel/sec?form=13F-HR")).json() as any;
  assert.equal(sec.count, 2); assert.match(sec.caveat, /not real-time/); assert.ok(sec.fetchedAt);
  const res = await (await get("/api/intel/research")).json() as any;
  assert.equal(res.items[0].category, "q-fin.TR"); assert.match(res.caveat, /not peer reviewed/);
});

test("DexScreener route maps EVM chains to checkable ids and marks others as not checkable", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify([{ chainId: "bsc", tokenAddress: "0x" + "d".repeat(40), url: "u", description: "d" }, { chainId: "solana", tokenAddress: "So111", url: "u2" }]), { status: 200 })) as typeof fetch;
  const d = await (await get("/api/intel/dex/latest")).json() as any;
  assert.equal(d.items[0].checkChain, "56"); assert.equal(d.items[1].checkChain, null); assert.match(d.caveat, /subset/);
});

test("route wrapper serves /command and /api/intel and delegates everything else untouched", async () => {
  const base = { fetch: async (r: Request) => new Response("base:" + new URL(r.url).pathname) };
  const app = withCommand(base as any);
  const page = await app.fetch(new Request("https://eti.test/command"), {});
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(await page.text(), /ETI Command Centre/);
  assert.equal(await (await app.fetch(new Request("https://eti.test/api/market/klines"), {})).text(), "base:/api/market/klines");
  assert.equal(await (await app.fetch(new Request("https://eti.test/"), {})).text(), "base:/");
  assert.equal((await app.fetch(new Request("https://eti.test/api/intel/nope"), {})).status, 404);
});

// ---- the page itself ----
const html = commandPage();
const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || "";

test("command page script is valid JavaScript after template cooking", () => {
  assert.ok(script.length > 10000);
  assert.doesNotThrow(() => new vm.Script(script), "inline script has a syntax error");
});

test("every static element id the script looks up exists in the page (no dead panels)", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const dynamic = new Set(["chart", "sigDetail", "sigMore", "agRaw"]);
  const used = [...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  const missing = [...new Set(used)].filter(id => !ids.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, []);
  for (const k of ["health", "market", "signal", "kpi", "history", "sec", "research", "providers", "readiness", "feeds", "token", "threats", "dex", "elist", "eprof", "agents", "agrun", "risk", "limits"]) assert.ok(ids.has("b-" + k), "panel body b-" + k);
});

test("the page makes no fabricated-data claims: no hard-coded performance figures and soon-items are disabled", () => {
  assert.doesNotMatch(html, /\+\$2,450|68\.0%|99\.9%|1,247/);
  assert.equal((html.match(/class="item soon"/g) || []).length, (html.match(/aria-disabled="true"/g) || []).length - (html.match(/<button disabled/g) || []).length * 0);
  assert.match(html, /button disabled title="Not built yet">Settings \(soon\)/);
});
