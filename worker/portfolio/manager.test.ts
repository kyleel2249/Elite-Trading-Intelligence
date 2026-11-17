import test from "node:test";
import assert from "node:assert/strict";
import { emptyLedger } from "./ledger.ts";
import { buildPortfolioManager } from "./manager.ts";

function trade(i: number, strategy: string, net: number) {
  return { id: "t"+i, symbol: "BTCUSDT", direction: "long" as const, qty: 1,
    entryPrice: 100, exitPrice: 100 + net, entryAt: i * 1000, exitAt: i * 1000 + 500,
    holdingMs: 500, gross: net, fees: 0, net, unknownFees: 0, slippageCost: 0,
    strategy, signalId: "s"+i, fills: [], result: net > 0 ? "win" as const : net < 0 ? "loss" as const : "breakeven" as const };
}

test("manager leaves strategies without verified sample history unallocated", () => {
  const ledger = emptyLedger("internal_paper");
  ledger.startingBalance = 10_000; ledger.cash = 10_000;
  ledger.closed = Array.from({ length: 8 }, (_, i) => trade(i, "scalp", 12));
  const result = buildPortfolioManager(ledger, 2_000_000);
  assert.equal(result.mode, "advisory_read_only");
  assert.equal(result.executionEnabled, false);
  assert.equal(result.strategies.find(x => x.strategy === "scalp")?.eligible, false);
  assert.equal(result.strategies.reduce((s, x) => s + x.targetWeightPct, 0), 0);
  assert.equal(result.controls.liveOrdersAllowed, false);
});

test("manager rewards profitable verified strategy history while enforcing allocation caps", () => {
  const ledger = emptyLedger("internal_paper");
  ledger.startingBalance = 20_000; ledger.cash = 19_000;
  ledger.closed = [
    ...Array.from({ length: 40 }, (_, i) => trade(i, "scalp", 20)),
    ...Array.from({ length: 40 }, (_, i) => trade(i + 40, "intraday", i % 3 === 0 ? -5 : 12)),
    ...Array.from({ length: 12 }, (_, i) => trade(i + 80, "swing", 50)),
  ];
  const result = buildPortfolioManager(ledger, 2_000_000);
  const scalp = result.strategies.find(x => x.strategy === "scalp")!;
  const intraday = result.strategies.find(x => x.strategy === "intraday")!;
  const swing = result.strategies.find(x => x.strategy === "swing")!;
  assert.equal(scalp.eligible, true);
  assert.equal(intraday.eligible, true);
  assert.equal(swing.eligible, false, "small sample cannot dominate allocation");
  assert.ok(scalp.targetWeightPct > 0);
  assert.ok(intraday.targetWeightPct > 0);
  assert.ok(scalp.targetWeightPct <= 35);
  assert.ok(intraday.targetWeightPct <= 35);
  assert.ok(result.account.allocatedPct <= 50);
  assert.equal(result.account.currency, "USDT");
});

test("manager blocks readiness when position marks or protective stops are missing", () => {
  const ledger = emptyLedger("internal_paper");
  ledger.startingBalance = 10_000; ledger.cash = 9_000;
  ledger.positions.BTCUSDT = {
    id: "p1", symbol: "BTCUSDT", venue: "bybit", direction: "long", qty: 0.01,
    avgEntry: 50_000, totalBoughtQty: 0.01, totalBoughtCost: 500, totalSoldQty: 0,
    totalSoldProceeds: 0, realizedGross: 0, fees: 0, unknownFees: 0, slippageCost: 0,
    openedAt: 1, updatedAt: 1, strategy: "intraday", signalId: "sig", levels: { stop: null, tp: [null, null, null], hit: [false, false, false] },
    levelsAt: 1, entryQty: 0.01, fillIds: [],
  };
  const result = buildPortfolioManager(ledger, 2_000_000);
  assert.equal(result.controls.executionReady, false);
  assert.deepEqual(result.controls.staleMarkSymbols, ["BTCUSDT"]);
  assert.deepEqual(result.controls.missingStopSymbols, ["BTCUSDT"]);
  assert.equal(result.venues[0].venue, "bybit");
  assert.equal(result.venues[0].scope, "selected_ledger_only");
});

test("manager never converts unrecorded external exchange holdings into available capital", () => {
  const ledger = emptyLedger("exchange_testnet");
  ledger.startingBalance = null; ledger.cash = null;
  const result = buildPortfolioManager(ledger, 2_000_000);
  assert.equal(result.account.equityUsd, null);
  assert.equal(result.account.allocatedPct, 0);
  assert.ok(result.controls.warnings.includes("portfolio_equity_unavailable"));
  assert.equal(result.executionEnabled, false);
});
