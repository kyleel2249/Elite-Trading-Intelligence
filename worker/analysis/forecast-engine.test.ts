import test from "node:test";
import assert from "node:assert/strict";
import {forecastScenarios,validateForecastCandles} from "./forecast-engine.ts";
import {handleForecast} from "./forecast-route.ts";
const candles=Array.from({length:100},(_,i)=>{const close=100*Math.exp(i*0.0005);return {time:1700000000000+i*3600000,open:close,high:close*1.01,low:close*0.99,close,volume:1000}});
test("validates ordered OHLC candles",()=>{assert.equal(validateForecastCandles(candles).length,100);assert.throws(()=>validateForecastCandles(candles.slice(0,19)),/candles_require/);assert.throws(()=>validateForecastCandles(candles.map((c,i)=>i===50?{...c,high:c.low-1}:c)),/invalid_candle/);});
test("returns bounded scenarios, range, confidence and expiries",()=>{const out=forecastScenarios(candles,1800000000000);assert.equal(out.length,3);for(const f of out){assert.ok(f.expectedPrice>0&&f.rangeLow>0&&f.rangeHigh>f.rangeLow);assert.ok(f.upProbability>=0&&f.downProbability>=0&&f.neutralProbability>=0);assert.ok(f.confidence>=0&&f.confidence<=100);assert.ok(f.expiresAt>1800000000000);}});
test("stale candles flagged and confidence reduced",()=>{const fresh=forecastScenarios(candles,candles.at(-1).time+1000)[0];const stale=forecastScenarios(candles,candles.at(-1).time+100000000)[0];assert.equal(fresh.stale,false);assert.equal(stale.stale,true);assert.ok(stale.confidence<fresh.confidence);});
test("route rejects method and invalid body",async()=>{assert.equal((await handleForecast(new Request("https://eti/api/forecast/scenarios"))).status,405);assert.equal((await handleForecast(new Request("https://eti/api/forecast/scenarios",{method:"POST",body:"{}"}))).status,400);});});
