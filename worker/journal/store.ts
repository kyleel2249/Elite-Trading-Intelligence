/**
 * ETI AUTONOMOUS TRADE JOURNAL: storage.
 *
 * Entries are append-only and permanent: there is no update, delete or expiry anywhere in this module. A correction is a NEW entry
 * that points at the entry it corrects (`corrects`), so history is never rewritten.
 *
 * Every entry carries `hash = SHA-256(canonical entry including prev)` and `prev` (the hash of the entry before it).
 *  D1 (binding ETI_PORTFOLIO_DB, preferred): strict chain. seq is UNIQUE, so two writers can never extend the same head; the loser retries.
 *  KV  (binding ETI_EXECUTION_LOG, fallback): each entry is still hashed and linked to the head it saw, but KV cannot serialise writers, so
 *      concurrent writes may fork the chain. Verification reports forks instead of hiding them. KV also reads one value per entry, so it
 *      is capped (MAX_KV_ENTRIES); use D1 for a permanent, unbounded journal.
 * Entries with the same `id` are written once (idempotent), which is what makes the backfill/sync jobs safe to repeat.
 */
import { isD1, type D1DB, type KVL } from "../portfolio/store.ts";

export type EntrySource = "eti_auto" | "manual" | "derived";
export interface JournalEntry {
  id: string; seq: number; at: number; recordedAt: number; kind: string; tradeId: string | null; symbol: string | null; environment: string | null;
  source: EntrySource; actor: string; data: Record<string, unknown>; corrects: string | null; prev: string | null; hash: string;
}
export type NewEntry = Omit<JournalEntry, "seq" | "recordedAt" | "prev" | "hash" | "corrects"> & { corrects?: string | null; recordedAt?: number };

export const MAX_KV_ENTRIES = 5000;
export const MAX_D1_ENTRIES = 200_000;
export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS jr_entries (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, kind TEXT NOT NULL, trade_id TEXT, symbol TEXT, env TEXT, hash TEXT NOT NULL, prev TEXT, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS jr_entries_trade ON jr_entries (trade_id, seq)",
  "CREATE INDEX IF NOT EXISTS jr_entries_at ON jr_entries (at)",
  "CREATE TABLE IF NOT EXISTS jr_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];

/** JSON with sorted keys, so the same entry always hashes the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/** The fields a hash covers. seq is deliberately excluded (KV assigns it after the fact) but at/recordedAt/prev/data/corrects are not. */
const hashBody = (e: Omit<JournalEntry, "hash" | "seq">) => canonical({ id: e.id, at: e.at, recordedAt: e.recordedAt, kind: e.kind, tradeId: e.tradeId, symbol: e.symbol, environment: e.environment, source: e.source, actor: e.actor, data: e.data, corrects: e.corrects, prev: e.prev });
export const entryHash = (e: Omit<JournalEntry, "hash" | "seq">) => sha256(hashBody(e));

export type JournalEnv = { ETI_PORTFOLIO_DB?: unknown; ETI_EXECUTION_LOG?: unknown };
export const journalConfigured = (env: JournalEnv) => isD1(env.ETI_PORTFOLIO_DB) || !!env.ETI_EXECUTION_LOG;
export function openJournal(env: JournalEnv): JournalStore | null {
  const src = isD1(env.ETI_PORTFOLIO_DB) ? env.ETI_PORTFOLIO_DB : env.ETI_EXECUTION_LOG;
  return src ? new JournalStore(src as KVL | D1DB) : null;
}
const ensured = new WeakSet<object>();
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(13, "0");

export class JournalStore {
  kv: KVL | null; db: D1DB | null; kind: "d1" | "kv";
  constructor(src: KVL | D1DB) { this.db = isD1(src) ? src : null; this.kv = this.db ? null : src as KVL; this.kind = this.db ? "d1" : "kv"; }
  private async ready() { if (this.db && !ensured.has(this.db)) { await this.db.batch(SCHEMA.map(s => this.db!.prepare(s))); ensured.add(this.db); } }

  async get(id: string): Promise<JournalEntry | null> {
    if (this.db) { await this.ready(); const r = await this.db.prepare("SELECT body, seq FROM jr_entries WHERE id = ?").bind(id).first<{ body: string; seq: number }>(); return r ? { ...JSON.parse(r.body), seq: r.seq } : null; }
    const key = await this.kv!.get("jr:id:" + id); if (!key) return null;
    try { return JSON.parse((await this.kv!.get(key)) || "null"); } catch { return null; }
  }
  /** Append one entry. Returns the stored entry; `created` is false when an entry with this id already existed (nothing is overwritten). */
  async append(n: NewEntry, now = Date.now()): Promise<{ entry: JournalEntry; created: boolean }> {
    const existing = await this.get(n.id); if (existing) return { entry: existing, created: false };
    if (this.db) {
      await this.ready();
      for (let attempt = 0; attempt < 8; attempt++) {
        const head = await this.db.prepare("SELECT seq, hash FROM jr_entries ORDER BY seq DESC LIMIT 1").first<{ seq: number; hash: string }>();
        const base = { id: n.id, at: Math.floor(n.at), recordedAt: Math.floor(n.recordedAt ?? now), kind: n.kind, tradeId: n.tradeId, symbol: n.symbol, environment: n.environment, source: n.source, actor: n.actor, data: n.data, corrects: n.corrects ?? null, prev: head?.hash ?? null };
        const hash = await entryHash(base), seq = (head?.seq ?? 0) + 1, entry: JournalEntry = { ...base, seq, hash };
        try {
          await this.db.prepare("INSERT INTO jr_entries (seq, id, at, kind, trade_id, symbol, env, hash, prev, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(seq, entry.id, entry.at, entry.kind, entry.tradeId, entry.symbol, entry.environment, hash, entry.prev, JSON.stringify({ ...base, hash })).run();
          return { entry, created: true };
        } catch (e) { const again = await this.get(n.id); if (again) return { entry: again, created: false }; if (attempt === 7) throw e; }
      }
      throw new Error("journal append failed");
    }
    const headRaw = await this.kv!.get("jr:head"); let head: { hash: string; seq: number } | null = null; try { head = headRaw ? JSON.parse(headRaw) : null; } catch { head = null; }
    const base = { id: n.id, at: Math.floor(n.at), recordedAt: Math.floor(n.recordedAt ?? now), kind: n.kind, tradeId: n.tradeId, symbol: n.symbol, environment: n.environment, source: n.source, actor: n.actor, data: n.data, corrects: n.corrects ?? null, prev: head?.hash ?? null };
    const hash = await entryHash(base), entry: JournalEntry = { ...base, seq: (head?.seq ?? 0) + 1, hash };
    const key = "jr:e:" + pad(entry.recordedAt) + ":" + entry.id;
    await this.kv!.put(key, JSON.stringify(entry));          // no expirationTtl: permanent
    await this.kv!.put("jr:id:" + entry.id, key);
    try { await this.kv!.put("jr:head", JSON.stringify({ hash, seq: entry.seq })); } catch { /* hint only */ }
    return { entry, created: true };
  }
  /** Every entry, oldest first (by seq, then recordedAt). `truncated` is true when the backend cap was hit. */
  async all(): Promise<{ entries: JournalEntry[]; truncated: boolean }> {
    if (this.db) {
      await this.ready();
      const r = await this.db.prepare("SELECT body, seq FROM jr_entries ORDER BY seq LIMIT ?").bind(MAX_D1_ENTRIES + 1).all<{ body: string; seq: number }>();
      const entries: JournalEntry[] = []; for (const x of r.results) { try { entries.push({ ...JSON.parse(x.body), seq: x.seq }); } catch { /* a corrupt row is reported by verify, never crashes reads */ } }
      return { entries: entries.slice(0, MAX_D1_ENTRIES), truncated: entries.length > MAX_D1_ENTRIES };
    }
    const keys: string[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) { const l = await this.kv!.list({ prefix: "jr:e:", limit: 1000, ...(cursor ? { cursor } : {}) }); keys.push(...l.keys.map(k => k.name)); if (l.list_complete !== false || !l.cursor) break; cursor = l.cursor; }
    keys.sort(); const take = keys.slice(-MAX_KV_ENTRIES), entries: JournalEntry[] = [];
    for (const k of take) { try { const e = JSON.parse((await this.kv!.get(k)) || "null"); if (e) entries.push(e); } catch { /* reported by verify */ } }
    return { entries, truncated: keys.length > MAX_KV_ENTRIES };
  }
  async meta<T>(k: string, fb: T): Promise<T> {
    try {
      if (this.db) { await this.ready(); const r = await this.db.prepare("SELECT v FROM jr_kv WHERE k = ?").bind(k).first<{ v: string }>(); return r ? JSON.parse(r.v) : fb; }
      return JSON.parse((await this.kv!.get("jr:meta:" + k)) || "null") ?? fb;
    } catch { return fb; }
  }
  /** Bookkeeping only (sync cursors); never journal content. */
  async setMeta(k: string, v: unknown) {
    if (this.db) { await this.ready(); await this.db.prepare("INSERT INTO jr_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run(); return; }
    await this.kv!.put("jr:meta:" + k, JSON.stringify(v));
  }
}

export interface Verification { ok: boolean; entries: number; checked: number; badHashes: string[]; brokenLinks: string[]; forks: number; truncated: boolean; head: string | null; storage: "d1" | "kv"; note: string }
/** Re-computes every hash and checks every link. Any edited, removed-and-replaced or reordered entry shows up here. */
export async function verifyChain(store: JournalStore): Promise<Verification> {
  const { entries, truncated } = await store.all(), byHash = new Map(entries.map(e => [e.hash, e])), badHashes: string[] = [], brokenLinks: string[] = [];
  const children = new Map<string | null, number>();
  for (const e of entries) {
    const { hash, seq, ...rest } = e; if ((await entryHash(rest)) !== hash) badHashes.push(e.id);
    children.set(e.prev, (children.get(e.prev) ?? 0) + 1);
    if (e.prev !== null && !byHash.has(e.prev) && !(truncated && e === entries[0])) brokenLinks.push(e.id);
  }
  if (store.db) { for (let i = 1; i < entries.length; i++) if (entries[i].prev !== entries[i - 1].hash && !brokenLinks.includes(entries[i].id)) brokenLinks.push(entries[i].id); }
  const forks = [...children.values()].filter(n => n > 1).length;
  const ok = !badHashes.length && !brokenLinks.length && (store.db ? forks === 0 : true);
  return { ok, entries: entries.length, checked: entries.length, badHashes, brokenLinks, forks, truncated, head: entries.at(-1)?.hash ?? null, storage: store.kind,
    note: store.kind === "d1" ? "Strict hash chain: every entry links to the one before it." : "KV fallback: entries are hashed and linked, but concurrent writers can fork the chain; forks are counted, not hidden." };
}
