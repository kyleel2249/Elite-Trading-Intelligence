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
            if (sql.includes("symbol = ?")) data = data.filter(x => x.symbol === values[values.length - 2]);
            if (sql.includes("created_at < ?")) data = data.filter(x => Number(x.created_at) < Number(values[0]));
            data.sort((a,b) => Number(b.created_at)-Number(a.created_at));
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
});
