import test from "node:test";
import assert from "node:assert/strict";
import { validateLiveOrderLimits } from "./execution.ts";

const env = { ETI_LIVE_MAX_NOTIONAL_USD: "500", ETI_LIVE_MAX_ORDER_QUANTITY: "2" };

test("live order guard approves a limit order within both server-side caps", () => {
  const result = validateLiveOrderLimits({ type: "limit", quantity: 1.5, limitPrice: 200, env });
  assert.deepEqual(result, { ok: true, notionalUsd: 300 });
});

test("live order guard rejects market orders", () => {
  const result = validateLiveOrderLimits({ type: "market", quantity: 1, limitPrice: 100, env });
  assert.deepEqual(result, { ok: false, reason: "live_limit_orders_only" });
});

test("live order guard fails closed when notional cap is missing", () => {
  const result = validateLiveOrderLimits({
    type: "limit", quantity: 1, limitPrice: 100, env: { ETI_LIVE_MAX_ORDER_QUANTITY: "2" },
  });
  assert.deepEqual(result, { ok: false, reason: "live_notional_cap_not_configured" });
});

test("live order guard fails closed when quantity cap is missing", () => {
  const result = validateLiveOrderLimits({
    type: "limit", quantity: 1, limitPrice: 100, env: { ETI_LIVE_MAX_NOTIONAL_USD: "500" },
  });
  assert.deepEqual(result, { ok: false, reason: "live_quantity_cap_not_configured" });
});

test("live order guard rejects quantity and notional cap violations", () => {
  assert.deepEqual(
    validateLiveOrderLimits({ type: "limit", quantity: 3, limitPrice: 10, env }),
    { ok: false, reason: "live_quantity_limit_exceeded" },
  );
  assert.deepEqual(
    validateLiveOrderLimits({ type: "limit", quantity: 2, limitPrice: 300, env }),
    { ok: false, reason: "live_notional_limit_exceeded" },
  );
});

test("live order guard rejects invalid prices and quantities", () => {
  assert.deepEqual(
    validateLiveOrderLimits({ type: "limit", quantity: 1, limitPrice: NaN, env }),
    { ok: false, reason: "live_limit_price_required" },
  );
});
