import test from "node:test";import assert from "node:assert/strict";import {estimateExecution} from "./execution-estimator.ts";
test("calculates execution cost and fill estimate",()=>{const r=estimateExecution({price:100,sizeUsd:1000,spreadBps:10,depthUsd:100000,feeBps:8});assert.ok(r.estimatedCostUsd>0);assert.ok(r.estimatedAverageFillPrice>100);assert.equal(r.executionQuality,"good");});
test("missing depth warns and estimates",()=>{const r=estimateExecution({price:1,sizeUsd:100,side:"sell"});assert.ok(r.warnings.includes("depth_missing_slippage_underestimates_impact"));assert.ok(r.estimatedAverageFillPrice<1);});
test("validates required fields",()=>assert.throws(()=>estimateExecution({price:0,sizeUsd:5}),/positive_price/));
