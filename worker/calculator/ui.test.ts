import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { CALC_CSS, CALC_HTML, CALC_JS } from "./ui.ts";
import { CHART_LAYOUT_CSS, CHART_LAYOUT_JS } from "../ui/chart-layout.ts";

test("calculator and chart-layout fragments are safe to embed in the dashboard template", () => {
  for (const [name, frag] of Object.entries({ CALC_CSS, CALC_HTML, CALC_JS, CHART_LAYOUT_CSS, CHART_LAYOUT_JS })) {
    assert.ok(!frag.includes("`") && !frag.includes("${") && !frag.includes("\\"), name + " contains an unsafe character");
  }
});

test("calculator script compiles and wires the entry link and the automatic order button", () => {
  assert.doesNotThrow(() => new vm.Script(CALC_JS));
  for (const id of ["clPlace", "clMode", "clLink", "clPlaceMsg"]) assert.ok(CALC_HTML.includes('id="' + id + '"'), "missing #" + id);
  assert.match(CALC_JS, /submitOrder\('buy'\)/, "must go through the dashboard order flow (confirmation + safeguards)");
  assert.match(CALC_JS, /planStop/, "stop level must be attached as a protective exit");
  assert.match(CALC_JS, /ctPrice/, "chart clicks must set the entry");
  assert.doesNotMatch(CALC_JS, /fetch\('\/api\/orders/, "the calculator must not bypass the order ticket");
});

test("the chart is wide enough for large candles and scrolls horizontally", () => {
  assert.match(CHART_LAYOUT_CSS, /\.cscroll\{overflow-x:auto/);
  assert.match(CHART_LAYOUT_CSS, /\.chart\.big\{height:560px\}/);
  assert.match(CHART_LAYOUT_JS, /\(n\+FUTURE\)\*cfg\.step\+PAD_R/);
  assert.match(CHART_LAYOUT_JS, /Extra large/);
});

test("chart layout sizes the stack from candle count and keeps the view on the latest candle", () => {
  const els: Record<string, any> = {};
  const mk = (id: string): any => {
    const o: any = { id, style: {}, listeners: {} as Record<string, Function[]>, options: [] as any[], value: "16", scrollLeft: 0, scrollWidth: 3000, clientWidth: 800, textContent: "", attrs: {},
      addEventListener(t: string, f: Function) { (o.listeners[t] = o.listeners[t] || []).push(f); },
      setAttribute(k: string, v: string) { o.attrs[k] = v; },
      appendChild(c: any) { c.parentNode = o; return c; }, insertBefore(c: any) { c.parentNode = o; return c; } };
    Object.defineProperty(o, "innerHTML", { set(h: string) { if (h.includes("barW")) { for (const i of ["barW", "barFit", "barEnd", "barNote"]) els[i] = mk(i); els.barW.options = [10, 16, 22, 28].map((v) => ({ value: String(v) })); } } });
    return o;
  };
  els.stack = mk("stack"); els.stack.parentNode = mk("parent");
  const document = { createElement() { const o = mk("new"); Object.defineProperty(o, "id", { set(v) { els[v] = o; }, get() { return "x"; } }); return o; } };
  let drawn = 0;
  const ctx: any = { $: (id: string) => els[id] || null, document, localStorage: { getItem: () => null, setItem: () => {} }, Array, Number, Math, String,
    candles: new Array(100).fill(0), FUTURE: 14, PAD_R: 116, drawChart: () => { drawn++; }, resetAndLoad: () => {} };
  vm.createContext(ctx);
  vm.runInContext(CHART_LAYOUT_JS, ctx);
  ctx.drawChart();
  assert.equal(els.stack.style.width, (100 + 14) * 16 + 116 + "px");
  assert.equal(els.cscroll.scrollLeft, els.cscroll.scrollWidth, "follows the newest candle");
  els.barW.value = "28"; els.barW.listeners.change[0]();
  assert.equal(els.stack.style.width, (100 + 14) * 28 + 116 + "px");
  els.cscroll.scrollLeft = 50; els.cscroll.listeners.scroll[0](); ctx.drawChart();
  assert.equal(els.cscroll.scrollLeft, 50, "does not yank the view back once the user scrolled into history");
  assert.ok(drawn >= 3);
});
