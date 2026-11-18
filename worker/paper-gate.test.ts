import test from "node:test";
import assert from "node:assert/strict";
import { paperPolicyGate } from "./risk/paper-gate.ts";
import type { PaperGateInput } from "./risk/paper-gate.ts";
import { DEFAULT_POLICY } from "./risk/policy.ts";
import { MemoryPaperStore, PaperEngine } from "./algo/paper.ts";

const input = (o: Partial<PaperGateInput> = {}): PaperGateInput => ({
  policy: DEFAULT_POLICY, equity: 10000, dayStartEquity: 10000, startingEquity: 10000, positions: [], closed: [], direction: 1, fill: 100, stop: 98,
  targets: [{ price: 103, fraction: 0.4 }, { price: 106, fraction: 0.3 }, { price: 109, fraction: 0.3 }], feeRate: 0.001, slippageRate: 0.0005, ...o,
});
const reasonCodes = (r: ReturnType<typeof paperPolicyGate>) => (r.ok ? [] : r.reasons.map((x) => /\((\w+)\)/.exec(x)?.[1]));

test("gate sizes at 0.5% risk and uses the blended target for reward-to-risk", () => {
  const r = paperPolicyGate(input());
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.quantity, 25); assert.equal(r.riskAmount, 50); assert.ok(r.netRewardToRisk > 2); }
});

test("committed notional counts against the 50% cash reserve", () => {
  const held = [{ remainingQty: 45, entry: 100 }]; // 4500 committed
  const r = paperPolicyGate(input({ positions: held }));
  assert.equal(r.ok, true);
  if (r.ok) { assert.ok(r.quantity * 100 <= 500 + 1e-6); assert.equal(r.binding, "capital"); }
  assert.deepEqual(reasonCodes(paperPolicyGate(input({ positions: [{ remainingQty: 50, entry: 100 }] }))), ["no_trading_capital"]);
});

test("rejects reward-to-risk below 1.5 after costs", () => {
  const r = paperPolicyGate(input({ targets: [{ price: 101, fraction: 0.4 }, { price: 101.5, fraction: 0.3 }, { price: 102, fraction: 0.3 }] }));
  assert.deepEqual(reasonCodes(r), ["reward_to_risk"]);
});

test("drawdown from the closed-trade peak stops entries", () => {
  const r = paperPolicyGate(input({ equity: 10700, dayStartEquity: 10700, closed: [{ pnl: 2000 }, { pnl: -1300 }] })); // peak 12000, now 10700 = 10.8%
  assert.deepEqual(reasonCodes(r), ["drawdown_limit"]);
});

test("three consecutive losses and a 2% daily loss stop entries", () => {
  assert.deepEqual(reasonCodes(paperPolicyGate(input({ equity: 9700, dayStartEquity: 9700, startingEquity: 10000, closed: [{ pnl: -100 }, { pnl: -100 }, { pnl: -100 }] }))), ["consecutive_losses"]);
  assert.deepEqual(reasonCodes(paperPolicyGate(input({ equity: 9790, dayStartEquity: 10000 }))), ["daily_loss_limit"]);
});

test("invalid targets or prices fail closed", () => {
  assert.equal(paperPolicyGate(input({ targets: [] })).ok, false);
  assert.equal(paperPolicyGate(input({ fill: NaN })).ok, false);
});

const plan = (tp: [number, number, number], stop = 99.9): any => ({
  symbol: "BTCUSDT", decision: "BUY", generatedAt: 1, expiresAt: null, entryZone: [99.9, 100.1], stopLoss: stop, confidence: 70, reasons: [],
  takeProfits: [{ label: "TP1", price: tp[0] }, { label: "TP2", price: tp[1] }, { label: "TP3", price: tp[2] }],
  fusion: { direction: "LONG", acceptedEngine: "both", swift: { regime: "trend" }, gainz: { regime: "trend" } },
});

test("engine with the policy enabled caps a tight-stop position at the 50% notional limit; without it the legacy size stands", async () => {
  const legacy = await PaperEngine.create(new MemoryPaperStore(), {}, 1);
  const guarded = await PaperEngine.create(new MemoryPaperStore(), { policy: DEFAULT_POLICY }, 1);
  const a = await legacy.open(plan([103, 106, 109]), 100, 1);
  const b = await guarded.open(plan([103, 106, 109]), 100, 1);
  assert.equal(a.type, "OPENED");
  assert.equal(b.type, "OPENED");
  const qa = legacy.state.positions[0].qty, qb = guarded.state.positions[0].qty;
  assert.ok(qa > 90, `legacy qty ${qa}`);
  assert.ok(qb < qa);
  assert.ok(qb * 100.05 <= 5000 + 1e-6, "notional within 50% of equity");
});

test("engine with the policy enabled rejects a plan whose net reward-to-risk is too low", async () => {
  const guarded = await PaperEngine.create(new MemoryPaperStore(), { policy: DEFAULT_POLICY }, 1);
  const e = await guarded.open(plan([100.2, 100.3, 100.4]), 100, 1);
  assert.equal(e.type, "REJECTED");
  assert.ok(e.reasons?.some((r) => r.includes("reward_to_risk")));
  assert.equal(guarded.state.positions.length, 0);
});
