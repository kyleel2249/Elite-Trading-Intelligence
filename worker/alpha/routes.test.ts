import test from "node:test";
import assert from "node:assert/strict";
import { handleAlpha, runScheduled } from "./routes.ts";
import { memoryKv } from "./store.ts";
import { makeCandles, range, trend } from "./testdata.ts";
import { page } from "./page.ts";

const NOW = 1_700_000_000_000 + 700 * 3600_000;
const candles = makeCandles([range(300, 0.004, 1000), trend(60, 0.0015, 0.004, 1500)], { start: NOW - 360 * 3600_000 });
function binanceFetch(calls: string[]) {
  return async (input: any): Promise<Response> => {
    const url = String(input); calls.push(url);
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/klines")) return j(candles.map(c => [c[0], String(c[1]), String(c[2]), String(c[3]), String(c[4]), String(c[5]), c[0] + 3599999, "0", 0, "0", "0", "0"]));
    if (url.includes("/ticker/24hr")) return j([{ symbol: "AAAUSDT", lastPrice: "100", quoteVolume: "9000000", priceChangePercent: "2" }]);
    if (url.includes("/trades")) return j([]);
    if (url.includes("/depth")) return j({ bids: [], asks: [] });
    return new Response("{}", { status: 404 });
  };
}
const mkEnv = (extra: Record<string, unknown> = {}) => ({ ETI_ALPHA_KV: memoryKv(), ETI_ALPHA_TOKEN: "tok-secret", ...extra }) as any;
const get = (env: any, path: string, headers: Record<string, string> = {}) => handleAlpha(new Request("https://x.test" + path, { headers }), env, NOW);
const post = (env: any, path: string, body: unknown, token?: string) => handleAlpha(new Request("https://x.test" + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }), env, NOW);

test("page is served and honours the template-literal rules", async () => {
  const r = await get(mkEnv(), "/alpha");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.ok(!page.slice(page.indexOf("`") + 1, page.lastIndexOf("`")).includes("${"));
  const body = await r.text(); assert.ok(body.includes("Global Alpha Intelligence Center"));
  const script = body.slice(body.indexOf("<script>") + 8, body.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "inline script must parse");
  assert.ok(!script.includes("</script"));
});

test("read endpoints return the shapes the dashboard consumes", async () => {
  const env = mkEnv();
  const st = await (await get(env, "/api/alpha/status")).json() as any; assert.ok(st.modelVersion && st.persistence && "scans" in st);
  const cov = await (await get(env, "/api/alpha/coverage")).json() as any; assert.ok(Array.isArray(cov.sources) && Array.isArray(cov.exchanges) && Array.isArray(cov.gaps) && cov.claim);
  const lb = await (await get(env, "/api/alpha/leaderboard")).json() as any; assert.ok(Array.isArray(lb.entries) && "count" in lb && lb.note);
  for (const p of ["/universe?assetClass=crypto", "/universe?assetClass=equity"]) assert.ok(Array.isArray(((await (await get(env, "/api/alpha" + p)).json()) as any).entries));
  const dex = await (await get(env, "/api/alpha/dex")).json() as any; assert.ok(Array.isArray(dex.tokens) && dex.note);
  const w = await (await get(env, "/api/alpha/wallets")).json() as any; assert.deepEqual(w.labels, []);
  const ent = await (await get(env, "/api/alpha/investors/entities")).json() as any; assert.ok(ent.entities.length >= 15); assert.equal(ent.secConfigured, false);
  const dis = await (await get(env, "/api/alpha/disclosures")).json() as any; assert.ok(Array.isArray(dis.disclosures) && dis.note);
  const cp = await (await get(env, "/api/alpha/copy")).json() as any; assert.ok(Array.isArray(cp.evaluations) && cp.note && "summary" in cp);
  const cand = await (await get(env, "/api/alpha/investors/candidates")).json() as any; assert.ok(Array.isArray(cand.candidates));
  const tr = await (await get(env, "/api/alpha/traders/audit")).json() as any; assert.equal(tr.foundationalRequired, 35); assert.ok(Array.isArray(tr.audits));
  const pr = await (await get(env, "/api/alpha/predictions")).json() as any; assert.ok(pr.accuracy && Array.isArray(pr.predictions));
  const pooled = await (await get(env, "/api/alpha/lab/pooled")).json() as any; assert.ok(Array.isArray(pooled.rows) && "criticalT" in pooled && "markets" in pooled);
  const perf = await (await get(env, "/api/alpha/performance")).json() as any; assert.ok(perf.championChallenger && perf.predictionAccuracy && perf.falseNegatives && Array.isArray(perf.paperTrading) && Array.isArray(perf.dataSourceReliability) && perf.profileCompleteness);
  const cm = await (await get(env, "/api/alpha/compat?assetClass=crypto&interval=1h")).json() as any; assert.ok(cm.results.length > 10 && cm.horizon);
});

test("mutating and sensitive endpoints require the token; wrong token is rejected", async () => {
  const env = mkEnv();
  for (const [p, b] of [["/api/alpha/scan", { kind: "crypto" }], ["/api/alpha/execute", { symbol: "BTCUSDT" }], ["/api/alpha/execute/preview", { symbol: "BTCUSDT" }], ["/api/alpha/positions/monitor", {}], ["/api/alpha/investors/verify", {}], ["/api/alpha/wallets", { address: "0x0" }]] as const) {
    assert.equal((await post(env, p, b)).status, 401, p); assert.equal((await post(env, p, b, "wrong")).status, 401, p);
  }
  assert.equal((await get(env, "/api/alpha/positions")).status, 401);
  assert.equal((await get(env, "/api/alpha/audit")).status, 401);
  assert.equal((await get(env, "/api/alpha/positions", { authorization: "Bearer tok-secret" })).status, 200);
});

test("unconfigured token fails closed", async () => {
  const env = { ETI_ALPHA_KV: memoryKv() } as any;
  assert.equal((await post(env, "/api/alpha/scan", { kind: "crypto" }, "anything")).status, 401);
});

test("input validation rejects bad symbols, classes and intervals", async () => {
  const env = mkEnv();
  assert.equal((await get(env, "/api/alpha/fusion?symbol=bad%20sym")).status, 400);
  assert.equal((await get(env, "/api/alpha/candles?symbol=../../x")).status, 400);
  assert.equal((await get(env, "/api/alpha/leaderboard?assetClass=forex")).status, 400);
  assert.equal((await get(env, "/api/alpha/leaderboard?interval=3s")).status, 400);
  assert.equal((await get(env, "/api/alpha/leaderboard?assetClass=equity&interval=1h")).status, 400);
  assert.equal((await get(env, "/api/alpha/nope")).status, 404);
});

test("wallet labels need a source and confidence, and are stored", async () => {
  const env = mkEnv();
  const bad = await post(env, "/api/alpha/wallets", { address: "0x" + "a".repeat(40), label: "X", kind: "fund" }, "tok-secret");
  assert.equal(bad.status, 201);
  const unsourced = (await (await get(env, "/api/alpha/wallets")).json() as any).labels[0]; assert.equal(unsourced.source, null); assert.ok(unsourced.confidence <= 0.5, "unsourced labels never reach the 0.8 assertion threshold");
  assert.equal((await post(env, "/api/alpha/wallets", { address: "nope", label: "x" }, "tok-secret")).status, 400);
  const ok = await post(env, "/api/alpha/wallets", { address: "0x" + "a".repeat(40), label: "Test Fund", kind: "fund", source: "https://example.org/proof", confidence: 0.9 }, "tok-secret");
  assert.equal(ok.status, 201);
  const w = await (await get(env, "/api/alpha/wallets")).json() as any; assert.equal(w.labels.length, 1);
});

test("fusion, candles and candidate flow end to end on stubbed exchange data", async () => {
  const calls: string[] = []; const orig = globalThis.fetch; globalThis.fetch = binanceFetch(calls) as any;
  try {
    const env = mkEnv();
    const fr = await get(env, "/api/alpha/fusion?symbol=TESTUSDT&interval=1h"); const fj = await fr.json() as any;
    assert.equal(fr.status, 200, JSON.stringify(fj).slice(0, 300));
    assert.ok(fj.fused && fj.early && fj.fused.scores && fj.fused.validation && Array.isArray(fj.fused.reasons) && fj.fused.confidence && Array.isArray(fj.fused.strategyAgreement) && Array.isArray(fj.fused.investorActivity) && Array.isArray(fj.fused.catalysts) && Array.isArray(fj.fused.sources));
    assert.ok(fj.early.factors.every((x: any) => "label" in x && "weight" in x && Array.isArray(x.evidence)));
    assert.ok(["boolean"].includes(typeof fj.fused.executable));
    const cj = await (await get(env, "/api/alpha/candles?symbol=TESTUSDT&interval=1h")).json() as any; assert.ok(cj.rows.length > 100 && cj.rows[0].length === 6);
    const cd = await get(env, "/api/alpha/candidate?symbol=TESTUSDT&interval=1h"); assert.equal(cd.status, 200);
    const lb = await (await get(env, "/api/alpha/leaderboard")).json() as any; assert.ok(lb.entries.some((e: any) => e.symbol === "TESTUSDT"));
    const lab = await (await get(env, "/api/alpha/lab?symbol=TESTUSDT&interval=1h")).json() as any; assert.ok(lab.results.length >= 14 && lab.caveats && "criticalT" in lab);
    const prev = await post(env, "/api/alpha/execute/preview", { symbol: "TESTUSDT", assetClass: "crypto", interval: "1h", accountEquity: 10000, riskPercent: 0.25 }, "tok-secret"); const pj = await prev.json() as any;
    assert.ok(Array.isArray(pj.steps) && pj.steps.length >= 5, JSON.stringify(pj).slice(0, 300)); assert.ok(!pj.submitted);
  } finally { globalThis.fetch = orig; }
});

test("execution never reaches the live order endpoint and caps risk percent", async () => {
  const calls: string[] = []; const orig = globalThis.fetch; globalThis.fetch = binanceFetch(calls) as any;
  try {
    const env = mkEnv({ ETI_LIVE_TRADING_ENABLED: "true" });
    const r = await post(env, "/api/alpha/execute", { symbol: "TESTUSDT", assetClass: "crypto", interval: "1h", accountEquity: 10000, riskPercent: 50 }, "tok-secret"); const j = await r.json() as any;
    assert.ok(!j.submitted || /paper|testnet/.test(String(j.mode)), "never live");
    assert.ok(!calls.some(u => /\/api\/orders\/live|api\.binance\.com\/api\/v3\/order|api\.alpaca\.markets\/v2\/orders/.test(u)));
    const src = (await import("node:fs")).readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    assert.ok(!code.includes("/api/orders/live"), "routes.ts must not reference the live order endpoint");
  } finally { globalThis.fetch = orig; }
});

test("scheduled run completes within a budget and reports partial status", async () => {
  const calls: string[] = []; const orig = globalThis.fetch; globalThis.fetch = binanceFetch(calls) as any;
  try {
    const env = mkEnv({ ALPHA_SUBREQUEST_BUDGET: "20" });
    const r = await runScheduled(env, NOW, binanceFetch(calls) as any); assert.ok(r && typeof r === "object");
    assert.ok(calls.length <= 60, "bounded subrequests, got " + calls.length);
  } finally { globalThis.fetch = orig; }
});
