import test from "node:test";
import assert from "node:assert/strict";
import { assessCalibration, calibratedConfidence, findBlock, fitCalibration, parseCalibrationModel, tradesToSamples, type CalibrationModel } from "./calibration.ts";
import { DEFAULT_CONFIG, ENGINE_VERSION, scoreConfigHash } from "./config.ts";
import { DAY_MS } from "./util.ts";
import { informativeSamples, noiseSamples, NOW } from "./testkit.ts";

const HASH = scoreConfigHash(DEFAULT_CONFIG);
const ctx = { strategy: "intraday", hash: HASH, now: NOW, cfg: DEFAULT_CONFIG.calibration };
const fit = (samples = informativeSamples(3000), over: Partial<{ strategy: string; scoreConfigHash: string }> = {}) =>
  fitCalibration(samples, { strategy: "intraday", scoreConfigHash: HASH, now: NOW, minBlockSamples: DEFAULT_CONFIG.calibration.minBlockSamples, ...over });

test("a model fitted on informative outcomes is monotone, validated out-of-sample and usable", () => {
  const { model } = fit();
  assert.ok(model);
  assert.equal(model.outOfSample, true);
  assert.equal(model.samples, 3000);
  assert.equal(model.trainSamples + model.testSamples, 3000);
  assert.ok(model.testSamples >= 800, "a real held-out tail exists");
  for (let i = 1; i < model.blocks.length; i++) {
    assert.ok(model.blocks[i].lo > model.blocks[i - 1].hi, "blocks are disjoint and ordered");
    assert.ok(model.blocks[i].p >= model.blocks[i - 1].p, "a higher score never maps to a lower probability");
  }
  assert.ok(model.blocks.every(b => b.n >= 30), "no block rests on a handful of trades");
  assert.ok(model.metrics.skill > DEFAULT_CONFIG.calibration.minSkill, `skill ${model.metrics.skill}`);
  assert.ok(model.metrics.ece <= DEFAULT_CONFIG.calibration.maxEce, `ece ${model.metrics.ece}`);
  assert.deepEqual(assessCalibration(model, ctx), { valid: true, reasons: [] });
});

test("the fitted probabilities track the true generating probabilities", () => {
  const { model } = fit(informativeSamples(6000, 11));
  // True p(score) = 0.25 + 0.55 * (score - 40) / 60
  for (const score of [45, 60, 75, 95]) {
    const truth = 0.25 + 0.55 * ((score - 40) / 60);
    const p = findBlock(model!.blocks, score).p;
    assert.ok(Math.abs(p - truth) < 0.1, `score ${score}: fitted ${p.toFixed(3)} vs true ${truth.toFixed(3)}`);
  }
});

test("scores that carry no information are rejected: no probability is claimed", () => {
  const { model } = fit(noiseSamples(3000));
  assert.ok(model, "the model can be fitted and inspected...");
  const a = assessCalibration(model, ctx);
  assert.equal(a.valid, false, "...but it adds nothing over the base rate");
  assert.ok(a.reasons.some(r => /Brier skill/.test(r)), a.reasons.join("; "));
  assert.equal(calibratedConfidence(model, 80, ctx).confidence, null);
});

test("too few samples cannot produce a model, and a small model is not usable", () => {
  const tiny = fit(informativeSamples(40));
  assert.equal(tiny.model, null);
  assert.ok(tiny.reasons.some(r => /not enough samples/.test(r)));
  // 250 samples -> 175 train / 75 held out: below both the 300-sample and 90-held-out minimums.
  const small = fit(informativeSamples(250, 3)).model!;
  const a = assessCalibration(small, ctx);
  assert.equal(a.valid, false);
  assert.ok(a.reasons.some(r => /only 250 samples/.test(r)), a.reasons.join("; "));
  assert.ok(a.reasons.some(r => /only 75 held-out samples/.test(r)), a.reasons.join("; "));
  // At the configured minimum the same procedure is accepted, so the gate is the configured limit and nothing else.
  assert.equal(assessCalibration(fit(informativeSamples(400, 3)).model!, ctx).valid, true);
});

test("a model is bound to the scoring configuration, strategy, engine version and age", () => {
  const { model } = fit();
  const m = model as CalibrationModel;
  assert.ok(assessCalibration(m, { ...ctx, hash: "different-hash" }).reasons.some(r => /configuration changed/.test(r)));
  assert.ok(assessCalibration(m, { ...ctx, strategy: "swing" }).reasons.some(r => /strategy/.test(r)));
  assert.ok(assessCalibration({ ...m, engineVersion: "0.0.1" }, ctx).reasons.some(r => /engine/.test(r)));
  assert.ok(assessCalibration(m, { ...ctx, now: NOW + (DEFAULT_CONFIG.calibration.maxAgeDays + 1) * DAY_MS }).reasons.some(r => /older/.test(r)));
  assert.ok(assessCalibration({ ...m, trainedAt: new Date(NOW + 5 * DAY_MS).toISOString() }, ctx).reasons.some(r => /invalid date/.test(r)), "future-dated models are rejected");
  assert.ok(assessCalibration(null, ctx).reasons[0].includes("no calibration model"));
  assert.equal(m.engineVersion, ENGINE_VERSION);
});

test("a calibrated confidence reports the probability with an interval and its evidence", () => {
  const { model } = fit();
  const { confidence, reasons } = calibratedConfidence(model, 85, ctx);
  assert.deepEqual(reasons, []);
  assert.equal(confidence!.type, "calibrated_probability");
  if (confidence!.type !== "calibrated_probability") return;
  assert.ok(confidence.probability > 0 && confidence.probability < 1);
  assert.ok(confidence.interval95.low <= confidence.interval95.high);
  assert.ok(confidence.interval95.high - confidence.interval95.low > 0, "uncertainty is shown, not hidden");
  assert.ok(confidence.basis.samplesInScoreBlock >= 30);
  assert.ok(confidence.basis.testSamples >= 800);
  assert.match(confidence.outcomeDefinition, /positive realised result/);
  assert.match(confidence.note, /not a guarantee/);
  const low = calibratedConfidence(model, 45, ctx).confidence!, high = calibratedConfidence(model, 98, ctx).confidence!;
  if (low.type === "calibrated_probability" && high.type === "calibrated_probability") assert.ok(high.probability > low.probability);
});

test("findBlock handles scores outside the fitted range and in gaps without inventing values", () => {
  const blocks = [{ lo: 40, hi: 50, n: 50, wins: 20, p: 0.4 }, { lo: 60, hi: 70, n: 50, wins: 30, p: 0.6 }];
  assert.equal(findBlock(blocks, 10).p, 0.4);
  assert.equal(findBlock(blocks, 99).p, 0.6);
  assert.equal(findBlock(blocks, 55).p, 0.4, "an exact tie in a gap takes the lower, more conservative block");
  assert.equal(findBlock(blocks, 58).p, 0.6);
});

test("stored models are parsed strictly and tampering is rejected", () => {
  const m = fit().model as CalibrationModel;
  assert.deepEqual(parseCalibrationModel(JSON.parse(JSON.stringify(m)))?.blocks, m.blocks);
  const clone = () => JSON.parse(JSON.stringify(m));
  const t1 = clone(); t1.outOfSample = false;
  const t2 = clone(); t2.blocks[1].p = 0.0001; // breaks monotonicity
  const t3 = clone(); t3.blocks[0].p = 1.2;
  const t4 = clone(); t4.blocks[0].wins = t4.blocks[0].n + 5;
  const t5 = clone(); t5.trainedAt = "never";
  const t6 = clone(); t6.metrics.ece = "0";
  const t7 = clone(); t7.blocks = [];
  for (const bad of [t1, t2, t3, t4, t5, t6, t7, null, "x", [], { version: 2 }]) assert.equal(parseCalibrationModel(bad), null);
});

test("recorded trades become calibration samples only when they carry an entry score", () => {
  const base = { id: "t", engine: "elite" as const, symbol: "BTCUSDT", openedAt: 1, closedAt: 5, riskAmount: 10, fees: 0, slippage: 0 };
  const s = tradesToSamples([{ ...base, pnl: 10, confidence: 82 }, { ...base, pnl: -5, confidence: 74 }, { ...base, pnl: 3 }]);
  assert.deepEqual(s, [{ score: 82, win: true, time: 5 }, { score: 74, win: false, time: 5 }]);
});

test("invalid samples are ignored and reported", () => {
  const dirty = [...informativeSamples(900), { score: NaN, win: true }, { score: 120, win: false }, { score: 50, win: "yes" as any }];
  const r = fit(dirty);
  assert.ok(r.model);
  assert.ok(r.reasons.some(x => /3 invalid sample/.test(x)));
  assert.equal(r.model!.samples, 900);
});
