import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./portfolio/testing.ts";
import { acquireLock, cycleLockKey } from "./execution-lock.ts";
import { runGuardedPaperCycle } from "./paper-guard.ts";

async function migratedDb() {
  const db = sqliteD1();
  const sql = readFileSync(new URL("../migrations/0011_execution_locks.sql", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run();
  return db;
}
const recorder = () => {
  const seen: Array<string | undefined> = [];
  const run = async (e: any) => { seen.push(e.ETI_PAPER_AUTOEXECUTE); return { ran: true, at: "t", items: [] }; };
  return { seen, run };
};
const T0 = 1_700_000_000_000;

test("runs inside the lock with the environment unchanged", async () => {
  const db = await migratedDb(), r = recorder(), env: any = { ETI_PORTFOLIO_DB: db, ETI_PAPER_AUTOEXECUTE: "true" };
  const out = await runGuardedPaperCycle(env, { now: () => T0, run: r.run });
  assert.equal(out.guard, "locked");
  assert.equal(out.ran, true);
  assert.deepEqual(r.seen, ["true"]);
});

test("a duplicate delivery in the same minute window is skipped; the next window runs", async () => {
  const db = await migratedDb(), r = recorder(), env: any = { ETI_PORTFOLIO_DB: db, ETI_PAPER_AUTOEXECUTE: "true" };
  await runGuardedPaperCycle(env, { now: () => T0, run: r.run });
  const dup = await runGuardedPaperCycle(env, { now: () => T0 + 5_000, run: r.run });
  assert.equal(dup.guard, "duplicate_window");
  assert.equal(dup.ran, false);
  assert.equal(r.seen.length, 1);
  const next = await runGuardedPaperCycle(env, { now: () => T0 + 120_000, run: r.run });
  assert.equal(next.guard, "locked");
  assert.equal(r.seen.length, 2);
});

test("a cycle held by another run is skipped and may be retried in the same window", async () => {
  const db = await migratedDb(), r = recorder(), env: any = { ETI_PORTFOLIO_DB: db, ETI_PAPER_AUTOEXECUTE: "true" };
  const holder = await acquireLock(db, cycleLockKey("paper", "internal"), 60_000, T0);
  assert.ok(holder);
  const blocked = await runGuardedPaperCycle(env, { now: () => T0 + 1_000, run: r.run });
  assert.equal(blocked.guard, "cycle_locked");
  assert.equal(r.seen.length, 0);
  const { releaseLock } = await import("./execution-lock.ts");
  await releaseLock(db, cycleLockKey("paper", "internal"), holder!);
  const retry = await runGuardedPaperCycle(env, { now: () => T0 + 2_000, run: r.run });
  assert.equal(retry.guard, "locked", "the failed claim was released for a retry");
  assert.equal(r.seen.length, 1);
});

test("lock store unavailable: still manages positions but disables new entries", async () => {
  const db = sqliteD1(); // migration not applied: tables missing
  const r = recorder(), env: any = { ETI_PORTFOLIO_DB: db, ETI_PAPER_AUTOEXECUTE: "true" };
  const out = await runGuardedPaperCycle(env, { now: () => T0, run: r.run });
  assert.equal(out.guard, "lock_store_unavailable_entries_disabled");
  assert.equal(out.ran, true);
  assert.deepEqual(r.seen, ["false"]);
  assert.equal(env.ETI_PAPER_AUTOEXECUTE, "true", "the caller's environment object is not mutated");
});

test("without a D1 binding the cycle behaves as before", async () => {
  const r = recorder(), env: any = { ETI_PAPER_AUTOEXECUTE: "true" };
  const out = await runGuardedPaperCycle(env, { now: () => T0, run: r.run });
  assert.equal(out.guard, "no_lock_store");
  assert.deepEqual(r.seen, ["true"]);
});

test("a failing cycle releases the lock and the claim, then rethrows", async () => {
  const db = await migratedDb(), env: any = { ETI_PORTFOLIO_DB: db };
  await assert.rejects(runGuardedPaperCycle(env, { now: () => T0, run: async () => { throw new Error("boom"); } }), /boom/);
  const r = recorder();
  const again = await runGuardedPaperCycle(env, { now: () => T0 + 1_000, run: r.run });
  assert.equal(again.guard, "locked");
  assert.equal(r.seen.length, 1);
});
