import test from "node:test";
import assert from "node:assert/strict";
import { handleOmnisignal } from "./algo/omni-api.ts";
import { parseSymbols, rankRows, opportunityScore, MAX_SCAN_SYMBOLS, type ScanRow } from "./algo/scan.ts";
import { series } from "./algo/fixtures.ts";

const row = (o: Partial<ScanRow>): ScanRow => ({ rank: null, symbol: "AAAAA", decision: "HOLD", direction: null, opportunityScore: null, validationScore: null, confidence: 0, riskRewardToTP3: null, agreement: null, liquidity: null, entryZone: null, stopLoss: null, reason: "", ...o });

test("parseSymbols dedupes, validates and caps", () => {
  const r = parseSymbols("btcusdt, BTCUSDT,eth usdt,ethusdt,solusdt,bnbusdt,xrpusdt");
  assert.deepEqual(r.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]);
  assert.equal(r.symbols.length, MAX_SCAN_SYMBOLS);
  assert.ok(r.ignored.includes("ETH USDT") && r.ignored.includes("XRPUSDT"));
  assert.deepEqual(parseSymbols(null).symbols, []);
});
test("ranking: actionable first by opportunity score; HOLD/REJECTED/unreliable never ranked", () => {
  const out = rankRows([row({ symbol: "HOLDA", decision: "HOLD" }), row({ symbol: "LOWAA", decision: "BUY", opportunityScore: 50 }), row({ symbol: "BADAA", decision: "DATA_UNRELIABLE" }), row({ symbol: "TOPAA", decision: "SELL", opportunityScore: 80 }), row({ symbol: "REJAA", decision: "REJECTED" })]);
  assert.deepEqual(out.map(r => r.symbol), ["TOPAA", "LOWAA", "HOLDA", "REJAA", "BADAA"]);
  assert.deepEqual(out.map(r => r.rank), [1, 2, null, null, null]);
});
test("opportunity score is null without validation and caps reward/risk", () => {
  assert.equal(opportunityScore({ validation: null, riskRewardToTP3: 5, liquidity: null }), null);
  const v = { score: 80 } as any, ok = { status: "ok" } as any;
  assert.equal(opportunityScore({ validation: v, riskRewardToTP3: 3, liquidity: ok }), 88);
  assert.equal(opportunityScore({ validation: v, riskRewardToTP3: 30, liquidity: ok }), 88);
});

const MS: Record<string, number> = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5 };
const PX = series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: 900000, end: 0 }).at(-1)![4];
const realFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = (async (input: any) => {
  const u = new URL(String(input)), sym = u.searchParams.get("symbol");
  if (sym === "DOWNUSDT") return new Response("down", { status: 500 });
  if (u.pathname.includes("klines")) { const st = MS[u.searchParams.get("interval") || "1h"]; return new Response(JSON.stringify(series(300, { drift: 0.25, noise: 0.35, seed: 7, stepMs: st, end: Date.now() - st * 0.5 }).map(k => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), String(k[5]), 0, "0", 1, "0", "0", "0"]))); }
  if (u.pathname.includes("depth")) return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 50 }, (_, i) => [String(PX - 0.01 - i * 0.01), "50"]), asks: Array.from({ length: 50 }, (_, i) => [String(PX + 0.01 + i * 0.01), "50"]) }));
  return new Response("x", { status: 500 });
}) as typeof fetch; });
test.afterEach(() => { globalThis.fetch = realFetch; });

const get = (q: string, m = "GET") => handleOmnisignal(new Request("https://x.test/api/omnisignal/scan" + q, { method: m }), {} as any);
test("scan endpoint ranks live-shaped data, isolates a failing symbol, never orders", async () => {
  const r = await get("?symbols=BTCUSDT,DOWNUSDT&strategy=intraday"), j: any = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.submitsOrder, false); assert.equal(j.liveExecutionAllowed, false);
  const by = Object.fromEntries(j.leaderboard.map((x: any) => [x.symbol, x]));
  assert.equal(by.DOWNUSDT.decision, "DATA_UNRELIABLE"); assert.equal(by.DOWNUSDT.rank, null);
  assert.ok(["BUY", "SELL", "HOLD", "REJECTED"].includes(by.BTCUSDT.decision));
  if (by.BTCUSDT.decision === "BUY") assert.equal(by.BTCUSDT.rank, 1);
});
test("scan endpoint validates input and is GET only", async () => {
  assert.equal((await get("")).status, 400);
  assert.equal((await get("?symbols=BTCUSDT&strategy=bogus")).status, 400);
  assert.equal((await get("?symbols=BTCUSDT", "POST")).status, 405);
});
