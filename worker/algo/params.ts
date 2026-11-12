// Active-parameter management for the analytical pipeline. The champion configuration comes from the versioned registry in KV.
// Promotion needs a named human approver and an optimizer recommendation; rollback only returns to a previously approved version.
// Candidates are resolved server-side from the whitelist (CANDIDATE_SET), so a client cannot smuggle in arbitrary weights or looser gates.
import { CANDIDATE_SET, KVParamStore, ParamRegistry, type OptimizerResult, type ParamVersion } from "./optimizer.ts";
import { loadCalibration } from "./calibration.ts";
import type { OmnisignalOptions } from "./omnisignal.ts";

export const PARAMS_KEY = "algo:params:v1";
type KV = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
export type ActiveOptions = Pick<OmnisignalOptions, "weights" | "thresholds" | "maxCostR" | "calibrationTable"> & { version: number; name: string };
export const toOptions = (v: Pick<ParamVersion, "id" | "name" | "weights" | "tighten">): ActiveOptions => ({ version: v.id, name: v.name, weights: v.weights,
  thresholds: { ...(v.tighten?.minRiskReward !== undefined ? { minRiskReward: v.tighten.minRiskReward } : {}), ...(v.tighten?.confirmed !== undefined ? { confirmed: v.tighten.confirmed } : {}) }, maxCostR: v.tighten?.maxCostR });

/** Champion options. A missing registry means the built-in defaults. A failing KV read throws, so callers fail closed instead of silently using different gates. */
export async function activeOptions(kv: KV | undefined, now: () => number = Date.now): Promise<ActiveOptions> {
  if (!kv) return { version: 1, name: "default" };
  const reg = await ParamRegistry.open(new KVParamStore(kv, PARAMS_KEY), now);
  // A calibration table that cannot be read only means the score stays uncalibrated; it never changes a trading gate.
  const calibrationTable = await loadCalibration(kv).catch(() => null);
  return { ...toOptions(reg.champion()), calibrationTable };
}

export interface ParamsResult { status: number; body: Record<string, unknown> }
export async function paramsOp(op: "get" | "propose" | "promote" | "rollback", kv: KV, body: any, now: number): Promise<ParamsResult> {
  const reg = await ParamRegistry.open(new KVParamStore(kv, PARAMS_KEY), () => now);
  const view = () => ({ champion: reg.champion(), versions: reg.st.versions, audit: reg.st.audit.slice(-50), note: "Promotion requires a named human approver and an optimizer recommendation. Nothing here can loosen a default gate or change risk limits, permissions or live trading." });
  try {
    if (op === "get") return { status: 200, body: view() };
    if (op === "propose") {
      const name = String(body?.name ?? ""), cand = CANDIDATE_SET[name], res = body?.result as OptimizerResult | undefined;
      if (!cand || name === "default") return { status: 400, body: { error: "unknown_candidate", allowed: Object.keys(CANDIDATE_SET).filter(k => k !== "default") } };
      if (!res || res.challenger?.name !== name) return { status: 400, body: { error: "invalid_request", message: "'result' must be the optimizer output whose challenger matches 'name'" } };
      const v = await reg.propose(name, cand.weights, res, cand.tighten); return { status: 200, body: { proposed: v, ...view() } };
    }
    if (op === "promote") {
      const id = Number(body?.id), approver = typeof body?.approver === "string" ? body.approver : "";
      if (!Number.isInteger(id)) return { status: 400, body: { error: "invalid_request", message: "'id' must be an integer" } };
      const v = await reg.promote(id, approver); return { status: 200, body: { promoted: v, ...view() } };
    }
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "manual rollback";
    const v = await reg.rollback(`manual: ${reason}`); return { status: 200, body: { restored: v, ...view() } };
  } catch (e) { return { status: 409, body: { error: "rejected", message: e instanceof Error ? e.message : "rejected" } }; }
}
