import test from "node:test";
import assert from "node:assert/strict";
import { TRADING_TERMINAL_CSS, TRADING_TERMINAL_HTML, TRADING_TERMINAL_JS } from "./trading-terminal.ts";
import worker from "../index.ts";

test("terminal is served as a self-contained responsive workspace", () => {
  assert.match(TRADING_TERMINAL_HTML, /Professional Trading Terminal/);
  assert.match(TRADING_TERMINAL_HTML, /\/bitget-client\.js/);
  assert.match(TRADING_TERMINAL_CSS, /@media\(max-width:650px\)/);
  assert.match(TRADING_TERMINAL_JS, /ETIBitget\.marketData/);
});

test("terminal keeps order placement inside the existing guarded execution flow", () => {
  assert.match(TRADING_TERMINAL_HTML, /Planning only/);
  assert.match(TRADING_TERMINAL_HTML, /risk controls/);
  assert.doesNotMatch(TRADING_TERMINAL_JS, /fetch\(["']\/api\/orders/);
});

test("terminal exposes Bybit venue-specific market data requests", () => {
  assert.match(TRADING_TERMINAL_JS, /venue:"bybit"/);
  assert.match(TRADING_TERMINAL_JS, /\/api\/market\/klines/);
  assert.match(TRADING_TERMINAL_JS, /\/api\/market\/depth/);
});

test("Cloudflare Worker serves the terminal and its assets without a backend", async () => {
  const page = await worker.fetch(new Request("https://eti.test/terminal"), {} as any);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(await page.text(), /ETIAlgo signal intelligence/);
  const script = await worker.fetch(new Request("https://eti.test/terminal.js"), {} as any);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);
  assert.match(await script.text(), /loadSignal/);
  const home = await worker.fetch(new Request("https://eti.test/"), {} as any);
  assert.match(await home.text(), /href="\/terminal"/);
});
