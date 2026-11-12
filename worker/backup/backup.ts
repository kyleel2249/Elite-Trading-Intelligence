/**
 * Encrypted backup and restore of the D1 database (portfolio ledger, accounts, audit trail).
 * The file is sealed with AES-256-GCM under ETI_IDENTITY_KEY, so it is useless without the key. Sessions are not backed up.
 * Restore only writes into EMPTY tables, so a restore can never overwrite or mix with live data.
 * This complements (does not replace) Cloudflare D1 Time Travel, which restores the whole database to any minute of the last 30 days.
 */
import { isD1, type D1DB } from "../portfolio/store.ts";
import { ensureIdentitySchema, auditHash, GENESIS, sha256Hex } from "../identity/store.ts";
import { open, seal } from "../identity/seal.ts";
import { ensureSchema } from "../portfolio/store.ts";

export const FORMAT = "eti-backup-v1";
export const TABLES = ["pf_events", "pf_kv", "id_users", "id_audit"] as const;
type Table = typeof TABLES[number];
const CONTEXT = "backup|v1";
const COL = /^[a-z_][a-z0-9_]{0,40}$/;
interface Payload { format: string; at: number; sha256: string; tables: Record<Table, Record<string, unknown>[]> }
export interface BackupSummary { at: number; counts: Record<Table, number>; bytes: number }

async function dump(db: D1DB): Promise<Record<Table, Record<string, unknown>[]>> {
  const out = {} as Record<Table, Record<string, unknown>[]>;
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT * FROM ${t}${t === "id_audit" ? " ORDER BY seq" : ""}`).all<Record<string, unknown>>()).results;
  return out;
}
export async function exportBackup(db: unknown, keys: string[], now: number): Promise<{ sealed: string; summary: BackupSummary }> {
  if (!isD1(db)) throw new Error("d1_required"); if (!keys[0]) throw new Error("key_required");
  await ensureSchema(db); await ensureIdentitySchema(db);
  const tables = await dump(db), body = JSON.stringify(tables), payload: Payload = { format: FORMAT, at: now, sha256: await sha256Hex(body), tables };
  const sealed = await seal(keys[0], CONTEXT, JSON.stringify(payload));
  return { sealed, summary: { at: now, counts: Object.fromEntries(TABLES.map(t => [t, tables[t].length])) as Record<Table, number>, bytes: sealed.length } };
}
async function auditChainOk(rows: Record<string, unknown>[]): Promise<number | null> {
  let prev = GENESIS;
  for (const r of rows) { if (r.prev_hash !== prev || r.hash !== await auditHash(prev, Number(r.at), String(r.actor), String(r.action), (r.target as string | null) ?? null, (r.detail as string | null) ?? null)) return Number(r.seq); prev = String(r.hash); }
  return null;
}
export type RestoreResult = { ok: true; restored: Record<Table, number>; backupAt: number } | { ok: false; error: string; message: string };
export async function restoreBackup(db: unknown, keys: string[], sealed: string): Promise<RestoreResult> {
  const bad = (error: string, message: string): RestoreResult => ({ ok: false, error, message });
  if (!isD1(db)) return bad("d1_required", "A D1 database is needed.");
  const plain = await open(keys, CONTEXT, sealed.trim()); if (!plain) return bad("cannot_open", "This file was not sealed with the current or previous ETI_IDENTITY_KEY, or it is damaged.");
  let p: Payload; try { p = JSON.parse(plain); } catch { return bad("corrupt", "The backup contents are not valid."); }
  if (p.format !== FORMAT || !p.tables) return bad("unsupported_format", "Unsupported backup format.");
  if (p.sha256 !== await sha256Hex(JSON.stringify(p.tables))) return bad("checksum_mismatch", "The backup contents do not match their checksum.");
  for (const t of TABLES) if (!Array.isArray(p.tables[t])) return bad("corrupt", "Missing table " + t);
  const broken = await auditChainOk(p.tables.id_audit); if (broken !== null) return bad("audit_chain_broken", "The audit trail in this backup fails verification at record " + broken + ".");
  await ensureSchema(db); await ensureIdentitySchema(db);
  for (const t of TABLES) { const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0; if (n > 0) return bad("target_not_empty", "Table " + t + " already has data. Restore only writes into an empty database; use D1 Time Travel to roll a live database back.") }
  const stmts = [];
  for (const t of TABLES) for (const row of p.tables[t]) {
    const cols = Object.keys(row); if (!cols.length || !cols.every(c => COL.test(c))) return bad("corrupt", "Unexpected column in " + t);
    stmts.push(db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map(c => row[c] ?? null)));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { ok: true, backupAt: p.at, restored: Object.fromEntries(TABLES.map(t => [t, p.tables[t].length])) as Record<Table, number> };
}
