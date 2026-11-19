import test from "node:test";
import assert from "node:assert/strict";
import { deliberate } from "./commander.ts";
import { makeReport } from "./types.ts";

test("Commander exposes opposing directional views even when confidence is below vote threshold", () => {
  const reports = [
    makeReport("quant", { stance: "neutral", confidence: 0.12, summary: "Quant neutral" }),
    makeReport("technical", { stance: "bullish", confidence: 0.21, summary: "Technical bullish" }),
    makeReport("fundamental", { stance: "neutral", confidence: 0.1, summary: "Fundamental neutral" }),
    makeReport("macro", { stance: "bearish", confidence: 0.173, summary: "Macro bearish" }),
    makeReport("crypto", { stance: "bullish", confidence: 0.25, summary: "Crypto bullish" }),
    makeReport("news", { stance: "neutral", confidence: 0.059, summary: "News neutral" }),
    makeReport("researcher", { stance: "bearish", confidence: 0.6, summary: "Research bearish" }),
  ];
  const result = deliberate(reports, null);
  assert.equal(result.disputes.length, 1);
  assert.deepEqual(new Set(result.disputes[0].between), new Set(["technical", "macro", "crypto", "researcher"]));
  assert.match(result.disputes[0].explanation, /regardless of confidence/);
  assert.equal(result.direction, "none");
  assert.ok(result.dissent.length >= 3);
});
