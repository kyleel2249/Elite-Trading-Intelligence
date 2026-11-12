/** D1 persistence for identities. Strong consistency matters here (revocation, lockout, a tamper-evident audit chain), which is why identity needs D1 and has no KV fallback. */
import type { D1DB } from "../portfolio/store.ts";
import type { Role } from "./rbac.ts";
export const IDENTITY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS id_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pw TEXT NOT NULL, role TEXT NOT NULL, mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_counter INTEGER NOT NULL DEFAULT -1, recovery TEXT NOT NULL DEFAULT '[]', disabled INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login INTEGER)",
  "CREATE TABLE IF NOT EXISTS id_sessions (sid TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, absolute_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, ip_ref TEXT, mfa INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS id_sessions_uid ON id_sessions (uid)",
  "CREATE TABLE IF NOT EXISTS id_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, ip_ref TEXT, prev_hash TEXT NOT NULL UNIQUE, hash TEXT NOT NULL)",
];
export interface UserRow { id: string; email: string; pw: string; role: Role; mfa_secret: string | null; mfa_enabled: number; mfa_counter: number; recovery: string; disabled: number; failed: number; locked_until: number; created_at: number; updated_at: number; last_login: number | null }
export interface SessionRow { sid: string; uid: string; created_at: number; expires_at: number; absolute_at: number; revoked: number; ip_ref: string | null; mfa: number; limited: number }
export interface AuditRow { seq: number; at: number; actor: string; action: string; target: string | null; detail: string | null; ip_ref: string | null; prev_hash: string; hash: string }
const done = new WeakSet<object>();
export async function ensureIdentitySchema(db: D1DB) { if (done.has(db)) return; await db.batch(IDENTITY_SCHEMA.map(s => db.prepare(s))); done.add(db); }
export const GENESIS = "0".repeat(64);
export async function sha256Hex(s: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, "0")).join(""); }
export const auditHash = (prev: string, at: number, actor: string, action: string, target: string | null, detail: string | null) => sha256Hex([prev, at, actor, action, target ?? "", detail ?? ""].join("|"));

export class IdentityStore {
  db: D1DB; constructor(db: D1DB) { this.db = db; }
  async init() { await ensureIdentitySchema(this.db); return this; }
  async userCount(): Promise<number> { return (await this.db.prepare("SELECT COUNT(*) AS n FROM id_users").first<{ n: number }>())?.n ?? 0; }
  userByEmail(email: string) { return this.db.prepare("SELECT * FROM id_users WHERE email = ?").bind(email).first<UserRow>(); }
  userById(id: string) { return this.db.prepare("SELECT * FROM id_users WHERE id = ?").bind(id).first<UserRow>(); }
  async users(): Promise<UserRow[]> { return (await this.db.prepare("SELECT * FROM id_users ORDER BY created_at").all<UserRow>()).results; }
  async activeAdmins(): Promise<number> { return (await this.db.prepare("SELECT COUNT(*) AS n FROM id_users WHERE role = 'admin' AND disabled = 0").first<{ n: number }>())?.n ?? 0; }
  async insertUser(u: Pick<UserRow, "id" | "email" | "pw" | "role">, now: number) { await this.db.prepare("INSERT INTO id_users (id, email, pw, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(u.id, u.email, u.pw, u.role, now, now).run(); }
  async update(id: string, fields: Partial<Omit<UserRow, "id">>, now: number) {
    const keys = Object.keys(fields); if (!keys.length) return;
    await this.db.prepare("UPDATE id_users SET " + keys.map(k => k.replace(/[^a-z_]/g, "") + " = ?").join(", ") + ", updated_at = ? WHERE id = ?").bind(...keys.map(k => (fields as any)[k]), now, id).run();
  }
  async insertSession(s: SessionRow) { await this.db.prepare("INSERT INTO id_sessions (sid, uid, created_at, expires_at, absolute_at, revoked, ip_ref, mfa, limited) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)").bind(s.sid, s.uid, s.created_at, s.expires_at, s.absolute_at, s.ip_ref, s.mfa, s.limited).run(); }
  session(sid: string) { return this.db.prepare("SELECT * FROM id_sessions WHERE sid = ?").bind(sid).first<SessionRow>(); }
  async touchSession(sid: string, expiresAt: number) { await this.db.prepare("UPDATE id_sessions SET expires_at = ? WHERE sid = ?").bind(expiresAt, sid).run(); }
  async revokeSession(sid: string) { await this.db.prepare("UPDATE id_sessions SET revoked = 1 WHERE sid = ?").bind(sid).run(); }
  async revokeUserSessions(uid: string, exceptSid?: string) { await this.db.prepare("UPDATE id_sessions SET revoked = 1 WHERE uid = ? AND sid != ?").bind(uid, exceptSid ?? "").run(); }
  async purgeExpired(now: number) { await this.db.prepare("DELETE FROM id_sessions WHERE (expires_at < ? OR absolute_at < ?) OR (revoked = 1 AND created_at < ?)").bind(now, now, now - 86_400_000).run(); }
  async sessionsOf(uid: string, now: number) { return (await this.db.prepare("SELECT * FROM id_sessions WHERE uid = ? AND revoked = 0 AND expires_at > ? AND absolute_at > ?").bind(uid, now, now).all<SessionRow>()).results; }

  /** Append to the hash chain. The UNIQUE(prev_hash) constraint makes two concurrent writers collide instead of forking the chain; the loser re-reads the head and retries. */
  async audit(at: number, actor: string, action: string, target: string | null, detail: unknown, ipRef: string | null): Promise<AuditRow> {
    const d = detail === undefined || detail === null ? null : JSON.stringify(detail).slice(0, 2000);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, Math.random() * Math.min(40, 2 * attempt))); // jittered backoff so racing writers spread out
      const head = await this.db.prepare("SELECT hash FROM id_audit ORDER BY seq DESC LIMIT 1").first<{ hash: string }>(), prev = head?.hash ?? GENESIS, hash = await auditHash(prev, at, actor, action, target, d);
      try { await this.db.prepare("INSERT INTO id_audit (at, actor, action, target, detail, ip_ref, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(at, actor, action, target, d, ipRef, prev, hash).run(); return { seq: 0, at, actor, action, target, detail: d, ip_ref: ipRef, prev_hash: prev, hash }; }
      catch (e) { if (!/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) throw e; }
    }
    throw new Error("audit chain contention");
  }
  async auditRows(limit = 100, beforeSeq?: number): Promise<AuditRow[]> { return (await this.db.prepare("SELECT * FROM id_audit WHERE seq < ? ORDER BY seq DESC LIMIT ?").bind(beforeSeq ?? Number.MAX_SAFE_INTEGER, Math.min(500, Math.max(1, limit))).all<AuditRow>()).results; }
  /** Recompute the whole chain. Any edited, deleted or reordered row breaks it at a known sequence number. */
  async verifyAudit(): Promise<{ ok: boolean; rows: number; brokenAt: number | null; head: string }> {
    const rows = (await this.db.prepare("SELECT * FROM id_audit ORDER BY seq").all<AuditRow>()).results; let prev = GENESIS;
    for (const r of rows) { if (r.prev_hash !== prev || r.hash !== await auditHash(prev, r.at, r.actor, r.action, r.target, r.detail)) return { ok: false, rows: rows.length, brokenAt: r.seq, head: prev }; prev = r.hash; }
    return { ok: true, rows: rows.length, brokenAt: null, head: prev };
  }
}
