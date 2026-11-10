/** Test helper: a Cloudflare D1-shaped database (prepare/bind/run/all/first/batch) backed by Node's built-in SQLite. Never imported by the Worker. */
import { DatabaseSync } from "node:sqlite";
import type { D1DB, D1Stmt } from "./store.ts";
export interface TestD1 extends D1DB { queries: string[] }
export function sqliteD1(): TestD1 {
  const db = new DatabaseSync(":memory:"), queries: string[] = [];
  const stmt = (sql: string, params: unknown[] = []): D1Stmt => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    run: async () => { queries.push(sql); const r = db.prepare(sql).run(...(params as any[])); return { meta: { changes: Number(r.changes) } }; },
    all: async <T,>() => { queries.push(sql); return { results: db.prepare(sql).all(...(params as any[])) as T[] }; },
    first: async <T,>() => { queries.push(sql); return ((db.prepare(sql).get(...(params as any[])) as T | undefined) ?? null); },
  });
  return {
    queries, prepare: (sql: string) => stmt(sql),
    batch: async (ss: D1Stmt[]) => { db.exec("BEGIN"); try { const out = []; for (const s of ss) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
