// Minimal KV contract shared by the expectancy store and the signal journal (Cloudflare KV satisfies it).
// KV is eventually consistent and not transactional: nothing here assumes atomic read-modify-write.
export interface KVListKey { name: string; metadata?: unknown }
export interface KV {
  get(k: string): Promise<string | null>;
  put(k: string, v: string, o?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  list?(o: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: KVListKey[]; list_complete?: boolean; cursor?: string }>;
}
/** The KV namespace bound as ETI_EXECUTION_LOG, or null when it is not bound. */
export const kvOf = (env: unknown): KV | null => {
  const k = (env as { ETI_EXECUTION_LOG?: KV } | null | undefined)?.ETI_EXECUTION_LOG;
  return k && typeof k.get === "function" && typeof k.put === "function" ? k : null;
};
/** In-memory KV for tests: lexicographic listing, metadata, and optional cursor paging, like the real thing. */
export class MemoryKV implements KV {
  data = new Map<string, { v: string; m?: unknown; ttl?: number }>(); puts = 0; gets = 0; lists = 0;
  async get(k: string) { this.gets++; return this.data.get(k)?.v ?? null; }
  async put(k: string, v: string, o?: { expirationTtl?: number; metadata?: unknown }) { this.puts++; this.data.set(k, { v, m: o?.metadata, ttl: o?.expirationTtl }); }
  async list(o: { prefix: string; limit?: number; cursor?: string }) {
    this.lists++;
    const all = [...this.data.keys()].filter(k => k.startsWith(o.prefix)).sort(), start = o.cursor ? Number(o.cursor) : 0, limit = o.limit ?? 1000, page = all.slice(start, start + limit);
    return { keys: page.map(name => ({ name, metadata: this.data.get(name)!.m })), list_complete: start + limit >= all.length, cursor: start + limit < all.length ? String(start + limit) : undefined };
  }
}
