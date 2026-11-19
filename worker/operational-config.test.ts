import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPERATIONAL_CONFIG, formatOperationalTime, isMarketDataFresh,
  isOperationalIntervalDue, readOperationalConfig,
} from "./operational-config.ts";

test("central operational defaults preserve the requested ETI values", () => {
  assert.deepEqual(readOperationalConfig(), DEFAULT_OPERATIONAL_CONFIG);
  assert.equal(DEFAULT_OPERATIONAL_CONFIG.monitoring.mtmIntervalSeconds, 60);
  assert.equal(DEFAULT_OPERATIONAL_CONFIG.monitoring.reconcileIntervalSeconds, 120);
  assert.equal(DEFAULT_OPERATIONAL_CONFIG.monitoring.investorMonitorIntervalSeconds, 1800);
  assert.equal(DEFAULT_OPERATIONAL_CONFIG.dataQuality.maxAgeSeconds, 300);
  assert.equal(DEFAULT_OPERATIONAL_CONFIG.dataQuality.requireFreshDataForLiveOrders, true);
  assert.equal(DEFAULT_OPERATIONAL_CONFIG.timezone, "Africa/Accra");
});

test("optional JSON overrides are validated field by field", () => {
  const config = readOperationalConfig({ ETI_OPERATIONAL_CONFIG: JSON.stringify({
    monitoring: { mtmIntervalSeconds: 180, reconcileIntervalSeconds: -1, investorMonitorIntervalSeconds: 600 },
    dataQuality: { maxAgeSeconds: 0, requireFreshDataForLiveOrders: false },
    timezone: "Invalid/Timezone",
  }) });
  assert.equal(config.monitoring.mtmIntervalSeconds, 180);
  assert.equal(config.monitoring.reconcileIntervalSeconds, 120);
  assert.equal(config.monitoring.investorMonitorIntervalSeconds, 600);
  assert.equal(config.dataQuality.maxAgeSeconds, 300);
  assert.equal(config.dataQuality.requireFreshDataForLiveOrders, false);
  assert.equal(config.timezone, "Africa/Accra");
  assert.equal(readOperationalConfig({ ETI_OPERATIONAL_CONFIG: JSON.stringify({ monitoring: { mtmIntervalSeconds: 90 } }) }).monitoring.mtmIntervalSeconds, 60);
  assert.equal(readOperationalConfig({ ETI_OPERATIONAL_CONFIG: "{" }).timezone, "Africa/Accra");
});

test("market freshness rejects stale, future, invalid and nonnumeric timestamps", () => {
  const now = 1_000_000;
  assert.equal(isMarketDataFresh(now - 300_000, now, 300), true);
  assert.equal(isMarketDataFresh(now - 300_001, now, 300), false);
  assert.equal(isMarketDataFresh(now + 1, now, 300), false);
  assert.equal(isMarketDataFresh("999000", now, 300), false);
  assert.equal(isMarketDataFresh(NaN, now, 300), false);
});

test("interval dispatcher aligns 60s, 120s and 1800s jobs to minute cron", () => {
  const minute = 1_800_000;
  assert.equal(isOperationalIntervalDue(minute, 60), true);
  assert.equal(isOperationalIntervalDue(minute, 120), true);
  assert.equal(isOperationalIntervalDue(minute, 1800), true);
  assert.equal(isOperationalIntervalDue(minute + 60_000, 120), false);
  assert.equal(isOperationalIntervalDue(minute + 60_000, 60), true);
  assert.equal(isOperationalIntervalDue(minute, 45), false);
});

test("Africa/Accra formatting uses UTC+0 without changing stored timestamps", () => {
  assert.match(formatOperationalTime(Date.UTC(2026, 0, 1, 12, 0, 0)), /12:00:00/);
});
