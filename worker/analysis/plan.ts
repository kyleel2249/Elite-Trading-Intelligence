// Cloudflare plan awareness. A Worker cannot measure its own CPU time (timers only advance on I/O), so limits are STATIC caps chosen to keep
// typical requests inside the plan's CPU budget: Free = 10 ms CPU and 50 subrequests per request; Paid = 30 s CPU (default) and 1000 subrequests.
// ETI_ANALYSIS_PLAN defaults to "free" (the safe choice). Set it to "paid" to unlock full-detail analysis and calibration.
export type Plan = "free" | "paid";
export interface PlanLimits {
  plan: Plan; defaultDetail: "lite" | "full"; allowFullDetail: boolean;
  /** Most recent candles analysed per timeframe. */ maxCandles: number;
  calibrateAllowed: boolean; calibrateMaxSamples: number;
  maxNewsItems: number; form4Max: number; aiMaxItems: number; subrequestBudget: number;
}
export const FREE_LIMITS: PlanLimits = { plan: "free", defaultDetail: "lite", allowFullDetail: false, maxCandles: 160, calibrateAllowed: false, calibrateMaxSamples: 0, maxNewsItems: 60, form4Max: 5, aiMaxItems: 8, subrequestBudget: 50 };
export const PAID_LIMITS: PlanLimits = { plan: "paid", defaultDetail: "full", allowFullDetail: true, maxCandles: 250, calibrateAllowed: true, calibrateMaxSamples: 300, maxNewsItems: 500, form4Max: 8, aiMaxItems: 12, subrequestBudget: 1000 };
export interface PlanEnv { ETI_ANALYSIS_PLAN?: string; ETI_ANALYSIS_ALLOW_FULL?: string }
export function planOf(env: PlanEnv): PlanLimits {
  const paid = String(env.ETI_ANALYSIS_PLAN ?? "free").toLowerCase() === "paid";
  const base = paid ? PAID_LIMITS : FREE_LIMITS;
  return !paid && String(env.ETI_ANALYSIS_ALLOW_FULL ?? "").toLowerCase() === "true" ? { ...base, allowFullDetail: true } : base;
}
/** Resolves the requested detail against the plan. The caller learns when a request was downgraded. */
export function resolveDetail(requested: string | null | undefined, limits: PlanLimits): { detail: "lite" | "full"; downgraded: boolean } {
  const want = requested === "full" ? "full" : requested === "lite" ? "lite" : limits.defaultDetail;
  if (want === "full" && !limits.allowFullDetail) return { detail: "lite", downgraded: true };
  return { detail: want, downgraded: false };
}
