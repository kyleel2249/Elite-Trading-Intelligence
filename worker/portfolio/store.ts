/**
 * Persistent event store for the portfolio ledger, one stream per environment, on the ETI_EXECUTION_LOG KV namespace.
 *   pf:<env>:ev:<at, 13 digits>:<eventId>   one event per key (append-only, never updated)
 *   pf:<env>:id:<eventId>                   idempotency marker for deterministic event ids
 *   pf:<env>:snap                           cached fold input {keys, events}; derived data, safe to lose
 * Writes never read-modify-write shared state, so concurrent requests cannot lose each other's events. KV is eventually
 * consistent: another location may need up to ~60 s to see a new event (the writer sees it on its next read).
 */
import { fold, type Environment, type Ledger, type LedgerEvent } from "./ledger.ts";
export interface KVL { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete(k: string): Promise<void>; list(o: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }> }
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(13, "0");
export const MAX_EVENTS = 20_000;
export const newId = (prefix = "ev") => prefix + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
let KVID = 0;
const CACHE = new Map<string, { head: string; at: number; value: { ledger: Ledger; version: string; truncated: boolean } }>();
export interface Snapshot { keys: string[]; events: LedgerEvent[] }
export class PortfolioStore {
  kv: KVL; env: Environment;
  constructor(kv: KVL, env: Environment) { this.kv = kv; this.env = env; }
  private p = (s: string) => "pf:" + this.env + ":" + s;
  /** Append one event. A deterministic id is written at most once (returns false when it already existed). */
  async append(ev: LedgerEvent, opts: { idempotent?: boolean } = {}): Promise<boolean> {
    if (opts.idempotent) { if (await this.kv.get(this.p("id:" + ev.id))) return false; await this.kv.put(this.p("id:" + ev.id), "1"); }
    const key = this.p("ev:" + pad(ev.at) + ":" + ev.id);
    await this.kv.put(key, JSON.stringify(ev));
    try { await this.kv.put(this.p("head"), key); } catch { /* hint only */ }
    CACHE.delete(this.env + "|" + ((this.kv as any).__id ??= ++KVID));
    return true;
  }
  private async listKeys(): Promise<{ keys: string[]; truncated: boolean }> {
    const keys: string[] = []; let cursor: string | undefined, guard = 0;
    for (;;) { const r = await this.kv.list({ prefix: this.p("ev:"), limit: 1000, ...(cursor ? { cursor } : {}) }); keys.push(...r.keys.map(k => k.name)); if (r.list_complete !== false || !r.cursor || ++guard > 25) break; cursor = r.cursor; }
    return { keys: keys.sort(), truncated: keys.length > MAX_EVENTS };
  }
  /** Version string that changes whenever the event set changes. */
  async version(): Promise<string> { const { keys } = await this.listKeys(); return keys.length + ":" + (keys.at(-1) ?? ""); }
  async events(): Promise<{ events: LedgerEvent[]; version: string; truncated: boolean }> {
    const { keys, truncated } = await this.listKeys(); const version = keys.length + ":" + (keys.at(-1) ?? "");
    let snap: Snapshot | null = null; try { snap = JSON.parse((await this.kv.get(this.p("snap"))) || "null"); } catch { snap = null; }
    const have = new Map<string, LedgerEvent>(); if (snap) snap.keys.forEach((k, i) => have.set(k, snap!.events[i]));
    const out: LedgerEvent[] = [], usedKeys: string[] = []; let fetched = 0;
    for (const k of keys.slice(0, MAX_EVENTS)) {
      let e = have.get(k);
      if (!e) { try { e = JSON.parse((await this.kv.get(k)) || "null") ?? undefined; } catch { e = undefined; } fetched++; }
      if (e) { out.push(e); usedKeys.push(k); }
    }
    if (fetched > 0 && out.length) { try { await this.kv.put(this.p("snap"), JSON.stringify({ keys: usedKeys, events: out })); } catch { /* cache only */ } }
    return { events: out, version, truncated };
  }
  async ledger(): Promise<{ ledger: Ledger; version: string; truncated: boolean }> { const r = await this.events(); return { ledger: fold(this.env, r.events), version: r.version, truncated: r.truncated }; }
  /** Cheaper read for polling: one KV get of the head hint, and the folded ledger is reused while the hint is unchanged (re-listed at least every 45 s). */
  async ledgerFast(now = Date.now()): Promise<{ ledger: Ledger; version: string; truncated: boolean; cached: boolean }> {
    const head = (await this.kv.get(this.p("head"))) ?? "none", ck = this.env + "|" + ((this.kv as any).__id ??= ++KVID), c = CACHE.get(ck);
    if (c && c.head === head && now - c.at < 45_000) return { ...c.value, cached: true };
    const value = await this.ledger(); CACHE.set(ck, { head, at: now, value }); return { ...value, cached: false };
  }
  async kvGet<T>(k: string, fb: T): Promise<T> { try { return JSON.parse((await this.kv.get(this.p(k))) || "null") ?? fb; } catch { return fb; } }
  async kvPut(k: string, v: unknown, ttl?: number) { await this.kv.put(this.p(k), JSON.stringify(v), ttl ? { expirationTtl: Math.max(60, ttl) } : undefined); }
}
