/**
 * Central, version-controlled ETI operational defaults.
 *
 * These are application settings, not Cloudflare bindings. ETI runs with these
 * defaults on Workers Free; no per-setting Runtime Variables are required.
 * An optional single ETI_OPERATIONAL_CONFIG JSON binding may override them.
 */
export interface OperationalConfig {
  monitoring: {
    mtmIntervalSeconds: number;
    reconcileIntervalSeconds: number;
    investorMonitorIntervalSeconds: number;
  };
  dataQuality: {
    maxAgeSeconds: number;
    requireFreshDataForLiveOrders: boolean;
  };
  timezone: string;
}

export const DEFAULT_OPERATIONAL_CONFIG: Readonly<OperationalConfig> = Object.freeze({
  monitoring: Object.freeze({
    mtmIntervalSeconds: 60,
    reconcileIntervalSeconds: 120,
    investorMonitorIntervalSeconds: 1800,
  }),
  dataQuality: Object.freeze({
    maxAgeSeconds: 300,
    requireFreshDataForLiveOrders: true,
  }),
  timezone: "Africa/Accra",
});

type ConfigEnv = { ETI_OPERATIONAL_CONFIG?: string };
const positiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
const minuteInterval = (value: unknown, fallback: number): number => {
  const n = positiveInt(value, fallback);
  return n >= 60 && n % 60 === 0 ? n : fallback;
};
const validTimezone = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return value; }
  catch { return fallback; }
};

/** Read safe defaults and accept only individually valid optional overrides. */
export function readOperationalConfig(env: ConfigEnv = {}): OperationalConfig {
  let raw: any = {};
  if (env.ETI_OPERATIONAL_CONFIG) {
    try { raw = JSON.parse(env.ETI_OPERATIONAL_CONFIG); } catch { raw = {}; }
  }
  const d = DEFAULT_OPERATIONAL_CONFIG;
  return {
    monitoring: {
      mtmIntervalSeconds: minuteInterval(raw?.monitoring?.mtmIntervalSeconds, d.monitoring.mtmIntervalSeconds),
      reconcileIntervalSeconds: minuteInterval(raw?.monitoring?.reconcileIntervalSeconds, d.monitoring.reconcileIntervalSeconds),
      investorMonitorIntervalSeconds: minuteInterval(raw?.monitoring?.investorMonitorIntervalSeconds, d.monitoring.investorMonitorIntervalSeconds),
    },
    dataQuality: {
      maxAgeSeconds: positiveInt(raw?.dataQuality?.maxAgeSeconds, d.dataQuality.maxAgeSeconds),
      requireFreshDataForLiveOrders: typeof raw?.dataQuality?.requireFreshDataForLiveOrders === "boolean"
        ? raw.dataQuality.requireFreshDataForLiveOrders : d.dataQuality.requireFreshDataForLiveOrders,
    },
    timezone: validTimezone(raw?.timezone, d.timezone),
  };
}

/** True only for a finite, non-future timestamp within the configured age. */
export function isMarketDataFresh(timestamp: unknown, now: number, maxAgeSeconds: number): boolean {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    && Number.isFinite(now) && Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0
    && timestamp <= now && now - timestamp <= maxAgeSeconds * 1000;
}

/** Cron dispatcher helper. Intervals must align to the minute-level Worker cron. */
export function isOperationalIntervalDue(now: number, intervalSeconds: number): boolean {
  if (!Number.isFinite(now) || !Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds % 60 !== 0) return false;
  const minutes = intervalSeconds / 60;
  return Math.floor(now / 60_000) % minutes === 0;
}

export function formatOperationalTime(timestamp: number, timezone = DEFAULT_OPERATIONAL_CONFIG.timezone): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: validTimezone(timezone, DEFAULT_OPERATIONAL_CONFIG.timezone),
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(timestamp));
}
