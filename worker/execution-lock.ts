/**
 * Atomic execution locks and idempotency claims on D1 (Step 3 of the autonomous-trading build).
 *
 * Cloudflare cron may deliver a tick twice, may overlap ticks of different cron expressions, and does not promise
 * exactly-once. KV is only eventually consistent, so locks live in D1 where a single INSERT ... ON CONFLICT statement
 * decides the winner atomically. Not wired into the cron handlers yet; later steps wrap each cycle with withExecutionLock.
 *
 * Fail closed: if the lock store cannot be reached, the cycle does not run.
 */

export interface LockStmt {
  bind(...values: unknown[]): LockStmt;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
}
export interface LockDB { prepare(sql: string): LockStmt }

const changed = (r: { meta?: { changes?: number } }): boolean => Number(r?.meta?.changes ?? 0) > 0;
const validKey = (k: string): boolean => typeof k === "string" && /^[A-Za-z0-9:_.\-|]{1,200}$/.test(k);

// ------------------------------------------------------------------ locks

/** Try to take the lock. Succeeds when no row exists or the existing row has expired. Returns the owner token or null. */
export async function acquireLock(db: LockDB, key: string, ttlMs: number, now = Date.now(), owner: string = crypto.randomUUID()): Promise<string | null> {
  if (!validKey(key) || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now)) return null;
  const r = await db.prepare(
    "INSERT INTO eti_execution_locks (lock_key, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(lock_key) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at " +
    "WHERE eti_execution_locks.expires_at <= excluded.acquired_at",
  ).bind(key, owner, now, now + ttlMs).run();
  return changed(r) ? owner : null;
}

/** Extend a lock still held by this owner. Returns false when it was lost (expired and taken over, or released). */
export async function renewLock(db: LockDB, key: string, owner: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  if (!validKey(key) || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const r = await db.prepare("UPDATE eti_execution_locks SET expires_at = ? WHERE lock_key = ? AND owner = ? AND expires_at > ?").bind(now + ttlMs, key, owner, now).run();
  return changed(r);
}

/** Release only if this owner still holds it, so a slow cycle can never free a lock another cycle took over. */
export async function releaseLock(db: LockDB, key: string, owner: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM eti_execution_locks WHERE lock_key = ? AND owner = ?").bind(key, owner).run();
  return changed(r);
}

export type LockedRun<T> = { ran: true; value: T } | { ran: false; reason: "locked" | "lock_unavailable" };

/** Run fn only while holding the lock; always release afterwards (an expiry covers a failed release). */
export async function withExecutionLock<T>(db: LockDB, key: string, ttlMs: number, fn: (owner: string) => Promise<T>, now: () => number = Date.now): Promise<LockedRun<T>> {
  let owner: string | null;
  try { owner = await acquireLock(db, key, ttlMs, now()); } catch { return { ran: false, reason: "lock_unavailable" }; }
  if (owner === null) {
    // null covers both "held by someone else" and invalid arguments; distinguish so callers can alert on the latter
    return { ran: false, reason: validKey(key) && Number.isFinite(ttlMs) && ttlMs > 0 ? "locked" : "lock_unavailable" };
  }
  try {
    return { ran: true, value: await fn(owner) };
  } finally {
    try { await releaseLock(db, key, owner); } catch { /* expiry will free it */ }
  }
}

// ------------------------------------------------------------------ idempotency

export type IdemState = "pending" | "done" | "failed" | "indeterminate";
export type Claim = { claimed: true } | { claimed: false; state: IdemState; result: unknown };

const parseJson = (raw: unknown): unknown => { if (typeof raw !== "string") return null; try { return JSON.parse(raw); } catch { return null; } };

/**
 * Claim an operation key. The first caller wins. A key left in state failed (definitively never sent) may be claimed
 * again; pending, done and indeterminate keys are never handed out twice.
 */
export async function claimIdempotency(db: LockDB, key: string, scope: string, now = Date.now()): Promise<Claim> {
  if (!validKey(key) || !validKey(scope)) throw new Error("invalid idempotency key or scope");
  const r = await db.prepare(
    "INSERT INTO eti_idempotency (idem_key, scope, state, result, created_at, updated_at) VALUES (?, ?, 'pending', NULL, ?, ?) " +
    "ON CONFLICT(idem_key) DO UPDATE SET state = 'pending', result = NULL, updated_at = excluded.updated_at WHERE eti_idempotency.state = 'failed'",
  ).bind(key, scope, now, now).run();
  if (changed(r)) return { claimed: true };
  const row = await db.prepare("SELECT state, result FROM eti_idempotency WHERE idem_key = ?").bind(key).first<{ state: IdemState; result: string | null }>();
  return { claimed: false, state: row?.state ?? "pending", result: parseJson(row?.result) };
}

/** Record the outcome of a claimed operation. Only a pending row can be settled. */
export async function settleIdempotency(db: LockDB, key: string, state: Exclude<IdemState, "pending">, result: unknown = null, now = Date.now()): Promise<boolean> {
  const r = await db.prepare("UPDATE eti_idempotency SET state = ?, result = ?, updated_at = ? WHERE idem_key = ? AND state = 'pending'").bind(state, JSON.stringify(result ?? null), now, key).run();
  return changed(r);
}

// ------------------------------------------------------------------ key builders

const clean = (s: string): string => String(s).replace(/[^A-Za-z0-9_.\-]/g, "_").slice(0, 60);

/** One lock per account and environment, so two cycles never run against the same account at once. */
export const cycleLockKey = (environment: string, accountId: string): string => `cycle:${clean(environment)}:${clean(accountId)}`;

/** One key per account per scheduling window: a duplicate cron delivery in the same window maps to the same key. */
export const cycleIdempotencyKey = (environment: string, accountId: string, now: number, windowMs: number): string => {
  if (!(windowMs > 0)) throw new Error("windowMs must be positive");
  return `cyclerun:${clean(environment)}:${clean(accountId)}:${Math.floor(now / windowMs)}`;
};

/** One key per signal per account: the same signal can never produce a second order. */
export const orderIdempotencyKey = (environment: string, accountId: string, instrument: string, signalId: string): string =>
  `order:${clean(environment)}:${clean(accountId)}:${clean(instrument)}:${clean(signalId)}`;
