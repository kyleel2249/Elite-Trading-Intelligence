import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHART_LAYOUT_CSS } from "./chart-layout.ts";

test("live market chart is twice the viewport-fit height and outranks the #eti-chart-fill block", () => {
  // Desktop: 2 x (viewport - 190px), minimum 2 x 720px; mobile: 2 x (viewport - 160px), minimum 2 x 560px.
  assert.match(CHART_LAYOUT_CSS, /#stack>\.chart\.big#liveChartFrame\{height:calc\(\(100vh - 190px\) \* 2\);height:calc\(\(100dvh - 190px\) \* 2\);min-height:1440px;max-height:none\}/);
  assert.match(CHART_LAYOUT_CSS, /max-width:700px\)\{\.chart-workspace:not\(:fullscreen\) #stack>\.chart\.big#liveChartFrame\{height:calc\(\(100dvh - 160px\) \* 2\);min-height:1120px\}/);
  // Two IDs (#stack, #liveChartFrame) beat the single-ID rule in #eti-chart-fill regardless of source order.
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.ok(src.includes('.chart-workspace #stack>.chart.big{height:calc(100vh - 190px)'), "base viewport-fit rule is still the reference this 2x scales");
  // Real fullscreen keeps fitting the screen instead of being doubled.
  assert.ok(CHART_LAYOUT_CSS.includes(".chart-workspace:not(:fullscreen) #stack"));
});
