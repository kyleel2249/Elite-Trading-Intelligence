// D1 persistence for the Bitget instrument catalogue (migration 0019). Pure storage: no network, no import of market.ts at runtime
// (type-only), so market.ts can read the snapshot as a fallback without an import cycle.
import type { SymbolRow } from "../market.ts";

export const CATALOGUE_CATEGORIES = ["SPOT", "USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES", "MARGIN"] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];
export const isCatalogueCategory = (v: unknown): v is CatalogueCategory => (CATALOGUE_CATEGORIES as readonly string[]).includes(String(v));

export interface CatStmt {
  bind(...values: unknown[]): CatStmt;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface CatalogueDb { prepare(sql: string): CatStmt }

export interface StoredCategory { category: CatalogueCategory; rows: SymbolRow[]; count: number; hash: string; fetchedAt: number; changedAt: number }
export interface CatalogueEvent { at: number; category: CatalogueCategory; change: "listed" | "delisted"; symbol: string }
export type CategoryOutcome = "ok" | "carried" | "missing";
export interface CategoryRun { status: CategoryOutcome; count: number; added: number; removed: number; error: string | null }
export interface CatalogueRun {
  at: number; durationMs: number; ok: boolean; consecutiveFailures: number; persisted: boolean; storageError: string | null;
  categories: Record<CatalogueCategory, CategoryRun>;
}

export const EVENT_RETENTION_MS = 30 * 24 * 3600 * 1000;
const RUN_KEY = "last_run";

/** All stored categories. Throws if the table is missing (migration 0019 not applied) so the caller can report it. */
export async function loadCategories(db: CatalogueDb): Promise<Partial<Record<CatalogueCategory, StoredCategory>>> {
  const { results } = await db.prepare("SELECT category, rows_json, pair_count, content_hash, fetched_at, changed_at FROM eti_bitget_catalogue").bind().all<Record<string, unknown>>();
  const out: Partial<Record<CatalogueCategory, StoredCategory>> = {};
  for (const r of results ?? []) {
    if (!isCatalogueCategory(r.category)) continue;
    let rows: SymbolRow[] = [];
    try { const parsed = JSON.parse(String(r.rows_json)); if (Array.isArray(parsed)) rows = parsed; } catch { /* a corrupt row reads as empty and is rewritten by the next successful sync */ }
    out[r.category] = { category: r.category, rows, count: Number(r.pair_count) || 0, hash: String(r.content_hash), fetchedAt: Number(r.fetched_at), changedAt: Number(r.changed_at) };
  }
  return out;
}

/** The pair list changed (or is new): rewrite the whole row. */
export async function saveCategory(db: CatalogueDb, category: CatalogueCategory, rows: SymbolRow[], hash: string, now: number): Promise<void> {
  await db.prepare(
    "INSERT INTO eti_bitget_catalogue (category, rows_json, pair_count, content_hash, fetched_at, changed_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(category) DO UPDATE SET rows_json = excluded.rows_json, pair_count = excluded.pair_count, content_hash = excluded.content_hash, fetched_at = excluded.fetched_at, changed_at = excluded.changed_at",
  ).bind(category, JSON.stringify(rows), rows.length, hash, now, now).run();
}

/** Nothing changed since the last refresh: only advance the confirmation time (a tiny write, no 100 KB+ payload). */
export async function touchCategory(db: CatalogueDb, category: CatalogueCategory, now: number): Promise<void> {
  await db.prepare("UPDATE eti_bitget_catalogue SET fetched_at = ? WHERE category = ?").bind(now, category).run();
}

export async function recordEvents(db: CatalogueDb, events: CatalogueEvent[], now: number): Promise<void> {
  for (const e of events) await db.prepare("INSERT INTO eti_bitget_catalogue_events (at, category, change, symbol) VALUES (?, ?, ?, ?)").bind(e.at, e.category, e.change, e.symbol).run();
  if (events.length) await db.prepare("DELETE FROM eti_bitget_catalogue_events WHERE at < ?").bind(now - EVENT_RETENTION_MS).run();
}

export async function recentEvents(db: CatalogueDb, limit = 50): Promise<CatalogueEvent[]> {
  const { results } = await db.prepare("SELECT at, category, change, symbol FROM eti_bitget_catalogue_events ORDER BY at DESC, id DESC LIMIT ?").bind(Math.max(1, Math.min(500, limit))).all<Record<string, unknown>>();
  return (results ?? []).filter(r => isCatalogueCategory(r.category)).map(r => ({ at: Number(r.at), category: r.category as CatalogueCategory, change: r.change === "delisted" ? "delisted" : "listed", symbol: String(r.symbol) }));
}

export async function saveRun(db: CatalogueDb, run: CatalogueRun): Promise<void> {
  await db.prepare("INSERT INTO eti_bitget_catalogue_meta (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .bind(RUN_KEY, JSON.stringify(run), run.at).run();
}

export async function loadRun(db: CatalogueDb): Promise<CatalogueRun | null> {
  const { results } = await db.prepare("SELECT v FROM eti_bitget_catalogue_meta WHERE k = ?").bind(RUN_KEY).all<{ v: string }>();
  const v = results?.[0]?.v;
  if (!v) return null;
  try { const run = JSON.parse(v); return run && typeof run === "object" && Number.isFinite(run.at) ? run as CatalogueRun : null; } catch { return null; }
}

/** Rows of the stored snapshot for the given categories (used as a labelled fallback when Bitget cannot be reached). */
export async function snapshotRows(db: CatalogueDb, categories: CatalogueCategory[]): Promise<{ rows: SymbolRow[]; fetchedAt: number | null }> {
  const stored = await loadCategories(db);
  const rows: SymbolRow[] = []; let oldest: number | null = null;
  for (const c of categories) { const s = stored[c]; if (!s) continue; rows.push(...s.rows); oldest = oldest === null ? s.fetchedAt : Math.min(oldest, s.fetchedAt); }
  return { rows, fetchedAt: oldest };
}
