import test from "node:test";
import assert from "node:assert/strict";
import { Budget } from "./budget.ts";
import * as F from "./flow.ts";

const trades = (spec: [number, number, boolean][]) => spec.map(([price, qty, bm], i) => ({ time: 1_700_000_000_000 + i * 1000, price, qty, isBuyerMaker: bm }));
const baseline = Array.from({ length: 60 }, (_, i): [number, number, boolean] => [100 + (i % 7) * 0.01, 1 + (i % 5) * 0.37, i % 2 === 0]);

test("large aggressive buying with a bid-heavy book reads as accumulation pressure", () => {
  const t = trades([...baseline, [100, 400, false], [100, 350, false], [100, 300, false]]);
  const a = F.analyseFlow(t, { bids: [[99.9, 800], [99.5, 900]], asks: [[100.1, 100], [100.5, 100]] });
  assert.equal(a.verdict, "accumulation_pressure"); assert.ok(a.netLargeUsd > 0); assert.ok(a.bookImbalance1pct > 0.5);
});
test("large aggressive selling reads as distribution pressure", () => {
  const t = trades([...baseline, [100, 400, true], [100, 350, true], [100, 300, true]]);
  assert.equal(F.analyseFlow(t, { bids: [[99.9, 50]], asks: [[100.1, 500]] }).verdict, "distribution_pressure");
});
test("too few prints is insufficient_data and yields no evidence", () => {
  const a = F.analyseFlow(trades([[1, 1, true], [1, 1, false]]), null); assert.equal(a.verdict, "insufficient_data"); assert.equal(F.flowEvidence(a), null);
});
test("wash-trading heuristics flag repeated identical prints and alternating same-size pairs", () => {
  const w = F.analyseFlow(trades(Array.from({ length: 60 }, (_, i): [number, number, boolean] => [100, 5, i % 2 === 0])), null);
  assert.ok(w.washScore > 0.5); assert.ok(w.washFlags.length >= 1);
  const clean = F.analyseFlow(trades(baseline), null); assert.ok(clean.washScore < w.washScore);
});
test("wash activity lowers the flow evidence score", () => {
  const good = F.flowEvidence(F.analyseFlow(trades([...baseline, [100, 400, false], [100, 350, false]]), { bids: [[99.9, 800]], asks: [[100.1, 100]] }))!;
  const washy = F.flowEvidence({ ...F.analyseFlow(trades([...baseline, [100, 400, false], [100, 350, false]]), { bids: [[99.9, 800]], asks: [[100.1, 100]] }), washScore: 0.8, washFlags: ["x"] })!;
  assert.ok(washy.score < good.score);
});
test("bid-support persistence needs enough snapshots", () => {
  assert.equal(F.bidSupportPersistence([0.3, 0.3]).persistent, false); assert.equal(F.bidSupportPersistence([0.3, 0.2, 0.5, 0.2, 0.4, 0.3, 0.2]).persistent, true);
});
const pairJson = { pairs: [{ chainId: "base", dexId: "uniswap", pairAddress: "0xp", baseToken: { address: "0xt", symbol: "NEW", name: "New" }, quoteToken: { symbol: "WETH" }, priceUsd: "0.01", liquidity: { usd: 20000 }, volume: { h24: 900000 }, txns: { h24: { buys: 900, sells: 10 } }, priceChange: { h24: 250 }, fdv: 50_000_000, pairCreatedAt: 1_700_000_000_000 }, { chainId: "x" }] };
test("parseDexPairs reads documented fields and drops malformed entries", () => { const p = F.parseDexPairs(pairJson); assert.equal(p.length, 1); assert.equal(p[0].liquidityUsd, 20000); assert.equal(p[0].priceUsd, 0.01); assert.deepEqual(F.parseDexPairs(null), []); });
test("assessDexPair flags thin, new, artificial-volume, one-way and tiny-float tokens and is never tradeable", () => {
  const p = F.parseDexPairs(pairJson)[0], a = F.assessDexPair(p, 1_700_000_000_000 + 3600_000);
  assert.ok(a.riskScore >= 0.9); assert.equal(a.tradeable, false); assert.ok(a.flags.length >= 4); assert.match(a.reason, /no connected execution venue/);
});
const sec = { result: { "0xt": { is_honeypot: "0", sell_tax: "0.02", buy_tax: "0", is_open_source: "1", is_mintable: "0", holders: [{ percent: "0.2" }, { percent: "0.2" }] } } };
test("parseTokenSecurity: clean contract is 'no_flags_found' with an explicit not-a-guarantee note", () => {
  const s = F.parseTokenSecurity(sec, "0xT")!; assert.equal(s.verdict, "no_flags_found"); assert.match(s.note, /NOT a safety guarantee/); assert.equal(F.parseTokenSecurity({}, "0xt"), null);
});
test("parseTokenSecurity: honeypot is critical, heavy concentration is flagged", () => {
  assert.equal(F.parseTokenSecurity({ result: { "0xt": { is_honeypot: "1" } } }, "0xt")!.verdict, "critical");
  const c = F.parseTokenSecurity({ result: { "0xt": { holders: [{ percent: "0.5" }, { percent: "0.4" }] } } }, "0xt")!; assert.equal(c.verdict, "high_risk"); assert.ok(c.flags.some(f => /extreme concentration/.test(f)));
  assert.equal(F.parseTokenSecurity({ result: { "0xt": { sell_tax: "0.5" } } }, "0xt")!.verdict, "high_risk");
});
test("on-chain evidence is zero for critical contracts and lowered for risky pairs", () => {
  const p = F.parseDexPairs(pairJson)[0]; assert.equal(F.onchainEvidenceForDex(p, F.parseTokenSecurity({ result: { "0xt": { is_honeypot: "1" } } }, "0xt"), 1_700_003_600_000).score, 0);
  assert.ok(F.onchainEvidenceForDex({ ...p, liquidityUsd: 5e6, volume24hUsd: 1e6, buys24h: 100, sells24h: 90, fdv: 1e7, createdAt: 1_600_000_000_000 }, null, 1_700_000_000_000).score > 0.8);
});
test("network helpers respect the budget and fail soft", async () => {
  const b = new Budget(1), f = (async () => new Response(JSON.stringify(pairJson))) as any;
  assert.equal((await F.fetchDexPairsForTokens([{ chainId: "base", tokenAddress: "0xt" }], b, f)).length, 1); assert.equal((await F.fetchDexPairsForTokens([{ chainId: "base", tokenAddress: "0xt" }], b, f)).length, 0);
  assert.equal(await F.fetchTokenSecurity("solana", "x", new Budget(3), f), null);
  assert.deepEqual(await F.fetchWalletTransfers("0x" + "a".repeat(40), 1, undefined, new Budget(3), f), { ok: false, reason: "etherscan_api_key_not_configured" });
  assert.equal((await F.fetchWalletTransfers("nope", 1, "k", new Budget(3), f) as any).reason, "invalid_address");
});
const A = "0x" + "a".repeat(40), EX = "0x" + "e".repeat(40), now = 1_700_000_000_000;
const tx = (from: string, to: string, amount: number, daysAgo: number, token = "USDC") => ({ hash: "h" + Math.random(), time: now - daysAgo * 86400000, from, to, token, amount, contract: "" });
test("wallet analysis: exchange inflow is possible distribution; names are asserted only with sourced high-confidence labels", () => {
  const labels = [{ address: EX, label: "Example Exchange hot wallet", kind: "exchange" as const, source: "exchange proof-of-reserves page", confidence: 0.95, addedAt: "x" }, { address: A, label: "Some Fund", kind: "fund" as const, source: null, confidence: 0.4, addedAt: "x" }];
  const w = F.analyseWallet(A, [tx(A, EX, 5000, 1), tx(EX, A, 100, 2)], labels, now);
  assert.equal(w.exchangeInflow.USDC, 5000); assert.ok(w.notes.some(n => /possible distribution/.test(n))); assert.match(w.attribution, /unattributed/); assert.doesNotMatch(w.attribution, /^Some Fund/);
  const sourced = F.analyseWallet(A, [], [{ ...labels[1], source: "fund's own disclosure", confidence: 0.9 }], now); assert.match(sourced.attribution, /Some Fund \(sourced/);
});
test("dormant wallet activation is detected", () => {
  const w = F.analyseWallet(A, [tx(EX, A, 1, 1), tx(EX, A, 1, 400)], [], now); assert.equal(w.dormantActivated, true); assert.ok(w.notes[0].includes("dormant"));
  assert.equal(F.analyseWallet(A, [tx(EX, A, 1, 1), tx(EX, A, 1, 10)], [], now).dormantActivated, false);
});
test("parseEtherscanTransfers scales token decimals", () => {
  const t = F.parseEtherscanTransfers({ result: [{ hash: "0x1", timeStamp: "1700000000", from: "0xAA", to: "0xBB", value: "2500000", tokenDecimal: "6", tokenSymbol: "USDC", contractAddress: "0xC" }] });
  assert.equal(t[0].amount, 2.5); assert.equal(t[0].from, "0xaa"); assert.deepEqual(F.parseEtherscanTransfers({ result: "Invalid API Key" }), []);
});
