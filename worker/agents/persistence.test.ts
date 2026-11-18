import assert from "node:assert/strict";
import test from "node:test";
import { listAgentDecisions, persistAgentDecision } from "./persistence.ts";

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    prepare(sql: string) {
      return { bind(...values: unknown[]) {
        return {
          async run() {
            const id = String(values[0]);
            if (rows.has(id)) return { meta: { changes: 0 } };
            rows.set(id, { id, created_at: values[1], symbol: values[2], interval: values[3], payload_json: values[8] });
            return { meta: { changes: 1 } };
          },
          async all() {
            const limit = Number(values[values.length - 1]);
            let data = [...rows.values()];
            if (sql.includes("(created_at < ? OR (created_at = ? AND id < ?))")) {
              const before = Number(values[0]), beforeId = String(values[2]);
              data = data.filter(x => Number(x.created_at) < before || (Number(x.created_at) === before && String(x.id) < beforeId));
            } else if (sql.includes("created_at < ?")) data = data.filter(x => Number(x.created_at) < Number(values[0]));
            if (sql.includes("symbol = ?")) data = data.filter(x => x.symbol === values[values.length - 2]);
            data.sort((a,b) => Number(b.created_at)-Number(a.created_at) || String(b.id).localeCompare(String(a.id)));
            return { results: data.slice(0, limit) };
          },
        };
      }};
    },
  };
}
const snapshot = (id: string, at = "2026-11-18T10:00:00.000Z") => ({
  schema: "eti.analysis/1" as const, id, symbol: "BTCUSDT", interval: "15m", generatedAt: at,
  decision: { action: "NO_TRADE" as const, confidence: 0.42 },
  dataQuality: { provider: "bybit" },
  reports: [{ agent: "technical", evidence: [{ label: "rsi", value: 54 }] }],
  messages: [{ from: "technical", to: "commander" }],
});

test("agent audit snapshots persist full evidence and are idempotent", async () => {
  const db = fakeDb();
  assert.equal((await persistAgentDecision(db, snapshot("a1"))).status, "stored");
  assert.equal((await persistAgentDecision(db, snapshot("a1"))).status, "duplicate");
  const rows = await listAgentDecisions(db);
  assert.equal(rows.records.length, 1);
  assert.equal((rows.records[0] as any).reports[0].evidence[0].label, "rsi");
  assert.equal((rows.records[0] as any).audit.executed, false);
});

test("agent audit snapshots validate identity and bound page size", async () => {
  const db = fakeDb();
  await assert.rejects(() => persistAgentDecision(db, { ...snapshot("bad"), symbol: "BTC/USDT" }));
  for (let i=0;i<4;i++) await persistAgentDecision(db, snapshot("id"+i, new Date(Date.UTC(2026,10,18,10,i)).toISOString()));
  const page = await listAgentDecisions(db, { limit: 2 });
  assert.equal(page.records.length, 2);
  assert.notEqual(page.nextBefore, null);
  assert.notEqual(page.nextBeforeId, null);
  await assert.rejects(() => listAgentDecisions(db, { beforeId: "id-without-time" }));
});

test("agent audit pagination uses a stable id tie-break when timestamps match", async () => {
  const db = fakeDb();
  const at = "2026-11-18T10:00:00.000Z";
  for (const id of ["same-0", "same-1", "same-2", "same-3"]) await persistAgentDecision(db, snapshot(id, at));
  const first = await listAgentDecisions(db, { limit: 2 });
  assert.deepEqual(first.records.map((x) => x.id), ["same-3", "same-2"]);
  assert.equal(first.nextBefore, Date.parse(at));
  assert.equal(first.nextBeforeId, "same-2");
  const second = await listAgentDecisions(db, { limit: 2, before: first.nextBefore!, beforeId: first.nextBeforeId! });
  assert.deepEqual(second.records.map((x) => x.id), ["same-1", "same-0"]);
  assert.equal(second.nextBefore, null);
  assert.equal(second.nextBeforeId, null);
});
