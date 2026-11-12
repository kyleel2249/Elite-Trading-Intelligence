/**
 * Persistent event store for the portfolio ledger, one stream per environment. Two interchangeable backends:
 *
 *  D1 (preferred, binding ETI_PORTFOLIO_DB)   strongly consistent SQLite. Tables pf_events (PRIMARY KEY env,id) and pf_kv.
 *                                              An append is one atomic batch; a duplicate id is ignored by the primary key.
 *                                              Polling costs one row read (the head counter) while nothing changed.
 *  KV (fallback, binding ETI_EXECUTION_LOG)    pf:<env>:ev:<at, 13 digits>:<id> per event, pf:<env>:id:<id> idempotency marker,
 *                                              pf:<env>:head hint, pf:<env>:snap cache. Eventually consistent (about a minute).
 * Events are append-only and never updated, so concurrent requests cannot lose each other's writes on either backend.
 */
import { fold, type Environment, type Ledger, type LedgerEvent } from "./ledger.ts";
export interface KVL { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete(k: string): Promise<void>; list(o: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }> }
export interface D1Stmt { bind(...v: unknown[]): D1Stmt; run(): Promise<{ meta?: { changes?: number } }>; all<T = any>(): Promise<{ results: T[] }>; first<T = any>(): Promise<T | null> }
export interface D1DB { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<{ meta?: { changes?: number } }[]> }
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(13, "0");
export const MAX_EVENTS = 20_000;
export const newId = (prefix = "ev") => prefix + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
export const isD1 = (x: unknown): x is D1DB => !!x && typeof (x as any).prepare === "function" && typeof (x as any).batch === "function";
export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS pf_events (env TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (env, id))",
  "CREATE INDEX IF NOT EXISTS pf_events_order ON pf_events (env, at, id)",
  "CREATE TABLE IF NOT EXISTS pf_kv (env TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, exp INTEGER, PRIMARY KEY (env, k))",
];
const ensured = new WeakSet<object>();
export async function ensureSchema(db: D1DB) { if (ensured.has(db)) return; await db.batch(SCHEMA.map(s => db.prepare(s))); ensured.add(db); }
let UID = 0; const uids = new WeakMap<object, number>();
const uidOf = (o: object) => { let u = uids.get(o); if (!u) uids.set(o, u = ++UID); return u; };
const CACHE = new Map<string, { head: string; at: number; value: { ledger: Ledger; version: string; truncated: boolean } }>();
export interface Snapshot { keys: string[]; events: LedgerEvent[] }
export type StoreKind = "d1" | "kv";

/** Pick the backend from the Worker environment: D1 when bound, otherwise KV. */
export function openStore(env: { ETI_PORTFOLIO_DB?: unknown; ETI_EXECUTION_LOG?: unknown }, environment: Environment): PortfolioStore | null {
  const src = isD1(env.ETI_PORTFOLIO_DB) ? env.ETI_PORTFOLIO_DB : env.ETI_EXECUTION_LOG;
  return src ? new PortfolioStore(src as KVL | D1DB, environment) : null;
}
export const storageConfigured = (env: { ETI_PORTFOLIO_DB?: unknown; ETI_EXECUTION_LOG?: unknown }) => isD1(env.ETI_PORTFOLIO_DB) || !!env.ETI_EXECUTION_LOG;

export class PortfolioStore {
  env: Environment; kv: KVL | null; db: D1DB | null; kind: StoreKind;
  constructor(src: KVL | D1DB, env: Environment) { this.env = env; this.db = isD1(src) ? src : null; this.kv = this.db ? null : src as KVL; this.kind = this.db ? "d1" : "kv"; }
  private p = (s: string) => "pf:" + this.env + ":" + s;
  private ck = () => this.env + "|" + uidOf((this.db ?? this.kv) as object);

  /** Append one event. Returns false when an event with this id already exists (idempotent writes). */
  async append(ev: LedgerEvent, opts: { idempotent?: boolean } = {}): Promise<boolean> {
    CACHE.delete(this.ck());
    if (this.db) {
      await ensureSchema(this.db);
      const r = await this.db.batch([
        this.db.prepare("INSERT OR IGNORE INTO pf_events (env, id, at, body) VALUES (?, ?, ?, ?)").bind(this.env, ev.id, Math.floor(ev.at), JSON.stringify(ev)),
        this.db.prepare("INSERT INTO pf_kv (env, k, v, exp) VALUES (?, 'head', '1', NULL) ON CONFLICT (env, k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)").bind(this.env),
      ]);
      return (r[0]?.meta?.changes ?? 1) > 0;
    }
    const kv = this.kv!;
    if (opts.idempotent) { if (await kv.get(this.p("id:" + ev.id))) return false; await kv.put(this.p("id:" + ev.id), "1"); }
    const key = this.p("ev:" + pad(ev.at) + ":" + ev.id);
    await kv.put(key, JSON.stringify(ev));
    try { await kv.put(this.p("head"), key); } catch { /* hint only */ }
    return true;
  }
  /** Cheap change marker: a counter (D1) or the newest event key (KV). */
  async head(): Promise<string> {
    if (this.db) { await ensureSchema(this.db); return (await this.db.prepare("SELECT v FROM pf_kv WHERE env = ? AND k = 'head'").bind(this.env).first<{ v: string }>())?.v ?? "none"; }
    return (await this.kv!.get(this.p("head"))) ?? "none";
  }
  private async listKeys(): Promise<{ keys: string[]; truncated: boolean }> {
    const keys: string[] = []; let cursor: string | undefined, guard = 0;
    for (;;) { const r = await this.kv!.list({ prefix: this.p("ev:"), limit: 1000, ...(cursor ? { cursor } : {}) }); keys.push(...r.keys.map(k => k.name)); if (r.list_complete !== false || !r.cursor || ++guard > 25) break; cursor = r.cursor; }
    return { keys: keys.sort(), truncated: keys.length > MAX_EVENTS };
  }
  async version(): Promise<string> { if (this.db) return this.head(); const { keys } = await this.listKeys(); return keys.length + ":" + (keys.at(-1) ?? ""); }
  async events(): Promise<{ events: LedgerEvent[]; version: string; truncated: boolean }> {
    if (this.db) {
      await ensureSchema(this.db);
      const [rows, head] = await Promise.all([this.db.prepare("SELECT body FROM pf_events WHERE env = ? ORDER BY at, id LIMIT ?").bind(this.env, MAX_EVENTS + 1).all<{ body: string }>(), this.head()]);
      const events: LedgerEvent[] = []; for (const r of rows.results) { try { events.push(JSON.parse(r.body)); } catch { /* skip a corrupt row, never crash the ledger */ } }
      return { events: events.slice(0, MAX_EVENTS), version: head, truncated: events.length > MAX_EVENTS };
    }
    const { keys, truncated } = await this.listKeys(); const version = keys.length + ":" + (keys.at(-1) ?? "");
    let snap: Snapshot | null = null; try { snap = JSON.parse((await this.kv!.get(this.p("snap"))) || "null"); } catch { snap = null; }
    const have = new Map<string, LedgerEvent>(); if (snap) snap.keys.forEach((k, i) => have.set(k, snap!.events[i]));
    const out: LedgerEvent[] = [], usedKeys: string[] = []; let fetched = 0;
    for (const k of keys.slice(0, MAX_EVENTS)) {
      let e = have.get(k);
      if (!e) { try { e = JSON.parse((await this.kv!.get(k)) || "null") ?? undefined; } catch { e = undefined; } fetched++; }
      if (e) { out.push(e); usedKeys.push(k); }
    }
    if (fetched > 0 && out.length) { try { await this.kv!.put(this.p("snap"), JSON.stringify({ keys: usedKeys, events: out })); } catch { /* cache only */ } }
    return { events: out, version, truncated };
  }
  async ledger(): Promise<{ ledger: Ledger; version: string; truncated: boolean }> { const r = await this.events(); return { ledger: fold(this.env, r.events), version: r.version, truncated: r.truncated }; }
  /** Polling read: one cheap head read; the folded ledger is reused while the head is unchanged (KV is re-listed at least every 45 s because it is eventually consistent). */
  async ledgerFast(now = Date.now()): Promise<{ ledger: Ledger; version: string; truncated: boolean; cached: boolean }> {
    const head = await this.head(), ck = this.ck(), c = CACHE.get(ck), maxAge = this.db ? 600_000 : 45_000;
    if (c && c.head === head && now - c.at < maxAge) return { ...c.value, cached: true };
    const value = await this.ledger(); CACHE.set(ck, { head, at: now, value }); return { ...value, cached: false };
  }
  async kvGet<T>(k: string, fb: T): Promise<T> {
    try {
      if (this.db) { await ensureSchema(this.db); const r = await this.db.prepare("SELECT v, exp FROM pf_kv WHERE env = ? AND k = ?").bind(this.env, k).first<{ v: string; exp: number | null }>(); if (!r || (r.exp !== null && r.exp < Date.now())) return fb; return JSON.parse(r.v) ?? fb; }
      return JSON.parse((await this.kv!.get(this.p(k))) || "null") ?? fb;
    } catch { return fb; }
  }
  async kvPut(k: string, v: unknown, ttl?: number) {
    if (this.db) { await ensureSchema(this.db); await this.db.prepare("INSERT INTO pf_kv (env, k, v, exp) VALUES (?, ?, ?, ?) ON CONFLICT (env, k) DO UPDATE SET v = excluded.v, exp = excluded.exp").bind(this.env, k, JSON.stringify(v), ttl ? Date.now() + Math.max(60, ttl) * 1000 : null).run(); return; }
    await this.kv!.put(this.p(k), JSON.stringify(v), ttl ? { expirationTtl: Math.max(60, ttl) } : undefined);
  }
}

/** Copy every event of one environment from KV into D1 (idempotent: existing ids are skipped). Returns how many were newly written. */
export async function importKvToD1(kv: KVL, db: D1DB, environment: Environment): Promise<{ read: number; written: number }> {
  const src = new PortfolioStore(kv, environment), dst = new PortfolioStore(db, environment), { events } = await src.events(); let written = 0;
  for (const ev of events) if (await dst.append(ev)) written++;
  return { read: events.length, written };
}
