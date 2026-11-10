// Optional KV-backed context for the Precision engine: fundamentals, news/events, measured expectancy, calibration models.
// Reads are best-effort and fail soft (a missing or malformed record means "unavailable", never a guess).
// Writes are only reachable through the token-protected admin routes in api.ts.
import { parseCalibrationModel, type CalibrationModel } from "./calibration.ts";
import { parseFundamentalContext, parseNewsContext, type FundamentalContext, type NewsContext } from "./context.ts";
import type { Strategy } from "../algo/timeframes.ts";
import { DAY_MS, cleanText, isFiniteNumber, isRecord } from "./util.ts";

/** Minimal shape of a Cloudflare KV namespace, so this module needs no platform types. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
export interface PrecisionEnv {
  MARKET_PROVIDER_ORDER?: string;
  /** Optional KV namespace for context data. Without it the engine reports fundamentals, news, expectancy and calibration as unavailable. */
  ETI_PRECISION_DATA?: KvLike;
  /** Secret bearer token for the admin routes. Admin routes are disabled (403) when it is not set. */
  ETI_PRECISION_ADMIN_TOKEN?: string;
  /** Optional JSON string overriding scoring weights, bands and gates. A rejected override falls back to defaults and is reported. */
  ETI_PRECISION_CONFIG?: string;
}

export const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;
export const keys = {
  fundamentals: (base: string) => `precision:fundamentals:${base}`,
  news: (base: string) => `precision:news:${base}`,
  marketNews: () => "precision:news:_market",
  expectancy: (s: Strategy) => `precision:expectancy:${s}`,
  calibration: (s: Strategy) => `precision:calibration:${s}`,
};

async function readJson(kv: KvLike | undefined, key: string): Promise<unknown | null> {
  if (!kv) return null;
  try { const t = await kv.get(key); return t ? JSON.parse(t) : null; } catch { return null; }
}

export interface ExpectancyRecord { strategy: Strategy; expectancyR: number; samples: number; asOf: string; source: string }
export function parseExpectancy(raw: unknown, strategy: Strategy): ExpectancyRecord | null {
  if (!isRecord(raw)) return null;
  const asOf = cleanText(raw.asOf, 40), source = cleanText(raw.source, 120);
  if (!asOf || !source || !Number.isFinite(Date.parse(asOf))) return null;
  if (!isFiniteNumber(raw.expectancyR) || raw.expectancyR < -10 || raw.expectancyR > 10) return null;
  if (!isFiniteNumber(raw.samples) || !Number.isInteger(raw.samples) || raw.samples < 0) return null;
  return { strategy, expectancyR: raw.expectancyR, samples: raw.samples, asOf, source };
}

export interface LoadedContext {
  fundamentals: FundamentalContext | null;
  news: NewsContext | null;
  marketNews: NewsContext | null;
  expectancy: { expectancyR: number; samples: number } | null;
  expectancyNote: string | null;
  calibration: CalibrationModel | null;
  storeConfigured: boolean;
}

export async function loadContext(env: PrecisionEnv, base: string | null, strategy: Strategy, now: number, expectancyMaxAgeDays: number): Promise<LoadedContext> {
  const kv = env.ETI_PRECISION_DATA;
  const [f, n, mn, e, c] = await Promise.all([
    base ? readJson(kv, keys.fundamentals(base)) : null, base ? readJson(kv, keys.news(base)) : null, readJson(kv, keys.marketNews()),
    readJson(kv, keys.expectancy(strategy)), readJson(kv, keys.calibration(strategy)),
  ]);
  const rec = parseExpectancy(e, strategy);
  let expectancy: LoadedContext["expectancy"] = null, expectancyNote: string | null = null;
  if (rec) {
    if (now - Date.parse(rec.asOf) > expectancyMaxAgeDays * DAY_MS) expectancyNote = `Measured expectancy from ${rec.source} (as of ${rec.asOf}) is older than ${expectancyMaxAgeDays} days and was not used.`;
    else expectancy = { expectancyR: rec.expectancyR, samples: rec.samples };
  }
  return { fundamentals: parseFundamentalContext(f), news: parseNewsContext(n), marketNews: parseNewsContext(mn), expectancy, expectancyNote, calibration: parseCalibrationModel(c), storeConfigured: !!kv };
}

/** Constant-time string comparison for bearer tokens. */
export function tokenMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < 16 || provided === null) return false;
  const a = new TextEncoder().encode(provided), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
