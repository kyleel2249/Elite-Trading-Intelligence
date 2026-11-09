// Parity: the backtest screen and the paper engine must manage the same trade identically (same stops, partials, break-even, trailing).
import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { simulate, R_MULTIPLES, type BtParams, type Prepared } from "./backtest.ts";
import { MemoryPaperStore, PaperEngine } from "./paper.ts";

const T0 = 1_700_000_000_000, H = 3600000, NOCOST = { feeBps: 0, slippageBps: 0 };
const P: BtParams = { fast: 8, slow: 26, atrMult: 1, minFlow: 5, regimeFilter: false };
type Bar = [number, number, number, number];   // open, high, low, close

function screenR(dir: 1 | -1, bars: Record<number, Bar>, n = 130): number {
  const rows: Kline[] = Array.from({ length: n }, (_, i) => { const b = bars[i]; return [T0 + i * H, b ? b[0] : 100, b ? b[1] : 100.3, b ? b[2] : 99.7, b ? b[3] : 100, 100] as Kline; });
  const nan = new Array(n).fill(NaN), ones = (v: number) => new Array(n).fill(v), flow = [...nan]; flow[60] = 50 * dir;
  const p: Prepared = { rows, atr: ones(1), adx: ones(30), plusDI: ones(30), minusDI: ones(30), flow, bands: { trend: new Array(n).fill(dir > 0 ? "bull" : "bear"), upper: ones(0), lower: ones(0), flips: [], firstIdx: 15 }, ema: new Map([[8, ones(100 + dir)], [26, ones(100)]]) };
  const t = simulate(p, P, 0, n, NOCOST);
  assert.equal(t.length, 1);
  return t[0].r;   // costs are zero, so net R == gross R
}
async function paperR(dir: 1 | -1, bars: Record<number, Bar>): Promise<number> {
  const entry = 100, dist = 1, now = T0 + 61 * H;
  const px = (r: number) => entry + dir * dist * r;
  const plan: any = { symbol: "TESTUSDT", decision: dir > 0 ? "BUY" : "SELL", generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * H).toISOString(), confidence: 70, reasons: [],
    entryZone: dir > 0 ? [99.75, 100] : [100, 100.25], stopLoss: entry - dir * dist, takeProfits: ["TP1", "TP2", "TP3"].map((label, i) => ({ label, price: px(R_MULTIPLES[i]), rewardRisk: R_MULTIPLES[i] })),
    fusion: { direction: dir, acceptedEngine: "swift", swift: { regime: "t" }, gainz: { regime: "t" } } };
  const eng = await PaperEngine.create(new MemoryPaperStore(), async () => ({ approved: true, reasons: [] }), { feeRate: 0, slippageBps: 0, riskFraction: 0.01 }, now);
  const ev = await eng.open(plan, entry, now);
  assert.equal(ev.type, "OPENED", JSON.stringify(ev));
  const list = Object.keys(bars).map(Number).sort((a, b) => a - b).map(i => ({ ts: T0 + i * H + H / 2, high: bars[i][1], low: bars[i][2], close: bars[i][3] }));
  await eng.processBars("TESTUSDT", list);
  assert.equal(eng.state.closed.length, 1, "paper position should be closed by the script");
  const c = eng.state.closed[0];
  return c.pnl / c.riskAmount;
}

const SCENARIOS: Record<string, [1 | -1, Record<number, Bar>]> = {
  "stopped out immediately": [1, { 61: [100, 100.4, 98.9, 99.2] }],
  "stop and all targets touched in one bar: stop first": [1, { 61: [100, 105, 98.9, 104] }],
  "TP1 then stopped at break-even": [1, { 61: [100, 101.3, 99.5, 101], 62: [100.5, 100.8, 99.9, 100.2] }],
  "TP1, TP2 then trailing stop": [1, { 61: [100, 101.3, 99.5, 101], 62: [101, 102.3, 100.5, 102], 63: [101.5, 101.8, 100.5, 100.7] }],
  "all three targets": [1, { 61: [100, 101.3, 99.5, 101], 62: [101, 102.3, 100.5, 102], 63: [102, 103.6, 101.5, 103.5] }],
  "short: all three targets": [-1, { 61: [100, 100.2, 98.7, 99], 62: [99, 99.2, 97.7, 98], 63: [98, 98.2, 96.4, 96.5] }],
  "short: TP1 then stopped at break-even": [-1, { 61: [100, 100.5, 98.7, 99], 62: [99.5, 100.1, 99.2, 99.9] }],
};
for (const [name, [dir, bars]] of Object.entries(SCENARIOS)) {
  test(`parity: ${name}`, async () => {
    const a = screenR(dir, bars), b = await paperR(dir, bars);
    assert.ok(Math.abs(a - b) < 1e-9, `screen ${a.toFixed(6)}R vs paper ${b.toFixed(6)}R`);
  });
}

test("documented divergence: through a gap the screen fills at the gap price (conservative); the paper engine fills at the stop price", async () => {
  const bars: Record<number, Bar> = { 61: [100, 100.3, 99.5, 100], 62: [97, 97.5, 96.5, 97] };
  const screen = screenR(1, bars), paper = await paperR(1, bars);
  assert.ok(Math.abs(screen - -3) < 1e-9, `screen ${screen}`);
  assert.ok(Math.abs(paper - -1) < 1e-9, `paper ${paper}`);
  assert.ok(screen < paper, "the screen must never be more optimistic than the paper engine on a gap");
});
