import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BITGET_MARKETS, BitgetError, bitgetCreds, bitgetGetSigned, bitgetSign, getFills, handleBitget, normalizeFills, syncAll } from "./api.ts";

const ENV = { BITGET_API_KEY: "k", BITGET_API_SECRET: "s3cret", BITGET_API_PASSPHRASE: "pp", ETI_EXECUTION_TOKEN: "tok" };
const kvStore = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } }; };
const ok = (data: unknown) => new Response(JSON.stringify({ code: "00000", msg: "success", data }));

test("signature matches Bitget's scheme: base64(HMAC-SHA256(ts + METHOD + path + ?query + body))", async () => {
  const got = await bitgetSign("s3cret", "1700000000000", "get", "/api/v2/spot/trade/fills", "limit=100&symbol=BTCUSDT");
  const want = createHmac("sha256", "s3cret").update("1700000000000GET/api/v2/spot/trade/fills?limit=100&symbol=BTCUSDT").digest("base64");
  assert.equal(got, want);
});

test("credentials are found under alternative names and only names are ever reported", () => {
  const c = bitgetCreds({ BITGET_KEY: "a", BITGET_SECRET_KEY: "b", BITGET_PASSPHRASE: "c" });
  assert.equal(c.complete, true);
  assert.deepEqual(c.found, { key: "BITGET_KEY", secret: "BITGET_SECRET_KEY", passphrase: "BITGET_PASSPHRASE" });
  assert.deepEqual(bitgetCreds({ BITGET_API_KEY: "a" }).missing, ["BITGET_API_SECRET", "BITGET_API_PASSPHRASE"]);
});

test("only allowlisted GET endpoints can be signed (no order, transfer or withdrawal path exists)", async () => {
  for (const p of ["/api/v2/spot/trade/place-order", "/api/v2/spot/wallet/withdrawal", "/api/v2/spot/wallet/transfer", "/api/v2/mix/order/place-order"]) {
    await assert.rejects(bitgetGetSigned(ENV, p, {}, { fetchImpl: (async () => { throw new Error("must not be called"); }) as any }), (e: any) => e instanceof BitgetError && e.code === "path_not_allowed");
  }
});

test("a signed request carries the four ACCESS headers and a sorted, encoded query", async () => {
  let seen: any = null;
  await bitgetGetSigned(ENV, "/api/v2/spot/trade/fills", { symbol: "BTCUSDT", limit: 5 }, { now: () => 1700000000000, fetchImpl: (async (u: string, init: any) => { seen = { u, init }; return ok([]); }) as any });
  assert.equal(seen.u, "https://api.bitget.com/api/v2/spot/trade/fills?limit=5&symbol=BTCUSDT");
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.headers["ACCESS-KEY"], "k");
  assert.equal(seen.init.headers["ACCESS-TIMESTAMP"], "1700000000000");
  assert.equal(seen.init.headers["ACCESS-PASSPHRASE"], "pp");
  assert.equal(seen.init.headers["ACCESS-SIGN"], createHmac("sha256", "s3cret").update("1700000000000GET/api/v2/spot/trade/fills?limit=5&symbol=BTCUSDT").digest("base64"));
});

test("Bitget error codes and non-JSON responses are surfaced, never turned into empty success", async () => {
  await assert.rejects(bitgetGetSigned(ENV, "/api/v2/spot/account/assets", {}, { fetchImpl: (async () => new Response(JSON.stringify({ code: "40018", msg: "Invalid IP" }))) as any }), (e: any) => e.code === "bitget_40018");
  await assert.rejects(bitgetGetSigned(ENV, "/api/v2/spot/account/assets", {}, { fetchImpl: (async () => new Response("blocked", { status: 403 })) as any }), (e: any) => e.code === "geo_or_ip_blocked");
  await assert.rejects(bitgetGetSigned({}, "/api/v2/spot/account/assets", {}), (e: any) => e.code === "credentials_missing");
});

test("fills from spot, futures and margin normalise to one shape", () => {
  const spot = normalizeFills("spot", [{ tradeId: "1", symbol: "BTCUSDT", orderId: "9", side: "Buy", priceAvg: "100", size: "2", amount: "200", feeDetail: { feeCoin: "USDT", totalFee: "-0.2" }, tradeScope: "taker", cTime: "1700000000000" }]);
  assert.deepEqual(spot[0], { id: "1", market: "spot", symbol: "BTCUSDT", orderId: "9", side: "buy", price: 100, qty: 2, quoteQty: 200, fee: 0.2, feeCoin: "USDT", role: "taker", ts: 1700000000000, realizedPnl: null, tradeSide: null });
  const mix = normalizeFills("usdt-futures", { fillList: [{ tradeId: "7", symbol: "ETHUSDT", orderId: "8", side: "sell", price: "50", baseVolume: "3", quoteVolume: "150", profit: "-1.5", tradeSide: "close", feeDetail: [{ feeCoin: "USDT", totalFee: "-0.09" }], cTime: "1700000001000" }], endId: "x" });
  assert.equal(mix[0].realizedPnl, -1.5); assert.equal(mix[0].qty, 3); assert.equal(mix[0].tradeSide, "close");
  const mg = normalizeFills("margin-crossed", { fills: [{ tradeId: "5", symbol: "BTCUSDT", orderId: "1", side: "sell", priceAvg: "10", size: "1", amount: "10", feeDetail: [{ feeCoin: "USDT", totalFee: "0.01" }], cTime: "1700000002000" }] });
  assert.equal(mg[0].market, "margin-crossed");
  assert.deepEqual(normalizeFills("spot", [{ tradeId: "", cTime: "1" }, { tradeId: "2", priceAvg: "0", size: "1", cTime: "1" }]), []);
});

test("margin needs a symbol; futures use productType; positions only for futures", async () => {
  await assert.rejects(getFills(ENV, "margin-isolated", {}), (e: any) => e.code === "symbol_required");
  let u = "";
  await getFills(ENV, "coin-futures", {}, { fetchImpl: (async (x: string) => { u = x; return ok({ fillList: [] }); }) as any });
  assert.match(u, /mix\/order\/fills\?.*productType=coin-futures/);
});

test("sync is idempotent, paginates, covers every market and reports per-market failures", async () => {
  const kv = kvStore();
  const env = { ...ENV, ETI_EXECUTION_LOG: kv, ETI_BITGET_MARGIN_SYMBOLS: "BTCUSDT" };
  let calls = 0;
  const fetchImpl = (async (u: string) => {
    calls++;
    if (u.includes("/margin/isolated/")) return new Response(JSON.stringify({ code: "40014", msg: "no permission" }));
    const t = Date.now() - 1000;
    if (u.includes("/spot/trade/fills")) return ok([{ tradeId: "s1", symbol: "BTCUSDT", orderId: "o", side: "buy", priceAvg: "1", size: "1", amount: "1", feeDetail: { feeCoin: "USDT", totalFee: "0" }, cTime: String(t) }]);
    if (u.includes("/mix/order/fills")) return ok({ fillList: [{ tradeId: "m-" + u.match(/productType=([a-z-]+)/)![1], symbol: "BTCUSDT", orderId: "o", side: "buy", price: "1", baseVolume: "1", quoteVolume: "1", cTime: String(t) }] });
    if (u.includes("/margin/crossed/fills")) return ok({ fills: [{ tradeId: "c1", symbol: "BTCUSDT", orderId: "o", side: "sell", priceAvg: "1", size: "1", amount: "1", cTime: String(t) }] });
    return ok([]);
  }) as any;
  const r1: any = await syncAll(env, { fetchImpl });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.results.map((x: any) => [x.market, x.added ?? x.error]), [["spot", 1], ["margin-crossed", 1], ["margin-isolated", "bitget_40014"], ["usdt-futures", 1], ["usdc-futures", 1], ["coin-futures", 1]]);
  const r2: any = await syncAll(env, { fetchImpl });
  assert.equal(r2.results.find((x: any) => x.market === "spot").added, 0);     // same fill is not stored twice
  const res = await handleBitget(new Request("https://eti.test/api/bitget/trades?market=usdt-futures", { headers: { authorization: "Bearer tok" } }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).fills.length, 1);
  assert.ok(calls > 6);
});

test("sync without margin symbols skips margin with an explanation; without credentials it refuses", async () => {
  const kv = kvStore();
  const r: any = await syncAll({ ...ENV, ETI_EXECUTION_LOG: kv }, { fetchImpl: (async () => ok([])) as any }, ["margin-crossed"]);
  assert.match(r.results[0].skipped, /ETI_BITGET_MARGIN_SYMBOLS/);
  assert.equal(((await syncAll({ ETI_EXECUTION_LOG: kv })) as any).error, "credentials_missing");
});

test("HTTP: private routes need the bearer token, status never reveals values, margin pairs are public", async () => {
  const noAuth = await handleBitget(new Request("https://eti.test/api/bitget/status"), ENV);
  assert.equal(noAuth.status, 401);
  const st = await handleBitget(new Request("https://eti.test/api/bitget/status", { headers: { authorization: "Bearer tok" } }), ENV);
  const body = JSON.stringify(await st.json());
  assert.equal(st.status, 200); assert.doesNotMatch(body, /s3cret|"pp"/); assert.match(body, /BITGET_API_KEY/); assert.match(body, /"readOnly":false/);
  const pairs = await handleBitget(new Request("https://eti.test/api/bitget/margin-pairs"), { BITGET_API_KEY:"key", BITGET_API_SECRET:"secret", BITGET_API_PASSPHRASE:"pass" }, { fetchImpl: (async(_url:any,init:any) => { assert.ok(init.headers["ACCESS-KEY"]); assert.ok(init.headers["ACCESS-SIGN"]); return ok([{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "1", maxCrossedLeverage: "3", maxIsolatedLeverage: "10" }, { symbol: "x" }]); }) as any });
  assert.equal(pairs.status, 200);
  const pj: any = await pairs.json();
  assert.equal(pj.count, 1); assert.equal(pj.pairs[0].crossed, true);
  const bad = await handleBitget(new Request("https://eti.test/api/bitget/fills?market=nope", { headers: { authorization: "Bearer tok" } }), ENV);
  assert.equal(bad.status, 400);
  assert.equal(BITGET_MARKETS.length, 6);
});
