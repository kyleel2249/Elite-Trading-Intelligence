import test from "node:test";
import assert from "node:assert/strict";
import { AlphaStore, memoryKv } from "./store.ts";
import { Budget } from "./budget.ts";
import { scanCrypto, fetchUniverse, filterUniverse, parseBinanceTickers, type ScanCtx, type MarketPort } from "./scanner.ts";
import { discoverDex, refreshInvestors, scanEquities } from "./research.ts";
import { makeCandles, range, trend } from "./testdata.ts";

const NOW = 1_700_000_000_000 + 700 * 3600_000;
const rows = makeCandles([range(300, 0.004, 1000), trend(60, 0.0015, 0.004, 1500)], { start: NOW - 360 * 3600_000 });
const market: MarketPort = { async klines() { return { rows, provider: "binance" }; }, async trades() { return []; }, async depth() { return { bids: [], asks: [] } as any; } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const tickers = Array.from({ length: 30 }, (_, i) => ({ symbol: "T" + i + "USDT", lastPrice: "10", quoteVolume: String(5_000_000 + i), priceChangePercent: "1" }))
  .concat([{ symbol: "USDCUSDT", lastPrice: "1", quoteVolume: "9e9", priceChangePercent: "0" }, { symbol: "BTCUPUSDT", lastPrice: "1", quoteVolume: "9e9", priceChangePercent: "9" }]);
const mkCtx = (f: any, budget = 60, env: any = {}): ScanCtx => ({ env, store: new AlphaStore({ ETI_ALPHA_KV: memoryKv() }), budget: new Budget(budget), now: NOW, fetch: f, market });

test("universe filter drops stablecoins, leveraged tokens and thin markets", () => {
  const f = filterUniverse(parseBinanceTickers(tickers), 1_000_000);
  assert.ok(!f.kept.some(r => /USDC|BTCUP/.test(r.symbol))); assert.ok(f.kept.length >= 30);
});

test("crypto scan examines the universe, persists results and respects the budget", async () => {
  const ctx = mkCtx(async (u: string) => u.includes("ticker/24hr") ? json(tickers) : json({}, 404), 40);
  const rep = await scanCrypto(ctx, { topN: 6, deepN: 2 });
  assert.equal(rep.universe.venue, "binance"); assert.ok(rep.examined.length >= 1 && rep.examined.length <= 6);
  const lb = await ctx.store.get<any>("leaderboard", { entries: [] }); assert.ok(lb.entries.length >= 1);
  assert.ok(ctx.budget.used <= 40);
  const tiny = mkCtx(async (u: string) => u.includes("ticker/24hr") ? json(tickers) : json({}, 404), 2);
  tiny.market = { ...market, async klines() { return tiny.budget.take() ? { rows, provider: "binance" } : null; } };
  const r2 = await scanCrypto(tiny, { topN: 6 }); assert.equal(r2.partial, true, "reports partial coverage when budget is exhausted");
});

test("universe fetch falls through providers and reports errors", async () => {
  const u = await fetchUniverse(new Budget(10), async () => new Response("no", { status: 451 })); assert.equal(u.venue, null); assert.ok(u.errors.length >= 3);
});

test("DEX discovery stays monitoring-only and rejects risky or illiquid tokens", async () => {
  const pair = (addr: string, liq: number, age: number) => ({ chainId: "ethereum", dexId: "uni", pairAddress: "0xp" + addr, baseToken: { address: "0x" + addr.repeat(40).slice(0, 40), symbol: "TK" + addr, name: "Token" + addr }, quoteToken: { symbol: "WETH" }, priceUsd: "1", liquidity: { usd: liq }, volume: { h24: liq * 2 }, txns: { h24: { buys: 200, sells: 150 } }, pairCreatedAt: NOW - age * 3600_000, url: "https://dexscreener.com/x" });
  const f = async (u: string) => {
    if (u.includes("token-profiles")) return json([{ chainId: "ethereum", tokenAddress: "0x" + "a".repeat(40) }, { chainId: "ethereum", tokenAddress: "0x" + "b".repeat(40) }]);
    if (u.includes("/latest/dex/tokens/")) return json({ pairs: [pair("a", 400_000, 30), pair("b", 800, 1)] });
    return json({}, 404);
  };
  const ctx = mkCtx(f), r = await discoverDex(ctx);
  assert.equal(r.examined, 2); const list = await ctx.store.get<any[]>("dex", []);
  assert.ok(list.every(t => ["WATCHLIST", "REJECTED"].includes(t.status)), "never executable");
  assert.equal(list.find(t => t.symbol === "TKb")?.status, "REJECTED");
});

test("investor refresh and equity scan fail closed without credentials", async () => {
  let called = 0; const ctx = mkCtx(async () => { called++; return json({}); });
  const inv = await refreshInvestors(ctx, {}); assert.equal(inv.skipped, "sec_user_agent_not_configured"); assert.equal(called, 0);
  const eq = await scanEquities(ctx, {}); assert.ok(eq.errors.length >= 1 || eq.examined.length === 0); assert.equal(called, 0);
});
