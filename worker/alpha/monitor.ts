/** Champion/challenger tracking, model versioning and automatic rollback for the strategy set. */
import { ENVELOPE, LAB_STRATEGIES, type poolSummaries } from "./lab.ts";
import type { StrategyPerf } from "./positions.ts";

export function modelVersion(): string {
  const text = JSON.stringify({ e: ENVELOPE, s: LAB_STRATEGIES.map(s => [s.id, s.kind, s.testable]) }); let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "lab-v1:" + h.toString(16).padStart(8, "0");
}
export interface Champion { version: string; champion: { id: string; name: string; oosAvgR: number; oosT: number | null; oosTrades: number } | null; challengers: { id: string; name: string; oosAvgR: number | null; status: string }[]; rolledBack: { id: string; reason: string }[]; note: string }
export function championChallenger(pool: ReturnType<typeof poolSummaries>, paper: Record<string, StrategyPerf>): Champion {
  const rolledBack: Champion["rolledBack"] = [];
  const eligible = pool.rows.filter(r => r.status === "promoted").filter(r => { const p = paper[r.id]; if (p && p.n >= 20 && p.sumR / p.n <= 0) { rolledBack.push({ id: r.id, reason: "paper-trading expectancy " + (p.sumR / p.n).toFixed(2) + "R over " + p.n + " trades is not positive; demoted automatically" }); return false; } return true; });
  const best = [...eligible].sort((a, b) => (b.oosAvgR ?? -9) - (a.oosAvgR ?? -9))[0] ?? null;
  return { version: modelVersion(), champion: best ? { id: best.id, name: best.name, oosAvgR: best.oosAvgR!, oosT: best.oosT, oosTrades: best.oosTrades } : null,
    challengers: pool.rows.filter(r => r.id !== best?.id && r.status !== "insufficient_sample" && r.id !== "control_random").sort((a, b) => (b.oosAvgR ?? -9) - (a.oosAvgR ?? -9)).slice(0, 5).map(r => ({ id: r.id, name: r.name, oosAvgR: r.oosAvgR, status: r.status })), rolledBack,
    note: best ? "champion = promoted strategy with the best pooled out-of-sample expectancy that has not failed paper trading" : "no strategy is promoted yet: pooled out-of-sample evidence is insufficient or not significant after correction" };
}
