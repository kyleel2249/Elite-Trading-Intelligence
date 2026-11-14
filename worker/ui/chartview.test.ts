import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { CHARTVIEW_BARS, CHARTVIEW_JS, withChartView } from "./chartview.ts";
import worker from "../index.ts";

const script = CHARTVIEW_JS.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");

test("the dashboard page loads more candles and carries the scroll/zoom layer", async () => {
  const res = await worker.fetch(new Request("https://x.test/"), {} as any, {} as any);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, new RegExp(`const BARS=${CHARTVIEW_BARS}`));
  assert.doesNotMatch(body, /const BARS=120/);
  assert.ok(body.includes('id="eti-chartview"') && body.includes('id="eti-chartview-js"'));
});

test("the chart view stores nothing in the browser (dashboard policy: no browser storage)", () => {
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
});

test("a page without the expected markup is returned unchanged", () => {
  assert.equal(withChartView("<html><head></head><body>nothing</body></html>"), "<html><head></head><body>nothing</body></html>");
});

test("the injected script is valid JavaScript", () => { assert.doesNotThrow(() => new vm.Script(script)); });

function harness(n: number, clientWidth: number) {
  const styles: Record<string, string> = {};
  const listeners: Record<string, Function> = {};
  const buttons: Record<string, any> = {};
  const stack: any = {
    clientWidth, scrollLeft: 0, scrollWidth: clientWidth,
    style: { setProperty: (k: string, v: string) => { styles[k] = v; stack.scrollWidth = Math.max(stack.clientWidth, parseInt(v)); } },
    setAttribute() {}, addEventListener: (e: string, f: Function) => { listeners[e] = f; },
    parentNode: { insertBefore() {} },
  };
  const bar: any = { className: "", set innerHTML(_v: string) {}, querySelector: (sel: string) => (buttons[sel] ??= { disabled: false, textContent: "" }) };
  let draws = 0;
  const ctx: any = {
    document: { getElementById: (id: string) => (id === "stack" ? stack : null), createElement: () => bar },
    window: { console }, console,
    candles: Array.from({ length: n }, (_, i) => [i, 1, 2, 0, 1, 1]), PAD_R: 116, FUTURE: 14,
    drawChart() { draws++; },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { ctx, stack, styles, listeners, buttons, draws: () => draws };
}

test("300 candles get a fixed 12 px slot each, far wider than the viewport, and the view starts at the latest candle", () => {
  const h = harness(300, 900);
  const expected = Math.ceil(300 * 12 + 116 + 14 * 12);
  assert.equal(h.styles["--stackw"], expected + "px");
  assert.equal(h.stack.scrollLeft, h.stack.scrollWidth, "pinned to the latest candle");
  assert.ok(expected > 900 * 3);
});

test("a short history still fills the viewport instead of shrinking", () => {
  const h = harness(20, 1000);
  assert.equal(h.styles["--stackw"], "1000px");
});

test("scrolling back keeps the user's place when new candles arrive; Latest returns to the end", () => {
  const h = harness(300, 900);
  h.stack.scrollLeft = 500; h.listeners.scroll();            // user scrolls back in history
  h.ctx.candles.push([300, 1, 2, 0, 1, 1]); h.ctx.drawChart();
  assert.equal(h.stack.scrollLeft, 500, "not yanked to the end");
  h.buttons["#cvLatest"].onclick();
  assert.equal(h.stack.scrollLeft, h.stack.scrollWidth);
});

test("symbol change (candles cleared) re-pins to the newest data; zoom changes the slot width within limits", () => {
  const h = harness(300, 900);
  h.stack.scrollLeft = 100; h.listeners.scroll();
  h.ctx.candles.length = 0; h.ctx.drawChart();
  h.ctx.candles.push(...Array.from({ length: 300 }, (_, i) => [i, 1, 2, 0, 1, 1])); h.ctx.drawChart();
  assert.equal(h.stack.scrollLeft, h.stack.scrollWidth);
  const before = parseInt(h.styles["--stackw"]);
  h.buttons["#cvIn"].onclick(); assert.ok(parseInt(h.styles["--stackw"]) > before);
  for (let i = 0; i < 40; i++) h.buttons["#cvOut"].onclick();
  assert.equal(h.buttons["#cvVal"].textContent, "6 px"); assert.equal(h.buttons["#cvOut"].disabled, true);
});
