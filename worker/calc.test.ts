import test from "node:test";
import assert from "node:assert/strict";
import { calculate, handleCalc, type CalcInput, type CalcOk } from "./calc.ts";

const ok = (i: Partial<CalcInput>) => { const r = calculate({ side: "long", entry: 100, leverage: 10, sizeBy: "margin", margin: 1000, takerFeeBps: 0, ...i } as CalcInput); assert.ok(r.ok, JSON.stringify(r)); return r as CalcOk; };

test("long: margin, notional, quantity, profit and ROI on margin are exact with no fees", () => {
  const r = ok({ target: 110, stop: 95 });
  assert.equal(r.position.notional, 10_000); assert.equal(r.position.quantity, 100); assert.equal(r.position.margin, 1000);
  assert.equal(r.atTarget!.netPnl, 1000); assert.equal(r.atTarget!.roiOnMarginPct, 100); assert.equal(r.atStop!.netPnl, -500); assert.equal(r.rewardRisk, 2);
  assert.equal(r.liquidation.price, 90.5); // 100 * (1 - 1/10 + 0.005)
});
test("short mirrors long: profit when price falls, liquidation above entry", () => {
  const r = ok({ side: "short", target: 90, stop: 105 });
  assert.equal(r.atTarget!.netPnl, 1000); assert.equal(r.atStop!.netPnl, -500); assert.equal(r.liquidation.price, 109.5);
});
test("fees apply on both legs and break-even moves past entry", () => {
  const r = ok({ takerFeeBps: 10, target: 110 });
  assert.equal(r.fees.entry, 10); assert.equal(r.atTarget!.fees, 21); assert.equal(r.atTarget!.netPnl, 979);
  assert.ok(r.breakEven > 100.19 && r.breakEven < 100.21);
  assert.ok(ok({ side: "short", takerFeeBps: 10 }).breakEven < 99.81);
});
test("sizing by quantity and by risk (fees included in the risk per unit)", () => {
  assert.equal(ok({ sizeBy: "quantity", quantity: 5 }).position.margin, 50);
  const r = ok({ sizeBy: "risk", balance: 10_000, riskPct: 1, stop: 98, takerFeeBps: 0, leverage: 5 });
  assert.equal(r.position.quantity, 50); assert.equal(r.atStop!.netPnl, -100); // exactly 1% of the balance at the stop
  const f = ok({ sizeBy: "risk", balance: 10_000, riskPct: 1, stop: 98, takerFeeBps: 10, leverage: 5 }); assert.ok(Math.abs(f.atStop!.netPnl + 100) < 0.02);
});
test("funding is charged to longs and credited to shorts when the rate is positive", () => {
  assert.equal(ok({ target: 110, fundingRatePct: 0.01, fundingIntervals: 3 }).atTarget!.funding, 3);
  assert.equal(ok({ side: "short", target: 90, fundingRatePct: 0.01, fundingIntervals: 3 }).atTarget!.funding, -3);
});
test("warnings: high leverage, stop beyond liquidation, margin above balance, poor reward/risk", () => {
  const w = ok({ leverage: 50, stop: 97, target: 101, balance: 10, margin: 1000 }).warnings.join(" ");
  assert.match(w, /50x leverage/); assert.match(w, /beyond the estimated liquidation/); assert.match(w, /exceeds the stated balance/); assert.match(w, /below 1/); assert.match(w, /Estimates only/);
});
test("invalid inputs are rejected with clear reasons, never silently corrected", () => {
  const bad = (i: object) => { const r = calculate({ side: "long", entry: 100, leverage: 10, sizeBy: "margin", margin: 1000, ...i } as CalcInput); assert.equal(r.ok, false); return (r as { errors: string[] }).errors.join(" "); };
  assert.match(bad({ leverage: 151 }), /between 1 and 150/); assert.match(bad({ leverage: 0 }), /between 1 and 150/); assert.match(bad({ entry: -1 }), /entry/);
  assert.match(bad({ stop: 105 }), /stop must be below/); assert.match(bad({ target: 95 }), /target must be above/); assert.match(bad({ side: "short", stop: 95 }), /stop must be above/);
  assert.match(bad({ sizeBy: "risk", balance: 1000, riskPct: 1 }), /stop price is required/); assert.match(bad({ margin: -5 }), /margin/); assert.match(bad({ side: "up" }), /side/); assert.match(bad({ entry: NaN }), /entry/);
});
test("HTTP endpoint: POST and GET agree, errors are 400, and it never submits an order", async () => {
  const body = { side: "long", entry: 60000, target: 63000, stop: 59000, leverage: 10, sizeBy: "margin", margin: 1000 };
  const post = await handleCalc(new Request("https://eti.test/api/calc/position", { method: "POST", body: JSON.stringify(body) })), p = await post.json() as any;
  const get = await handleCalc(new Request("https://eti.test/api/calc/position?side=long&entry=60000&target=63000&stop=59000&leverage=10&sizeBy=margin&margin=1000")), g = await get.json() as any;
  assert.equal(post.status, 200); assert.equal(p.submitsOrder, false); assert.deepEqual(p.position, g.position); assert.equal(p.position.quantity, 0.16666667);
  assert.equal((await handleCalc(new Request("https://eti.test/api/calc/position", { method: "POST", body: "{" }))).status, 400);
  assert.equal((await handleCalc(new Request("https://eti.test/api/calc/position", { method: "POST", body: JSON.stringify({ ...body, leverage: 500 }) }))).status, 400);
  assert.equal((await handleCalc(new Request("https://eti.test/api/calc/position", { method: "DELETE" }))).status, 405);
});

import worker from "./index.ts";
test("the Worker serves the calculator API and the dashboard exposes chart trading and the calculator", async () => {
  const r = await worker.fetch(new Request("https://eti.test/api/calc/position?side=short&entry=100&target=90&stop=105&leverage=5&sizeBy=margin&margin=500"), {} as never), d = await r.json() as any;
  assert.equal(r.status, 200); assert.equal(d.ok, true); assert.equal(d.liquidation.price, 119.5); assert.equal(d.submitsOrder, false);
  const page = await (await worker.fetch(new Request("https://eti.test/"), {} as never)).text();
  for (const id of ["chartTicket", "ctPrice", "ctQty", "ctBuyLimit", "ctSellLimit", "ctBuyMkt", "ctSellMkt", "calcPanel", "calcLev", "calcRun", "calcToTicket", "calcShow"]) assert.ok(page.includes(`id="${id}"`), id);
  assert.ok(page.includes("function ctPriceAt") && page.includes("function drawChartLines") && page.includes("chartScale=") && page.includes("/api/calc/position"));
  assert.ok(page.includes("function ctSubmit(side,type){") && /ctSubmit[^]*submitOrder\(side\)/.test(page), "chart orders must reuse the confirmed submitOrder path");
  assert.ok(!/<option value="live">(?!Live \(disabled\))/.test(page), "the only live option is the disabled portfolio filter");
});
