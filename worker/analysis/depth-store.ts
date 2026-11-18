// Durable D1 storage for timestamped order-book depth snapshots (migration 0018). Extends the KV sampler in orderflow.ts:
// KV keeps a short rolling window, D1 keeps a longer bounded history. A single snapshot is never presented as history; callers
// receive the sample count and window so sampling limits stay visible. Nothing here can submit an order.
import type { Depth } from "../market.ts";
import type { AgentAuditDb } from "../agents/persistence.ts";
import type { DepthSnapshot } from "./orderflow.ts";

export const DEPTH_BUCKET_MS = 5000, DEPTH_RETENTION_MS = 14 * 86_400_000, DEPTH_MAX_LEVELS = 20, DEPTH_MAX_ROWS = 500, DEPTH_PRUNE_BATCH = 500;
export type DepthVenue = "bybit" | "bitget"; export type DepthMarket = "spot" | "futures";
export interface DepthWriteInput { venue: DepthVenue; market: DepthMarket; symbol: string; depth: Depth; now: number; retentionMs?: number }
const SYMBOL = /^[A-Z0-9._-]{1,20}$/;
const levels = (l: [number, number][]) => l.slice(0, DEPTH_MAX_LEVELS).filter(x => Number.isFinite(x[0]) && x[0] > 0 && Number.isFinite(x[1]) && x[1] > 0);

export async function persistDepthSnapshot(db: AgentAuditDb, input: DepthWriteInput): Promise<{ status: "stored" | "duplicate" | "rejected"; reason?: string }> {
  if (!SYMBOL.test(input.symbol) || (input.venue !== "bybit" && input.venue !== "bitget") || (input.market !== "spot" && input.market !== "futures")) return { status: "rejected", reason: "invalid_market_identity" };
  if (!Number.isFinite(input.now) || input.now <= 0) return { status: "rejected", reason: "invalid_timestamp" };
  const bids = levels(input.depth.bids), asks = levels(input.depth.asks);
  if (!bids.length || !asks.length || bids[0][0] > asks[0][0]) return { status: "rejected", reason: "empty_or_crossed_book" };
  const bucket = Math.floor(input.now / DEPTH_BUCKET_MS) * DEPTH_BUCKET_MS;
  const r = await db.prepare("INSERT OR IGNORE INTO eti_depth_snapshots (venue, market, symbol, bucket_at, captured_at, best_bid, best_ask, bids_json, asks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(input.venue, input.market, input.symbol, bucket, input.now, bids[0][0], asks[0][0], JSON.stringify(bids), JSON.stringify(asks)).run();
  const stored = (r.meta?.changes ?? 0) > 0;
  // Deterministic, bounded retention: roughly one write in twenty prunes at most one batch of expired rows.
  if (stored && (bucket / DEPTH_BUCKET_MS) % 20 === 0) await pruneDepthSnapshots(db, input.now - (input.retentionMs ?? DEPTH_RETENTION_MS)).catch(() => 0);
  return { status: stored ? "stored" : "duplicate" };
}

export async function pruneDepthSnapshots(db: AgentAuditDb, olderThan: number): Promise<number> {
  if (!Number.isFinite(olderThan)) return 0;
  const r = await db.prepare("DELETE FROM eti_depth_snapshots WHERE rowid IN (SELECT rowid FROM eti_depth_snapshots WHERE bucket_at < ? LIMIT ?)").bind(olderThan, DEPTH_PRUNE_BATCH).run();
  return r.meta?.changes ?? 0;
}

export async function listDepthSnapshots(db: AgentAuditDb, q: { venue: DepthVenue; market: DepthMarket; symbol: string; from?: number; to?: number; limit?: number }): Promise<DepthSnapshot[]> {
  if (!SYMBOL.test(q.symbol)) throw new Error("invalid_symbol");
  const limit = Math.max(1, Math.min(DEPTH_MAX_ROWS, Math.floor(q.limit ?? 120))), from = Number.isFinite(q.from) ? Number(q.from) : 0, to = Number.isFinite(q.to) ? Number(q.to) : Number.MAX_SAFE_INTEGER;
  // Newest `limit` rows in the window, returned oldest-first.
  const res = await db.prepare("SELECT captured_at, bids_json, asks_json FROM eti_depth_snapshots WHERE venue = ? AND market = ? AND symbol = ? AND bucket_at >= ? AND bucket_at <= ? ORDER BY bucket_at DESC LIMIT ?").bind(q.venue, q.market, q.symbol, from, to, limit).all();
  const out: DepthSnapshot[] = [];
  for (const row of res.results ?? []) {
    try {
      const bids = JSON.parse(String(row.bids_json)), asks = JSON.parse(String(row.asks_json)), t = Number(row.captured_at);
      if (Number.isFinite(t) && Array.isArray(bids) && Array.isArray(asks)) out.push({ capturedAt: t, bids, asks });
    } catch { /* a corrupt row is skipped, never repaired or invented */ }
  }
  return out.reverse();
}

/** Write then read the durable window. Any storage failure returns null so callers report 'unavailable' instead of fabricating history. */
export async function recordAndLoadDurable(db: AgentAuditDb | undefined, input: DepthWriteInput, windowMs = 6 * 3_600_000): Promise<DepthSnapshot[] | null> {
  if (!db) return null;
  try {
    const w = await persistDepthSnapshot(db, input);
    if (w.status === "rejected") return null;
    return await listDepthSnapshots(db, { venue: input.venue, market: input.market, symbol: input.symbol, from: input.now - windowMs, to: input.now, limit: DEPTH_MAX_ROWS });
  } catch { return null; }
}
