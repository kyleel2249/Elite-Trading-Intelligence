import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BITGET_CLIENT_JS } from "./bitget-client.ts";

test("Bitget browser adapter parses and exposes public REST helpers", () => {
  assert.doesNotThrow(() => new vm.Script(BITGET_CLIENT_JS));
  for (const name of ["request", "candles", "context", "marketData", "symbols", "loadSignalInputs", "subscribe"]) {
    assert.ok(BITGET_CLIENT_JS.includes(name), name);
  }
  assert.ok(BITGET_CLIENT_JS.includes("https://api.bitget.com"));
  assert.ok(BITGET_CLIENT_JS.includes("https://capi.bitget.com"));
});

test("Bitget browser adapter falls back from a blocked V3 request to the V2 public endpoint", async () => {
  const calls: string[] = [];
  const now = Date.now();
  const sandbox: any = {
    window: {},
    AbortSignal,
    Response,
    fetch: async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v3/")) return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
      return new Response(JSON.stringify({ code: "00000", data: [
        [String(now), "3", "3.5", "2.5", "3.2", "4"],
        [String(now - 120000), "1", "1.5", "0.5", "1.2", "2"],
        [String(now - 60000), "2", "2.5", "1.5", "2.2", "3"]
      ] }), { status: 200 });
    }
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const rows = await sandbox.window.ETIBitget.candles({ symbol: "BTCUSDT", interval: "1m", limit: 210, market: "spot" });
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], now - 120000);
  assert.equal(rows[2][0], now);
  assert.ok(calls.some(url => url.includes("/api/v3/market/candles")));
  assert.ok(calls.some(url => url.includes("/api/v2/spot/market/candles")));
});

test("Bitget browser adapter normalizes spot, futures and margin symbol catalogues", async () => {
  const sandbox: any = {
    window: {}, AbortSignal, Response,
    fetch: async (url: string) => {
      const u = new URL(url);
      const category = u.searchParams.get("category");
      let data: any[] = [];
      if (category === "SPOT") data = [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" }];
      if (category === "USDT-FUTURES") data = [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "normal", type: "perpetual" }];
      if (category === "MARGIN") data = [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online", isCrossBorrowable: true, maxCrossedLeverage: "3" }];
      return new Response(JSON.stringify({ code: "00000", data }), { status: 200 });
    }
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const all = await sandbox.window.ETIBitget.symbols("all");
  const margin = await sandbox.window.ETIBitget.symbols("margin");
  assert.ok(all.data.symbols.some((r: any[]) => r[0] === "BTCUSDT" && r[3] === "spot" && r[5] === "bitget"));
  assert.ok(all.data.symbols.some((r: any[]) => r[0] === "BTCUSDT" && r[3] === "futures" && r[6] === "USDT-FUTURES"));
  assert.ok(margin.data.symbols.some((r: any[]) => r[0] === "BTCUSDT" && r[3] === "margin" && r[8] === true));
});

test("Bitget browser adapter normalizes candles, order book, trades and derivatives", async () => {
  const now = Date.now();
  const sandbox: any = {
    window: {}, AbortSignal, Response,
    fetch: async (url: string) => {
      const u = new URL(url), path = u.pathname;
      let data: any = [];
      if (path.endsWith("/candles")) data = [[String(now), "100", "101", "99", "100.5", "20"], [String(now - 60000), "99", "100", "98", "99.5", "18"]];
      if (path.endsWith("/orderbook")) data = { bids: [["100", "10"]], asks: [["101", "12"]] };
      if (path.endsWith("/fills")) data = [{ ts: String(now), price: "100.5", size: "2", side: "buy" }];
      if (path.endsWith("/tickers")) data = [{ symbol: "BTCUSDT", lastPr: "100.5", open: "98", high24h: "102", low24h: "96", baseVolume: "500", quoteVolume: "50000", priceChangePercent: "0.02", fundingRate: "0.0008", openInterest: "12500", ts: String(now) }];
      return new Response(JSON.stringify({ code: "00000", data }), { status: 200 });
    }
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const snapshot = await sandbox.window.ETIBitget.marketData({ symbol: "BTCUSDT", interval: "1m", limit: 210, market: "futures", category: "USDT-FUTURES" });
  assert.equal(snapshot.candles.length, 2);
  assert.equal(snapshot.candles[0][0], now - 60000);
  assert.equal(snapshot.depth.bids[0][0], 100);
  assert.equal(snapshot.trades[0].p, "100.5");
  assert.equal(snapshot.ticker.lastPrice, 100.5);
  assert.equal(snapshot.derivatives.fundingRate, 0.0008);
  assert.equal(snapshot.derivatives.openInterest, 12500);
});

test("Bitget browser catalogue keeps a category's last known pairs when its refresh fails (no silent disappearance)", async () => {
  const down = new Set<string>();
  const sandbox: any = {
    window: {}, AbortSignal, Response,
    fetch: async (url: string) => {
      const u = new URL(url), cat = u.searchParams.get("category") || (u.searchParams.get("productType") || "SPOT");
      if (down.has(cat)) return new Response("boom", { status: 500 });
      const body = cat === "SPOT"
        ? [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" }]
        : [{ symbol: cat === "COIN-FUTURES" ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC", quoteCoin: cat === "COIN-FUTURES" ? "USD" : "USDT", status: "online", type: "perpetual" }];
      return new Response(JSON.stringify({ code: "00000", data: body }), { status: 200 });
    },
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const first = await sandbox.window.ETIBitget.symbols("all");
  assert.equal(first.data.symbols.length, 4);
  down.add("COIN-FUTURES");
  const second = await sandbox.window.ETIBitget.symbols("all");
  assert.equal(second.data.symbols.length, 4, "the coin-margined pair must still be listed");
  assert.ok(second.data.symbols.some((r: any[]) => r[6] === "COIN-FUTURES"));
  assert.ok(second.data.warnings.some((w: string) => /COIN-FUTURES refresh failed/.test(w)));
});


test("Bitget WebSocket subscribes to the selected futures product and normalizes live market updates", () => {
  const sockets: any[] = [], messages: any[] = [], states: any[] = [], timers: any[] = [];
  class FakeWebSocket {
    readyState = 0; onopen: any; onmessage: any; onclose: any; onerror: any; sent: string[] = [];
    url: string; constructor(url: string) { this.url = url; sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
  }
  const sandbox: any = {
    window: {}, AbortSignal, Response, WebSocket: FakeWebSocket, Date, Math, JSON, Number, String, Array, Object, Promise, Map,
    setInterval: (fn: any, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
    setTimeout: (fn: any, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    fetch: async () => new Response(JSON.stringify({ code: "00000", data: [] })),
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const stream = sandbox.window.ETIBitget.subscribe({
    symbol: "BTCUSDT", market: "futures", category: "USDT-FUTURES", interval: "1m"
  }, { onMessage: (m: any) => messages.push(m), onStatus: (s: any) => states.push(s) });
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://ws.bitget.com/v2/ws/public");
  sockets[0].readyState = 1;
  sockets[0].onopen();
  const sub = JSON.parse(sockets[0].sent[0]);
  assert.equal(sub.op, "subscribe");
  assert.ok(sub.args.some((a: any) => a.instType === "usdt-futures" && a.topic === "ticker" && a.symbol === "BTCUSDT"));
  assert.ok(sub.args.some((a: any) => a.instType === "usdt-futures" && a.topic === "books5"));
  assert.ok(sub.args.some((a: any) => a.instType === "usdt-futures" && a.topic === "publicTrade"));
  assert.ok(sub.args.some((a: any) => a.instType === "usdt-futures" && a.topic === "kline" && a.interval === "1m"));
  sockets[0].onmessage({ data: JSON.stringify({ arg: { topic: "ticker", symbol: "BTCUSDT" }, ts: String(Date.now()), data: [{ lastPrice: "60000", highPrice24h: "61000", lowPrice24h: "59000", volume24h: "12", price24hPcnt: "0.01", markPrice: "60010", indexPrice: "59990", fundingRate: "0.0001", openInterest: "2000", bid1Price: "59999", ask1Price: "60001" }] }) });
  assert.equal(messages[0].type, "ticker");
  assert.equal(messages[0].data.lastPrice, 60000);
  assert.equal(messages[0].data.markPrice, 60010);
  assert.equal(messages[0].data.indexPrice, 59990);
  assert.equal(messages[0].data.fundingRate, 0.0001);
  assert.equal(messages[0].data.openInterest, 2000);
  assert.ok(states.some((s: any) => s.state === "connected"));
  stream.close();
  assert.ok(states.some((s: any) => s.state === "closed"));
});

test("Bitget catalogue reports independent freshness for each futures product type", async () => {
  const failed = new Set<string>();
  const sandbox: any = {
    window: {}, AbortSignal, Response,
    fetch: async (url: string) => {
      const u = new URL(url), cat = u.searchParams.get("category") || u.searchParams.get("productType") || "SPOT";
      if (failed.has(cat)) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: cat === "COIN-FUTURES" ? "BTCUSD" : cat === "USDC-FUTURES" ? "BTCUSDC" : "BTCUSDT",
        baseCoin: "BTC", quoteCoin: cat === "COIN-FUTURES" ? "USD" : cat === "USDC-FUTURES" ? "USDC" : "USDT",
        status: "normal", type: "perpetual"
      }] }));
    }
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  await sandbox.window.ETIBitget.symbols("all");
  failed.add("COIN-FUTURES");
  const result = await sandbox.window.ETIBitget.symbols("all");
  assert.equal(result.data.sources["USDT-FUTURES"].stale, false);
  assert.equal(result.data.sources["USDC-FUTURES"].stale, false);
  assert.equal(result.data.sources["COIN-FUTURES"].stale, true);
  assert.ok(result.data.symbols.some((r: any[]) => r[6] === "COIN-FUTURES"));
});


test("Bitget catalogue never replaces a populated product list with an empty active response", async () => {
  const empty = new Set<string>();
  const sandbox: any = {
    window: {}, AbortSignal, Response,
    fetch: async (url: string) => {
      const u = new URL(url), cat = u.searchParams.get("category") || u.searchParams.get("productType") || "SPOT";
      if (empty.has(cat)) return new Response(JSON.stringify({ code: "00000", data: [] }));
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: cat === "COIN-FUTURES" ? "BTCUSD" : cat === "USDC-FUTURES" ? "BTCUSDC" : "BTCUSDT",
        baseCoin: "BTC", quoteCoin: cat === "COIN-FUTURES" ? "USD" : cat === "USDC-FUTURES" ? "USDC" : "USDT",
        status: "normal", type: "perpetual"
      }] }));
    }
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const first = await sandbox.window.ETIBitget.symbols("all");
  assert.ok(first.data.symbols.some((r: any[]) => r[6] === "USDT-FUTURES"));
  empty.add("USDT-FUTURES");
  const second = await sandbox.window.ETIBitget.symbols("all");
  assert.equal(second.data.sources["USDT-FUTURES"].stale, true);
  assert.ok(second.data.symbols.some((r: any[]) => r[6] === "USDT-FUTURES"));
});


test("Bitget futures WebSocket uses the documented lowercase product type and V3 candle interval",()=>{
 assert.ok(BITGET_CLIENT_JS.includes('function streamProduct(market,category){if(market!=="futures")return "spot";'));
 assert.ok(BITGET_CLIENT_JS.includes('return String(category||"USDT-FUTURES").toLowerCase()'));
 assert.ok(BITGET_CLIENT_JS.includes('interval:v3iv'));
});
