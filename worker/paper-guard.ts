/**
 * Guarded scheduled paper cycle (Step 5a of the autonomous-trading build).
 *
 * Wraps runPaperCycle with the D1 execution lock and idempotency claim from execution-lock.ts so that a duplicate or
 * overlapping cron delivery cannot run the KV-backed paper engine twice at once. The paper engine keeps its state in KV
 * without transactions, so two concurrent cycles could otherwise both open the same position.
 *
 * Outcomes:
 *  - no D1 binding:                legacy behaviour, cycle runs unchanged;
 *  - same window already claimed:  skipped (duplicate delivery);
 *  - lock held by another cycle:   skipped, the claim is released so a later tick can retry;
 *  - lock store unreachable (for example migration 0011 not applied yet): the cycle still runs so open positions keep
 *    being managed, but NEW ENTRIES ARE DISABLED for that run (fail closed on entries, never on protective management).
 */
import { runPaperCycle } from "./algo/paper-api.ts";
import type { CycleSummary, PaperDeps, PaperEnv } from "./algo/paper-api.ts";
import { claimIdempotency, cycleIdempotencyKey, cycleLockKey, settleIdempotency, withExecutionLock } from "./execution-lock.ts";
import type { LockDB } from "./execution-lock.ts";

export const PAPER_CYCLE_WINDOW_MS = 60_000;
export const PAPER_LOCK_TTL_MS = 120_000;
const ACCOUNT = "internal";

export interface GuardDeps extends PaperDeps { run?: (env: PaperEnv, deps?: PaperDeps) => Promise<CycleSummary> }
export type GuardedSummary = CycleSummary & { guard: "no_lock_store" | "duplicate_window" | "cycle_locked" | "locked" | "lock_store_unavailable_entries_disabled" };

export async function runGuardedPaperCycle(env: PaperEnv & { ETI_PORTFOLIO_DB?: unknown }, deps: GuardDeps = {}): Promise<GuardedSummary> {
  const clock = deps.now ?? Date.now, now = clock(), at = new Date(now).toISOString(), run = deps.run ?? runPaperCycle;
  const db = env.ETI_PORTFOLIO_DB as LockDB | undefined;
  if (!db || typeof (db as any).prepare !== "function") return { ...(await run(env, deps)), guard: "no_lock_store" };

  const degraded = async (): Promise<GuardedSummary> => ({ ...(await run({ ...env, ETI_PAPER_AUTOEXECUTE: "false" }, deps)), guard: "lock_store_unavailable_entries_disabled" });
  const key = cycleIdempotencyKey("paper", ACCOUNT, now, PAPER_CYCLE_WINDOW_MS);
  const settle = async (state: "done" | "failed", result: unknown) => { try { await settleIdempotency(db, key, state, result, clock()); } catch { /* a missed settle only affects retry timing */ } };

  try {
    const claim = await claimIdempotency(db, key, "cycle", now);
    if (!claim.claimed) return { ran: false, reason: "A cycle for this minute window was already started", at, items: [], guard: "duplicate_window" };
  } catch { return degraded(); }

  let locked;
  try {
    locked = await withExecutionLock(db, cycleLockKey("paper", ACCOUNT), PAPER_LOCK_TTL_MS, () => run(env, deps), clock);
  } catch (e) { await settle("failed", { error: e instanceof Error ? e.message : "error" }); throw e; }

  if (locked.ran) { await settle("done", { ran: locked.value.ran }); return { ...locked.value, guard: "locked" }; }
  await settle("failed", { reason: locked.reason });
  if (locked.reason === "locked") return { ran: false, reason: "Another paper cycle is still running", at, items: [], guard: "cycle_locked" };
  return degraded();
}
