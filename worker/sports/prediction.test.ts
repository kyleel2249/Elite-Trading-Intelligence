import {test} from "node:test";
import assert from "node:assert/strict";
import {estimateFootballMatch,fitTemperature,applyTemperature,fractionalKellyStake} from "./prediction.ts";
const history=Array.from({length:30},(_,i)=>({fixtureId:String(i),competition:"League",homeTeam:i%2?"Alpha":"Beta",awayTeam:i%2?"Beta":"Alpha",homeGoals:i%3===0?2:1,awayGoals:i%4===0?1:0,playedAt:Date.now()-i*86400000}));
test("Poisson engine returns bounded coherent football probabilities",()=>{const p=estimateFootballMatch(history,"Alpha","Beta","League");const x=p.probabilities;assert.ok(Math.abs(x.home+x.draw+x.away-1)<1e-9);for(const v of Object.values(x))assert.ok(v>=0&&v<=1);assert.ok(p.expectedHomeGoals>0&&p.expectedAwayGoals>0);});
test("prediction refuses to claim calibration without 100 resolved predictions",()=>{const p=fitTemperature([]);assert.equal(p.calibrated,false);assert.equal(p.sampleSize,0);});
test("temperature calibration fits a resolved out-of-sample record set",()=>{const rows=Array.from({length:120},(_,i)=>({pHome:.6,pDraw:.25,pAway:.15,outcome:i%3===0?"H":i%3===1?"D":"A"} as const));const c=fitTemperature(rows as any);assert.equal(c.calibrated,true);assert.ok(c.sampleSize>=100);const p=applyTemperature({home:.6,draw:.25,away:.15},c.temperature);assert.ok(Math.abs(p.home+p.draw+p.away-1)<1e-9);});
test("fractional Kelly never exceeds the configured event cap",()=>{const s=fractionalKellyStake(.6,2.1,100000);assert.ok(s>0&&s<=1000);assert.equal(fractionalKellyStake(.2,2,100000),0);});
