import test from "node:test";
import assert from "node:assert/strict";
import { loadExchangePortfolioSnapshot } from "./exchanges.ts";

const env = {
  BYBIT_API_KEY: "test-bybit-key", BYBIT_API_SECRET: "test-bybit-secret",
  BITGET_API_KEY: "test-bitget-key", BITGET_API_SECRET: "test-bitget-secret",
  BITGET_API_PASSPHRASE: "test-passphrase",
};
function mockFetch(input: RequestInfo | URL) {
  const url = new URL(String(input));
  if (url.hostname.includes("bybit")) {
    if (url.pathname.endsWith("/wallet-balance")) return Promise.resolve(new Response(JSON.stringify({ retCode: 0, result: { list: [{ totalEquity: "1250.50", totalAvailableBalance: "900.25", coin: [{ coin: "USDT", walletBalance: "1200", availableToWithdraw: "900", usdValue: "1200" }] }] } })));
    return Promise.resolve(new Response(JSON.stringify({ retCode: 0, result: { list: [] } })));
  }
  let data: any[] = [];
  if (url.pathname.endsWith("/spot/account/assets")) data = [{ coin: "USDT", available: "120", frozen: "5", usdtValue: "125" }];
  if (url.pathname.endsWith("/mix/account/accounts")) data = [{ marginCoin: "USDT", accountEquity: "300", available: "250" }];
  return Promise.resolve(new Response(JSON.stringify({ code: "00000", data })));
}

test("exchange snapshot reports Bybit and separate Bitget product accounts without summing collateral", async () => {
  const snapshot = await loadExchangePortfolioSnapshot(env, 1_800_000_000_000, { fetchImpl: mockFetch as typeof fetch });
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.executionEnabled, false);
  assert.equal(snapshot.aggregation.combinedEquityUsd, null);
  const bybit = snapshot.venues.find(v => v.venue === "bybit") as any;
  const bitget = snapshot.venues.find(v => v.venue === "bitget") as any;
  assert.equal(bybit.status, "connected");
  assert.equal(bybit.equityUsd, 1250.5);
  assert.equal(bybit.assets[0].coin, "USDT");
  assert.equal(bitget.markets.length, 6);
  assert.equal(bitget.markets.find((m: any) => m.market === "spot").assets[0].coin, "USDT");
  assert.equal(bitget.markets.find((m: any) => m.market === "usdt-futures").assets[0].equity, 300);
  assert.ok(snapshot.limitations.some(x => x.includes("shared collateral")));
});

test("missing credentials are reported as unavailable rather than zero balances", async () => {
  const snapshot = await loadExchangePortfolioSnapshot({}, 1_800_000_000_000);
  const bybit = snapshot.venues.find(v => v.venue === "bybit") as any;
  const bitget = snapshot.venues.find(v => v.venue === "bitget") as any;
  assert.equal(bybit.status, "credentials_missing");
  assert.equal(bybit.equityUsd, null);
  assert.equal(bitget.status, "credentials_missing");
  assert.equal(snapshot.aggregation.combinedAvailableUsd, null);
});
