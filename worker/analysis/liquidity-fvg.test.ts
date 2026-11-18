import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiquidityFvg } from "./liquidity-fvg.ts";
import type { Kline } from "../market.ts";

function candles(n: number): Kline[] {
  const rows: Kline[] = [];
  let close = 100;
  for (let i=0;i<n;i++) {
    const open=close, drift=Math.sin(i/4)*0.25 + (i%9===0?0.18:-0.02);
    close=Math.max(1,open+drift);
    const high=Math.max(open,close)+0.35, low=Math.min(open,close)-0.35;
    rows.push([1_700_000_000_000+i*60_000,open,high,low,close,100+(i%7)*10] as Kline);
  }
  return rows;
}

test("liquidity-FVG engine refuses insufficient history",()=>{
  const r=analyzeLiquidityFvg(candles(20),"1m");
  assert.equal(r.status,"insufficient_history");
  assert.equal(r.direction,"WAIT");
  assert.equal(r.autopilotEligible,false);
  assert.equal(r.safety.submitsOrder,false);
});

test("liquidity-FVG engine is advisory and cannot bypass risk controls",()=>{
  const r=analyzeLiquidityFvg(candles(120),"1m",{symbol:"BTCUSDT"});
  assert.equal(r.schema,"eti.liquidity-fvg/1");
  assert.equal(r.status,"ready");
  assert.equal(r.autopilotEligible,false);
  assert.equal(r.setup,null);
  assert.equal(r.safety.advisoryOnly,true);
  assert.equal(r.safety.bypassesRiskManager,false);
  assert.equal(r.safety.liveExecutionAllowed,false);
  assert.ok(["low","moderate","elevated","high"].includes(r.manipulation.level));
  assert.ok(r.pools.every(p=>p.distanceAtr>=0 && p.sweepRisk>=0 && p.sweepRisk<=100));
});

test("sweep excursion estimates are ordered and finite",()=>{
  const r=analyzeLiquidityFvg(candles(160),"1m");
  for(const p of r.pools){
    assert.ok(Number.isFinite(p.estimatedSweepBand.low));
    assert.ok(Number.isFinite(p.estimatedSweepBand.high));
    assert.ok(p.estimatedSweepBand.low<=p.estimatedSweepBand.high);
  }
});
