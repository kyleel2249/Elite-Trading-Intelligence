import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";

test("main dashboard visibly includes Central Market Intelligence and live chart interpretation",async()=>{
 const response=await worker.fetch(new Request("https://eti.test/"),{} as any);
 assert.equal(response.status,200);
 const html=await response.text();
 for(const label of ["Central Market Intelligence","Chart Signal Interpretation","chartSignalGlossary","chartNextAction","Refresh Central Intelligence","ORDER verification rule"])assert.ok(html.includes(label),"missing dashboard feature: "+label);
 assert.ok(html.includes("runIntel(false)"),"CMI should auto-run after validated chart signals");
});
test("dashboard glossary covers chart order, liquidity, structure, momentum and derivatives labels",async()=>{
 const response=await worker.fetch(new Request("https://eti.test/"),{} as any),html=await response.text();
 for(const term of ["ORDER","BSL / SSL","SWEEP REACH HIGH / LOW","FVG / BULL FVG / BEAR FVG","BOS / CHoCH","RSI 14","MACD / SIGNAL / HISTOGRAM","FUNDING / OPEN INTEREST"])assert.ok(html.includes(term),"missing glossary term: "+term);
});
