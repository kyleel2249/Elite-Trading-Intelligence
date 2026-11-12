import test from "node:test";
import assert from "node:assert/strict";
import { computePosition } from "./core.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("long 10x: notional, margin, fees, P&L, ROI, liquidation and break-even match hand calculation", () => {
  const r: any = computePosition({ side: "buy", entry: 100, exit: 110, stop: 95, quantity: 1, leverage: 10, feePct: 0.05 });
  assert.equal(r.ok, true);
  close(r.notional, 100); close(r.margin, 10);
  close(r.target.gross, 10); close(r.target.fees, 0.0005 * (100 + 110)); close(r.target.net, 10 - 0.105); close(r.target.roiPct, 98.95);
  close(r.liquidation, 90.5); close(r.liquidationDistancePct, 9.5);
  close(r.breakEven, (100 * 1.0005) / 0.9995);
  close(r.stopResult.net, -5 - 0.0005 * 195); close(r.riskReward, 2);
});
test("short: P&L sign, liquidation above entry, break-even below entry", () => {
  const r: any = computePosition({ side: "sell", entry: 100, exit: 90, stop: 104, quantity: 2, leverage: 5, feePct: 0 });
  close(r.target.net, 20); close(r.liquidation, 100 * (1 + 0.2 - 0.005)); close(r.stopResult.net, -8); close(r.breakEven, 100); close(r.riskReward, 2.5);
});
test("size by margin: units = margin x leverage / price; contract size and quote-to-account rate apply", () => {
  const m: any = computePosition({ side: "buy", entry: 50, sizeBy: "margin", margin: 100, leverage: 5, feePct: 0 });
  close(m.units, 10); close(m.notional, 500);
  const fxr: any = computePosition({ side: "buy", entry: 1.1, exit: 1.101, quantity: 1, contractSize: 100000, leverage: 30, feePct: 0, fxRate: 1 });
  close(fxr.units, 100000); close(fxr.notional, 110000); close(fxr.target.net, 100); close(fxr.margin, 110000 / 30);
  const gold: any = computePosition({ side: "buy", entry: 2000, exit: 2010, quantity: 2, contractSize: 100, leverage: 20, feePct: 0 });
  close(gold.target.net, 2000);
  const fx2: any = computePosition({ side: "buy", entry: 150, exit: 151, quantity: 1000, leverage: 10, feePct: 0, fxRate: 1 / 150 });
  close(fx2.target.net, 1000 / 150);
});
test("price needed for a target net profit round-trips through the P&L", () => {
  for (const side of ["buy", "sell"] as const) {
    const base = { side, entry: 100, quantity: 3, leverage: 10, feePct: 0.06, slippagePct: 0.02, fundingPct: 0.03 };
    const r: any = computePosition({ ...base, targetProfit: 25 });
    const back: any = computePosition({ ...base, exit: r.priceForTargetProfit });
    close(back.target.net, 25, 1e-7);
    const be: any = computePosition({ ...base, exit: r.breakEven });
    close(be.target.net, 0, 1e-7);
  }
});
test("warnings: stop beyond liquidation, wrong-side stop, thin liquidation distance, exit beyond liquidation", () => {
  const a: any = computePosition({ side: "buy", entry: 100, stop: 80, exit: 120, quantity: 1, leverage: 10 });
  assert.ok(a.warnings.some((w: string) => /Stop is beyond the estimated liquidation/.test(w)));
  const b: any = computePosition({ side: "buy", entry: 100, stop: 105, quantity: 1, leverage: 2 });
  assert.ok(b.warnings.some((w: string) => /wrong side/.test(w))); assert.equal(b.stopResult, null);
  const c: any = computePosition({ side: "buy", entry: 100, quantity: 1, leverage: 50 });
  assert.ok(c.warnings.some((w: string) => /only 1\.50% away|only/.test(w)));
  const d: any = computePosition({ side: "sell", entry: 100, exit: 130, quantity: 1, leverage: 10 });
  assert.ok(d.warnings.some((w: string) => /beyond the estimated liquidation/.test(w)));
});
test("unleveraged long has no liquidation; leverage whose initial margin <= maintenance margin is rejected", () => {
  const a: any = computePosition({ side: "buy", entry: 100, quantity: 1, leverage: 1 });
  assert.equal(a.liquidation, null);
  const b: any = computePosition({ side: "buy", entry: 100, quantity: 1, leverage: 150, mmrPct: 1 });
  assert.equal(b.ok, false); assert.match(b.errors[0], /liquidated at entry/);
});
test("ladder covers 1x-125x, margin falls and liquidation approaches entry as leverage rises", () => {
  const r: any = computePosition({ side: "buy", entry: 100, exit: 105, quantity: 1, leverage: 10 });
  assert.equal(r.ladder.length, 11);
  const x5 = r.ladder.find((l: any) => l.leverage === 5), x20 = r.ladder.find((l: any) => l.leverage === 20);
  assert.ok(x20.margin < x5.margin && x20.liquidation > x5.liquidation);
  assert.ok(r.ladder.find((l: any) => l.leverage === 125).immediate === false);
});
test("rejects bad input instead of computing", () => {
  for (const bad of [{ entry: 0 }, { entry: NaN }, { leverage: 0 }, { leverage: 151 }, { quantity: 0 }, { quantity: -1 }, { feePct: -1 }, { contractSize: 0 }, { fxRate: 0 }, { exit: -5 }, { side: "x" as any }]) {
    const r: any = computePosition({ side: "buy", entry: 100, quantity: 1, leverage: 5, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(r.errors.length);
  }
});

test("the function embedded in the dashboard script is the same arithmetic (runs standalone, with esbuild's __name helper present)", async () => {
  const { CALC_JS, CALC_HTML } = await import("./ui.ts");
  const m = CALC_JS.match(/var computePosition=([\s\S]*?\});\n\(function\(\)\{/);
  assert.ok(m, "embedded function not found");
  const fn = new Function("__name", "return " + m![1])((f: any) => f);
  const a: any = fn({ side: "buy", entry: 100, exit: 110, quantity: 1, leverage: 10, feePct: 0.05 }), b: any = computePosition({ side: "buy", entry: 100, exit: 110, quantity: 1, leverage: 10, feePct: 0.05 });
  assert.deepEqual(a, b);
  assert.ok(!CALC_JS.includes("`") && !CALC_JS.includes("${") && !CALC_JS.includes("\\"));
  for (const id of ["clSide", "clEntry", "clExit", "clStop", "clLev", "clLevRange", "clFee", "clMmr", "clFx", "clTp", "clLadder", "clKpis", "clMsgs"]) assert.ok(CALC_HTML.includes('id="' + id + '"'), id);
});
test("dashboard serves the calculator panel and script", async () => {
  const { default: app } = await import("../index.ts"), html = await (await app.fetch(new Request("https://x.test/"), {} as any)).text();
  assert.match(html, /id="calcPanel"/); assert.match(html, /var computePosition=/);
});
