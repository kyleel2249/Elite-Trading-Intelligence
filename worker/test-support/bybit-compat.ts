/**
 * Test support: lets a mock written in Binance spot terms serve the Worker's Bybit V5 market-data routes.
 *
 * Bybit is the only enabled crypto venue (see worker/market.ts), so every upstream request the Worker makes goes to
 * api.bybit.com / api.bytick.com. Most suites already describe their deterministic exchange as a Binance-shaped mock
 * (klines rows, {bids, asks} depth). `bybitCompat` wraps such a mock so that:
 *
 *   1. a Bybit V5 request is translated to the equivalent Binance spot request (host data-api.binance.vision),
 *   2. the mock answers exactly as it always did, and
 *   3. a successful answer is re-shaped into the Bybit V5 envelope ({ retCode: 0, result: ... }).
 *
 * Failures (non-2xx, network errors thrown by the mock, shapes it cannot convert) pass through unchanged, so the
 * Worker's fail-closed behaviour is still what the tests observe. Requests to any other host are forwarded untouched.
 */

const BYBIT_HOSTS = new Set(["api.bybit.com", "api.bytick.com"]);
const LEGACY_ORIGIN = "https://data-api.binance.vision";

/** Bybit interval token -> the interval label the Binance-shaped mocks key their step tables on. */
const INTERVAL_FROM_BYBIT: Record<string, string> = {
  "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m", "60": "1h", "120": "2h", "240": "4h",
  "360": "6h", "720": "12h", D: "1d", W: "1w", M: "1M",
};

type FetchLike = (input: any, init?: any) => Promise<Response>;

function urlOf(input: unknown): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL((input as { url: string }).url);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const rejected = (retCode: number, retMsg: string) => json({ retCode, retMsg, result: {} });

/** Translate a Bybit V5 market-data URL into the Binance spot URL the legacy mocks understand. */
function toLegacy(url: URL): { legacy: URL; kind: "klines" | "depth" | "trades" | "ticker" } | null {
  const sym = url.searchParams.get("symbol") ?? "";
  const limit = url.searchParams.get("limit");
  const make = (path: string, extra: Record<string, string> = {}) => {
    const u = new URL(LEGACY_ORIGIN + path);
    if (sym) u.searchParams.set("symbol", sym);
    if (limit) u.searchParams.set("limit", limit);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u;
  };
  switch (url.pathname) {
    case "/v5/market/kline": {
      const iv = url.searchParams.get("interval") ?? "";
      return { legacy: make("/api/v3/klines", { interval: INTERVAL_FROM_BYBIT[iv] ?? iv }), kind: "klines" };
    }
    case "/v5/market/orderbook": return { legacy: make("/api/v3/depth"), kind: "depth" };
    case "/v5/market/recent-trade": return { legacy: make("/api/v3/trades"), kind: "trades" };
    case "/v5/market/tickers": return { legacy: make("/api/v3/ticker/24hr"), kind: "ticker" };
    default: return null;
  }
}

/** Re-shape a Binance-style payload into the Bybit V5 envelope, or null when it cannot be converted. */
function toBybit(kind: "klines" | "depth" | "trades" | "ticker", j: any, symbol: string): Response | null {
  if (kind === "klines") {
    if (!Array.isArray(j)) return null;
    // Bybit returns the newest candle first and carries turnover as the seventh field.
    const list = [...j].reverse().map((r: any[]) => [String(r[0]), String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5]), "0"]);
    return json({ retCode: 0, retMsg: "OK", result: { category: "spot", symbol, list } });
  }
  if (kind === "depth") {
    if (!j || !Array.isArray(j.bids) || !Array.isArray(j.asks)) return null;
    return json({ retCode: 0, retMsg: "OK", result: { s: symbol, b: j.bids, a: j.asks, ts: Date.now(), u: 1 } });
  }
  if (kind === "trades") {
    if (!Array.isArray(j)) return null;
    const list = j.map((t: any) => ({ time: String(t.time), price: String(t.price), size: String(t.qty), side: t.isBuyerMaker ? "Sell" : "Buy" }));
    return json({ retCode: 0, retMsg: "OK", result: { category: "spot", list } });
  }
  if (Array.isArray(j)) j = j[0];
  if (!j || typeof j !== "object") return null;
  const last = Number(j.lastPrice);
  const list = [{
    symbol, lastPrice: String(j.lastPrice), price24hPcnt: String(Number(j.priceChangePercent ?? 0) / 100),
    highPrice24h: String(j.highPrice ?? last), lowPrice24h: String(j.lowPrice ?? last),
    volume24h: String(j.volume ?? 0), turnover24h: String(j.quoteVolume ?? 0),
    ...(Number.isFinite(Number(j.markPrice)) ? { markPrice: String(j.markPrice) } : {}),
    ...(Number.isFinite(Number(j.indexPrice)) ? { indexPrice: String(j.indexPrice) } : {}),
    ...(Number.isFinite(Number(j.fundingRate)) ? { fundingRate: String(j.fundingRate) } : {}),
    ...(Number.isFinite(Number(j.openInterest)) ? { openInterest: String(j.openInterest) } : {}),
    ...(Number.isFinite(Number(j.bidPrice)) ? { bid1Price: String(j.bidPrice) } : {}),
    ...(Number.isFinite(Number(j.askPrice)) ? { ask1Price: String(j.askPrice) } : {}),
    ...(Number.isFinite(Number(j.closeTime)) ? { ts: String(j.closeTime) } : {}),
  }];
  return json({ retCode: 0, retMsg: "OK", result: { category: "spot", list } });
}

/** Wrap a Binance-shaped mock so the Worker's Bybit requests are answered by it. */
export function bybitCompat(handler: FetchLike): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = urlOf(input);
    if (!BYBIT_HOSTS.has(url.host)) return handler(input, init);
    const mapped = toLegacy(url);
    if (!mapped) return rejected(10001, "unsupported_test_route");
    const res = await handler(mapped.legacy.toString(), init);
    if (!res.ok) return res;
    let body: unknown;
    try { body = await res.clone().json(); } catch { return res; }
    return toBybit(mapped.kind, body, url.searchParams.get("symbol") ?? "") ?? rejected(10001, "unconvertible_test_payload");
  }) as typeof fetch;
}
