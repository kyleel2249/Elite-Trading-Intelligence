import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSynchronizedV3Alpha, evaluateAgentGates, monteCarloRisk, thresholdSensitivity, type OutcomeSample } from "./v3-alpha-intelligence.ts";
import { series } from "./fixtures.ts";
import { TF_SECONDS } from "./timeframes.ts";

const NOW=1_800_000_000_000;
function samples(n=80):OutcomeSample[]{return Array.from({length:n},(_,i)=>({strategy:"intraday",regime:"trend",score:60+(i%30),outcome:i%3===0?"loss":"win",outcome_r:i%3===0?-1:1.5,signal_time:NOW+i*900000} as OutcomeSample));}

test("synchronized snapshot excludes candles that had not closed at execution close",()=>{
 const exec=series(300,{drift:.1,noise:.4,start:100,seed:9,stepMs:TF_SECONDS["15m"]*1000,end:NOW-TF_SECONDS["15m"]*1000});
 const hourly=series(100,{drift:.1,noise:.4,start:100,seed:10,stepMs:TF_SECONDS["1h"]*1000,end:NOW-TF_SECONDS["1h"]*1000});
 const result=evaluateSynchronizedV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:{"15m":exec,"1h":hourly},now:NOW});
 assert.equal(result.synchronizedAt,exec.at(-1)![0]+TF_SECONDS["15m"]*1000);
 assert.ok((result.coverage["1h"]??0)<=hourly.length);
 assert.equal(result.signal.nonRepainting,true);
 assert.equal(result.signal.submitsOrder,false);
});

test("synchronized snapshot rejects malformed timeframe data without throwing",()=>{
 const rows=series(250);rows[100]=[rows[100][0],10,1,9,10,1];
 const result=evaluateSynchronizedV3Alpha({symbol:"BTCUSDT",strategy:"intraday",candles:{"15m":rows},now:NOW});
 assert.equal(result.synchronizedAt,null);
 assert.ok(result.warnings.length>0);
 assert.equal(result.signal.action,"NO_TRADE");
});

test("agent performance gates require minimum sample and positive expectancy",()=>{
 const good=samples(60),small=samples(10);
 assert.equal(evaluateAgentGates(small)[0].status,"insufficient_sample");
 assert.equal(evaluateAgentGates(good)[0].approvedForPaperEvaluation,true);
 const bad=good.map(x=>({...x,outcome_r:-1,outcome:"loss" as const}));
 assert.equal(evaluateAgentGates(bad)[0].status,"blocked_by_performance");
});

test("threshold sensitivity keeps chronological holdout and never auto-selects",()=>{
 const result=thresholdSensitivity(samples(100));
 assert.equal(result.split,"chronological_70_30");
 assert.equal(result.candidates.length,6);
 assert.ok(result.candidates.every(x=>x.train.sampleSize+x.test.sampleSize<=100));
 assert.match(result.note,/not auto-selected/);
});

test("Monte Carlo is deterministic, bounded and sample-gated",()=>{
 assert.equal(monteCarloRisk({rMultiples:Array(29).fill(1)}).status,"insufficient_sample");
 const a=monteCarloRisk({rMultiples:samples().map(x=>x.outcome_r),simulations:500,seed:42});
 const b=monteCarloRisk({rMultiples:samples().map(x=>x.outcome_r),simulations:500,seed:42});
 assert.equal(a.status,"simulated");
 assert.deepEqual(a.endingReturnPct,b.endingReturnPct);
 assert.ok(a.probabilityOf50PctDrawdown>=0&&a.probabilityOf50PctDrawdown<=1);
});
