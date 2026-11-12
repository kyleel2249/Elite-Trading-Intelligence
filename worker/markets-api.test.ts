// HTTP-level tests for /api/markets/* on the Worker (no network).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "./main.ts";
import { handleMarketsApi, settingsFromEnv } from "./markets-api.ts";

const get = (path: string, env: any = {}, init: RequestInit = {}) => worker.fetch(new Request("https://eti.test" + path, init), env);
const j = async (r: Response) => ({ status: r.status, body: await r.json() as any });

test("settings are read from env presence only; empty strings count as missing", () => {
  assert.deepEqual(settingsFromEnv({ OANDA_API_TOKEN: "t", OANDA_ACCOUNT_ID: "" }), { oanda_api_token: "t", oanda_account_id: null, alpaca_api_key: null, alpaca_secret_key: null, binance_api_key: null, binance_secret_key: null });
});
test("non-markets paths are not handled here", () => { assert.equal(handleMarketsApi(new Request("https://eti.test/api/market/klines")), null); });
test("overview lists every asset class, clocks and the edge scope", async () => {
  const { status, body } = await j(await get("/api/markets/overview"));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.asset_classes).sort(), ["commodity", "crypto", "forex", "future", "index", "metal", "option", "stock"]);
  assert.equal(body.asset_classes.future.execution, false); assert.equal(body.sessions.crypto_24x7.state, "open"); assert.equal(body.edge, "cloudflare-worker");
  assert.ok(body.catalog_counts.forex >= 20);
});
test("classify, profile and sessions endpoints", async () => {
  assert.equal((await j(await get("/api/markets/classify?symbol=eur/usd"))).body.tier, "major");
  assert.equal((await j(await get("/api/markets/classify?symbol=1000SATS"))).body.symbol, "1000SATSUSDT");
  assert.equal((await j(await get("/api/markets/profile?symbol=XAUUSD"))).body.profile.key, "metal.gold");
  assert.equal((await j(await get("/api/markets/sessions?session_id=nope"))).status, 404);
  assert.equal((await j(await get("/api/markets/sessions?symbol=BTCUSDT"))).body.state, "open");
  assert.ok(Object.keys((await j(await get("/api/markets/sessions"))).body.sessions).includes("xetra"));
});
test("assess: reflects secrets presence (needs_setup vs configured) and sizes by ATR", async () => {
  const q = "/api/markets/assess?symbol=BTCUSDT&price=70000&atr=1500&account_equity=50000";
  const a = (await j(await get(q))).body;
  assert.equal(a.sizing.stop_source, "atr_x1.5"); assert.ok(a.sizing.quantity > 0); assert.equal(a.execution.routes[0].provider, "binance");
  const fx = (await j(await get("/api/markets/assess?symbol=EURUSD&price=1.085", {}))).body;
  assert.ok(["needs_setup", "wait_for_session"].includes(fx.verdict));
  if (fx.verdict === "needs_setup") assert.match(fx.reasons[0], /OANDA_API_TOKEN/);
  const fx2 = (await j(await get("/api/markets/assess?symbol=EURUSD&price=1.085", { OANDA_API_TOKEN: "t", OANDA_ACCOUNT_ID: "a" }))).body;
  assert.equal(fx2.execution.data.status, "available");
  assert.equal((await j(await get("/api/markets/assess?symbol=MESZ6&price=6000&account_equity=1000000"))).body.verdict, "analysis_only");
});
test("review blocks unsupported provider/market combos and closed live markets", async () => {
  const r = (await j(await get("/api/markets/review?symbol=VOD.L&provider=alpaca&environment=live"))).body;
  assert.ok(r.blocking_reasons.some((x: string) => /alpaca cannot trade stock/.test(x)));
  assert.ok((await j(await get("/api/markets/review?symbol=EURUSD&provider=oanda&environment=testnet"))).body.blocking_reasons.some((x: string) => /no testnet/.test(x)));
});
test("calendars report provenance and explicitly list markets with none", async () => {
  const b = (await j(await get("/api/markets/calendars"))).body;
  assert.equal(b.covered.us_equity.years["2026"], "official"); assert.ok(b.missing.some((m: any) => m.session_id === "ngx"));
  assert.ok(!("crypto_24x7" in b.covered) && !b.missing.some((m: any) => m.session_id === "crypto_24x7"));
});
test("input validation returns 422, wrong methods 405, unknown paths 404; nothing throws", async () => {
  for (const p of ["/api/markets/classify", "/api/markets/classify?symbol=%3Cscript%3E", "/api/markets/assess?symbol=EURUSD&price=-1", "/api/markets/assess?symbol=EURUSD&price=abc",
                   "/api/markets/assess?symbol=EURUSD&risk_pct=99", "/api/markets/assess?symbol=EURUSD&side=hold", "/api/markets/instruments?asset_class=bonds", "/api/markets/assess?symbol=NOPE%3F%3F"]) {
    const r = await get(p); assert.ok(r.status === 422 || (p.includes("NOPE") && r.status === 422), `${p} -> ${r.status}`);
  }
  assert.equal((await j(await get("/api/markets/assess?symbol=ZZ%24%24"))).status, 422);
  assert.equal((await get("/api/markets/assess?symbol=EURUSD", {}, { method: "POST" })).status, 405);
  const nf = await j(await get("/api/markets/snapshot?symbol=BTCUSDT"));
  assert.equal(nf.status, 404); assert.match(nf.body.detail, /Python service/);
  assert.equal((await get("/api/markets/overview", {}, { method: "OPTIONS" })).status, 204);
});
test("existing routes still work behind the new layer", async () => {
  assert.equal((await j(await get("/api/system/health"))).body.status, "ok");
});
