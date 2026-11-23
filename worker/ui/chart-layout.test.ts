import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHART_LAYOUT_CSS } from "./chart-layout.ts";

test("dashboard live market chart uses the shared JPTI 2D dimensions", () => {
  assert.match(CHART_LAYOUT_CSS, /\.chart\.big\{height:440px;min-height:440px;max-height:none\}/);
  assert.match(CHART_LAYOUT_CSS, /max-width:700px\)\{\.chart\.big\{height:340px;min-height:340px;max-height:none\}/);
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.ok(src.includes(".chart-workspace #stack>.chart.big{height:440px;min-height:440px;max-height:none"), "dashboard chart matches the 440px desktop height");
  assert.ok(src.includes(".chart-workspace #stack>.chart.big{height:340px;min-height:340px;max-height:none}") || src.includes("@media(max-width:700px){.chart-workspace #stack>.chart.big{height:340px;min-height:340px;max-height:none}}"), "mobile dashboard chart matches the 340px height");
  assert.ok(src.includes(".panel.chart-workspace{background:#000000;border-color:#1d2a3e;padding:0;overflow:hidden;min-height:560px"), "chart parent uses the 560px desktop height");
  assert.match(CHART_LAYOUT_CSS, /\.chart-workspace:not\(:fullscreen\) #stack/);
});
