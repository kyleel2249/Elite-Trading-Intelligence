import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteD1 } from "./portfolio/testing.ts";
import { acquireLock, claimIdempotency, cycleIdempotencyKey, cycleLockKey, orderIdempotencyKey, releaseLock, renewLock, settleIdempotency, withExecutionLock } from "./execution-lock.ts";

async function freshDb() {
  const db = sqliteD1();
  const sql = readFileSync(new URL("../migrations/0011_execution_locks.sql", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
  return db;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a held lock cannot be taken by a second owner", async () => {
  const db = await freshDb();
  const a = await acquireLock(db, "cycle:paper:main", 60_000, 1_000);
  assert.ok(a);
  assert.equal(await acquireLock(db, "cycle:paper:main", 60_000, 2_000), null);
  assert.ok(await acquireLock(db, "cycle:paper:other", 60_000, 2_000), "different keys are independent");
});

test("an expired lock can be taken over and the old owner cannot release the new one", async () => {
  const db = await freshDb();
  const old = await acquireLock(db, "k1", 1_000, 10_000);
  assert.ok(old);
  assert.equal(await acquireLock(db, "k1", 1_000, 10_999), null, "still held 1ms before expiry");
  const next = await acquireLock(db, "k1", 5_000, 11_000);
  assert.ok(next && next !== old);
  assert.equal(await releaseLock(db, "k1", old!), false);
  assert.equal(await acquireLock(db, "k1", 5_000, 12_000), null, "new owner still holds it");
  assert.equal(await releaseLock(db, "k1", next!), true);
  assert.ok(await acquireLock(db, "k1", 5_000, 12_000));
});

test("renew extends only for the current owner before expiry", async () => {
  const db = await freshDb();
  const o = await acquireLock(db, "k2", 1_000, 0);
  assert.ok(o);
  assert.equal(await renewLock(db, "k2", o!, 1_000, 500), true);
  assert.equal(await acquireLock(db, "k2", 1_000, 1_200), null, "renewed to 1500");
  assert.equal(await renewLock(db, "k2", "someone-else", 1_000, 600), false);
  assert.equal(await renewLock(db, "k2", o!, 1_000, 5_000), false, "cannot renew after expiry");
});

test("withExecutionLock runs once for concurrent callers and always releases", async () => {
  const db = await freshDb();
  let runs = 0;
  const job = () => withExecutionLock(db, "cycle:paper:acct1", 60_000, async () => { runs++; await sleep(10); return "done"; });
  const [r1, r2] = await Promise.all([job(), job()]);
  assert.equal(runs, 1);
  assert.deepEqual([r1.ran, r2.ran].sort(), [false, true]);
  const loser = r1.ran ? r2 : r1;
  assert.equal(loser.ran === false && loser.reason, "locked");
  const again = await job();
  assert.equal(again.ran, true, "lock released after the first run");
  assert.equal(runs, 2);
});

test("withExecutionLock releases when the job throws and rethrows", async () => {
  const db = await freshDb();
  await assert.rejects(withExecutionLock(db, "cycle:x:y", 60_000, async () => { throw new Error("boom"); }), /boom/);
  const next = await withExecutionLock(db, "cycle:x:y", 60_000, async () => 1);
  assert.equal(next.ran, true);
});

test("fails closed when the lock store is unreachable or arguments are invalid", async () => {
  const broken = { prepare() { throw new Error("D1 down"); } } as any;
  let ran = false;
  const r = await withExecutionLock(broken, "cycle:a:b", 1_000, async () => { ran = true; });
  assert.deepEqual(r, { ran: false, reason: "lock_unavailable" });
  assert.equal(ran, false);
  const db = await freshDb();
  assert.deepEqual(await withExecutionLock(db, "bad key with spaces", 1_000, async () => 1), { ran: false, reason: "lock_unavailable" });
  assert.deepEqual(await withExecutionLock(db, "cycle:ok", 0, async () => 1), { ran: false, reason: "lock_unavailable" });
});

test("idempotency: first claim wins, duplicates see the stored result", async () => {
  const db = await freshDb();
  const key = orderIdempotencyKey("paper", "acct1", "BTCUSDT", "sig-42");
  assert.deepEqual(await claimIdempotency(db, key, "order", 1), { claimed: true });
  const dup = await claimIdempotency(db, key, "order", 2);
  assert.equal(dup.claimed, false);
  assert.equal(dup.claimed === false && dup.state, "pending");
  assert.equal(await settleIdempotency(db, key, "done", { orderId: "o-1" }, 3), true);
  assert.equal(await settleIdempotency(db, key, "failed", null, 4), false, "only a pending claim can be settled");
  const after = await claimIdempotency(db, key, "order", 5);
  assert.deepEqual(after, { claimed: false, state: "done", result: { orderId: "o-1" } });
});

test("a definitively failed claim may be retried; an indeterminate one never is", async () => {
  const db = await freshDb();
  assert.equal((await claimIdempotency(db, "order:a", "order", 1)).claimed, true);
  await settleIdempotency(db, "order:a", "failed", { reason: "rejected before send" }, 2);
  assert.equal((await claimIdempotency(db, "order:a", "order", 3)).claimed, true, "retry allowed after failed");
  await settleIdempotency(db, "order:a", "indeterminate", { reason: "timeout" }, 4);
  const again = await claimIdempotency(db, "order:a", "order", 5);
  assert.equal(again.claimed, false);
  assert.equal(again.claimed === false && again.state, "indeterminate");
});

test("concurrent claims of one key yield exactly one winner", async () => {
  const db = await freshDb();
  const results = await Promise.all(Array.from({ length: 8 }, () => claimIdempotency(db, "cyclerun:paper:acct1:1", "cycle", 1)));
  assert.equal(results.filter((r) => r.claimed).length, 1);
});

test("key builders are deterministic, windowed and sanitised", () => {
  assert.equal(cycleLockKey("paper", "acct 1"), "cycle:paper:acct_1");
  const w = 60_000;
  assert.equal(cycleIdempotencyKey("paper", "a", 120_001, w), cycleIdempotencyKey("paper", "a", 179_999, w), "same window, same key");
  assert.notEqual(cycleIdempotencyKey("paper", "a", 120_001, w), cycleIdempotencyKey("paper", "a", 180_000, w));
  assert.notEqual(cycleIdempotencyKey("paper", "a", 1, w), cycleIdempotencyKey("testnet", "a", 1, w), "environments never share keys");
  assert.throws(() => cycleIdempotencyKey("paper", "a", 1, 0));
  assert.match(orderIdempotencyKey("paper", "a", "BTC/USDT", "s 1"), /^order:paper:a:BTC_USDT:s_1$/);
  assert.rejects(claimIdempotency(null as any, "bad key", "x"));
});
