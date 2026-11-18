import test from "node:test";
import assert from "node:assert/strict";
import { TRADING_TERMINAL_CSS, TRADING_TERMINAL_HTML, TRADING_TERMINAL_JS } from "./trading-terminal.ts";

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
