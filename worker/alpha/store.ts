/**
 * Persistence for the Global Alpha layer. Uses a Workers KV namespace (ETI_ALPHA_KV, falling back to the existing
 * ETI_EXECUTION_LOG binding with an "alpha:" key prefix so no new infrastructure is required). Without any KV binding the
 * store keeps data in isolate memory only and every API response says so ("persistence": "memory_only").
 * Writes are read-modify-write; the cron job is the only frequent writer, so races are rare and bounded to one record.
 */
export interface KvLike { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }
export interface StoreEnv { ETI_ALPHA_KV?: KvLike; ETI_EXECUTION_LOG?: KvLike }
const memory = new Map<string, string>();

export class AlphaStore {
  readonly kv: KvLike | null; readonly mode: "kv" | "memory_only"; readonly binding: string | null;
  constructor(env: StoreEnv, mem: Map<string, string> = memory) {
    const kv = env.ETI_ALPHA_KV ?? env.ETI_EXECUTION_LOG ?? null; this.kv = kv; this.mode = kv ? "kv" : "memory_only"; this.binding = env.ETI_ALPHA_KV ? "ETI_ALPHA_KV" : env.ETI_EXECUTION_LOG ? "ETI_EXECUTION_LOG (alpha: prefix)" : null; this.mem = mem;
  }
  private mem: Map<string, string>;
  private k(key: string) { return "alpha:" + key; }
  async get<T>(key: string, fallback: T): Promise<T> {
    try { const raw = this.kv ? await this.kv.get(this.k(key)) : this.mem.get(this.k(key)) ?? null; return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
  }
  async put(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    const raw = JSON.stringify(value);
    try { if (this.kv) await this.kv.put(this.k(key), raw, ttlSeconds ? { expirationTtl: Math.max(60, ttlSeconds) } : undefined); else this.mem.set(this.k(key), raw); return true; } catch { return false; }
  }
  async update<T>(key: string, fallback: T, fn: (cur: T) => T, ttlSeconds?: number): Promise<T> { const next = fn(await this.get(key, fallback)); await this.put(key, next, ttlSeconds); return next; }
  /** Append to a capped, newest-first list. */
  async push<T>(key: string, item: T, cap: number): Promise<void> { await this.update<T[]>(key, [], cur => [item, ...cur].slice(0, cap)); }
  async audit(actor: string, action: string, detail: Record<string, unknown> = {}, now = Date.now()) { await this.push("audit", { at: new Date(now).toISOString(), actor, action, detail }, 300); }
}
export const memoryKv = (): KvLike & { map: Map<string, string> } => { const map = new Map<string, string>(); return { map, async get(k) { return map.get(k) ?? null; }, async put(k, v) { map.set(k, v); } }; };
