import test from "node:test";
import assert from "node:assert/strict";
import { LAB_STRATEGIES, compatibility, horizonOf, metricsOf, poolLabs, runLab } from "./lab.ts";
import { makeCandles, range, trend } from "./testdata.ts";

const cycle = () => makeCandles([trend(120, 0.0006, 0.006), range(60, 0.006), trend(100, 0.0007, 0.006), trend(60, -0.0008, 0.006), range(60, 0.005), trend(120, 0.0008, 0.006), range(40, 0.005)], { price: 40, seed: 11 });

test("every non-testable strategy states what data it needs and is never simulated", () => {
  const lab = runLab(cycle(), { symbol: "TESTUSDT", interval: "1h", assetClass: "crypto" })!;
  const nt = lab.results.filter(r => r.status === "not_testable");
  assert.ok(nt.length >= 6); for (const r of nt) { assert.equal(r.overall.n, 0); assert.match(r.statusReason, /needs|validation/); }
});
test("lab is deterministic and reports envelope, costs and caveats", () => {
  const a = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!, b = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  assert.deepEqual(a.results.map(r => [r.id, r.overall.n, r.overall.avgR]), b.results.map(r => [r.id, r.overall.n, r.overall.avgR]));
  assert.ok(a.caveats.some(c => /bps per side/.test(c))); assert.equal(a.envelope.direction, "long_only");
});
test("no trade is entered before the first fully-warmed bar and none extends past the data (no look-ahead)", () => {
  const rows = cycle(), lab = runLab(rows, { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  for (const list of Object.values(lab.trades)) for (const t of list) { assert.ok(t.entryIndex >= 210); assert.ok(t.exitTime <= rows[rows.length - 1][0]); assert.ok(t.time > rows[t.entryIndex][0]); }
});
test("R multiples respect the envelope: wins are +2R minus cost, stop losses are about -1R minus cost", () => {
  const lab = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  for (const list of Object.values(lab.trades)) for (const t of list) { if (t.outcome === "win") assert.ok(t.r <= 2 && t.r > 1.5); if (t.outcome === "loss") assert.ok(t.r <= -0.95); }
});
test("future data does not change earlier trades (prefix stability)", () => {
  const rows = cycle(), cut = rows.length - 60;
  const a = runLab(rows.slice(0, cut), { symbol: "X", interval: "1h", assetClass: "crypto" })!, b = runLab(rows, { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  let compared = 0;
  for (const id of Object.keys(a.trades).filter(i => !i.startsWith("combo:") && i !== "control_random")) {
    for (const t of a.trades[id]) { const same = b.trades[id].find(x => x.entryIndex === t.entryIndex); assert.ok(same, id + " lost trade at " + t.entryIndex); assert.equal(same!.r, t.r); compared++; }
  }
  assert.ok(compared > 5, "compared " + compared);
});
test("significance threshold is corrected for the number of strategies compared", () => {
  const lab = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  assert.ok(lab.criticalT > 1.645, String(lab.criticalT)); assert.equal(lab.strategiesCompared, lab.results.filter(r => r.status !== "not_testable").length);
});
test("no strategy is promoted on a sample smaller than 30 out-of-sample trades", () => {
  const lab = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  for (const r of lab.results) if (r.status === "promoted") assert.ok(r.outOfSample.n >= 30 && (r.outOfSample.t ?? 0) >= r.criticalT);
});
test("combinations are selected from in-sample results and labelled as such", () => {
  const lab = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!;
  for (const c of lab.results.filter(r => r.kind === "combination")) { assert.equal(c.members!.length, 2); assert.match(c.compat.reasons.join(" "), /in-sample/); }
});
test("compatibility engine blocks structural mismatches and fundamentals on candles", () => {
  assert.equal(compatibility("buffett_munger_value", { assetClass: "equity", interval: "1d" }).compatible, false);
  assert.equal(compatibility("turtle_system2", { assetClass: "crypto", interval: "1m" }).compatible, false);
  assert.equal(compatibility("seykota_mechanical", { assetClass: "crypto", interval: "1d" }).compatible, true);
  const c = compatibility("wyckoff_supply_demand", { assetClass: "crypto", interval: "1h", regime: "trend" });
  assert.equal(c.compatible, true); assert.ok(c.score <= 0.3);
  assert.equal(compatibility("nope", { assetClass: "crypto", interval: "1h" }).compatible, false);
});
test("horizon mapping", () => { assert.equal(horizonOf("1m"), "scalp"); assert.equal(horizonOf("1h"), "intraday"); assert.equal(horizonOf("1d"), "swing"); assert.equal(horizonOf("1w"), "position"); });
test("metricsOf: expectancy, profit factor, drawdown", () => {
  const m = metricsOf([{ r: 2 }, { r: -1 }, { r: -1 }, { r: 2 }]); assert.equal(m.n, 4); assert.equal(m.avgR, 0.5); assert.equal(m.profitFactor, 2); assert.equal(m.maxDrawdownR, 2); assert.equal(metricsOf([]).avgR, null);
});
test("too little history returns null and pooling reports markets", () => {
  assert.equal(runLab(makeCandles([range(200)]), { symbol: "X", interval: "1h", assetClass: "crypto" }), null);
  const lab = runLab(cycle(), { symbol: "X", interval: "1h", assetClass: "crypto" })!, pool = poolLabs([lab, lab]);
  assert.equal(pool.markets, 2); assert.ok(pool.rows.length > 5);
});
