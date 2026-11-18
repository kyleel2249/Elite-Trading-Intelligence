// Every-minute Bitget catalogue sync: spot, the three futures product types (USDT / USDC / coin-margined) and the margin list.
//
// Guarantees (see docs/BITGET.md):
//  * The cron fetches all five categories bypassing every cache, persists the result in D1 and records listings / delistings.
//  * A category that fails to refresh keeps its last confirmed pairs ("carried", with its own age) instead of disappearing, and the run
//    is reported as not ok. Nothing is invented: a category never synced and unreachable reports "missing" with zero pairs.
//  * Unchanged lists cost only a one-row UPDATE per category; the large JSON payload is rewritten only when the content changes.
//  * Storage problems (D1 unbound, migration 0019 not applied) never stop the fetch; they are reported as storageError.
import { AllProvidersFailed, BITGET_PRODUCT_TYPES, bitgetRowCategory, listBitgetMarginSymbols, listBitgetSymbols, type SymbolRow } from "../market.ts";
import {
  CATALOGUE_CATEGORIES, loadCategories, loadRun, recentEvents, recordEvents, saveCategory, saveRun, touchCategory,
  type CatalogueCategory, type CatalogueDb, type CatalogueEvent, type CatalogueRun, type CategoryRun, type StoredCategory,
} from "./catalogue-store.ts";

export const CATALOGUE_INTERVAL_SECONDS = 60;
/** A category confirmed within this window counts as fresh: two missed one-minute ticks plus 30 s of slack. */
export const CATALOGUE_FRESH_SECONDS = 150;

export interface SyncDeps { fetchImpl?: typeof fetch; now?: () => number }
type Attempts = { host: string; errorClass: string | null }[];

const bySymbol = (a: SymbolRow, b: SymbolRow) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const errorFor = (category: string, attempts: Attempts): string =>
  attempts.find(a => a.host.endsWith(`(${category})`))?.errorClass ?? attempts.find(a => a.errorClass)?.errorClass ?? "refresh_failed";

interface Fetched { rows: SymbolRow[] | null; error: string | null }

/** Fetch every category independently; a failure of one never affects another. */
async function fetchAll(f: typeof fetch, now: () => number): Promise<Record<CatalogueCategory, Fetched>> {
  const out = Object.fromEntries(CATALOGUE_CATEGORIES.map(c => [c, { rows: null, error: "refresh_failed" } as Fetched])) as Record<CatalogueCategory, Fetched>;
  const [spot, futures, margin] = await Promise.allSettled([
    listBitgetSymbols("spot", f, now, { fresh: true }),
    listBitgetSymbols("futures", f, now, { fresh: true }),
    listBitgetMarginSymbols(f, now, { fresh: true }),
  ]);
  const thrown = (r: PromiseRejectedResult): Attempts => r.reason instanceof AllProvidersFailed ? r.reason.attempts : [{ host: "", errorClass: "catalogue_processing_error" }];
  if (spot.status === "fulfilled") {
    out.SPOT = spot.value.failed.includes("SPOT") ? { rows: null, error: errorFor("SPOT", spot.value.attempts) } : { rows: spot.value.rows, error: null };
  } else out.SPOT = { rows: null, error: errorFor("SPOT", thrown(spot)) };
  for (const pt of BITGET_PRODUCT_TYPES) {
    if (futures.status === "fulfilled") {
      out[pt] = futures.value.failed.includes(pt) ? { rows: null, error: errorFor(pt, futures.value.attempts) } : { rows: futures.value.rows.filter(r => bitgetRowCategory(r) === pt), error: null };
    } else out[pt] = { rows: null, error: errorFor(pt, thrown(futures)) };
  }
  if (margin.status === "fulfilled") out.MARGIN = margin.value.stale ? { rows: null, error: "refresh_failed" } : { rows: margin.value.rows, error: null };
  else out.MARGIN = { rows: null, error: errorFor("MARGIN", thrown(margin)) };
  return out;
}

/** Run one sync. Never throws: every problem is reported in the returned run. */
export async function runBitgetCatalogueSync(env: Record<string, any>, deps: SyncDeps = {}): Promise<CatalogueRun> {
  const now = deps.now ?? Date.now, started = now();
  const db = env.ETI_PORTFOLIO_DB as CatalogueDb | undefined;
  let storageError: string | null = db ? null : "d1_not_bound";
  let prior: Partial<Record<CatalogueCategory, StoredCategory>> = {};
  let previousRun: CatalogueRun | null = null;
  if (db) {
    try { prior = await loadCategories(db); previousRun = await loadRun(db); }
    catch (e) { storageError = "d1_unavailable_or_migration_0019_missing"; console.error("bitget catalogue: storage read failed", e instanceof Error ? e.message : e); }
  }
  const fetched = await fetchAll(deps.fetchImpl ?? fetch, now);

  const categories = {} as Record<CatalogueCategory, CategoryRun>;
  const events: CatalogueEvent[] = [];
  const writes: Array<() => Promise<void>> = [];
  for (const category of CATALOGUE_CATEGORIES) {
    const f = fetched[category], before = prior[category];
    if (!f.rows) {
      categories[category] = { status: before ? "carried" : "missing", count: before?.count ?? 0, added: 0, removed: 0, error: f.error };
      continue;
    }
    const rows = [...f.rows].sort(bySymbol), hash = await sha256(JSON.stringify(rows));
    const had = new Set((before?.rows ?? []).map(r => r.s)), has = new Set(rows.map(r => r.s));
    const added = before ? rows.filter(r => !had.has(r.s)).map(r => r.s) : [], removed = before ? (before.rows ?? []).filter(r => !has.has(r.s)).map(r => r.s) : [];
    for (const symbol of added) events.push({ at: started, category, change: "listed", symbol });
    for (const symbol of removed) events.push({ at: started, category, change: "delisted", symbol });
    categories[category] = { status: "ok", count: rows.length, added: added.length, removed: removed.length, error: null };
    if (!before || before.hash !== hash) writes.push(() => saveCategory(db!, category, rows, hash, started));
    else writes.push(() => touchCategory(db!, category, started));
  }

  let persisted = false;
  if (db && !storageError) {
    try { for (const w of writes) await w(); await recordEvents(db, events, started); persisted = true; }
    catch (e) { storageError = "d1_write_failed"; console.error("bitget catalogue: storage write failed", e instanceof Error ? e.message : e); }
  }
  const ok = CATALOGUE_CATEGORIES.every(c => categories[c].status === "ok");
  const run: CatalogueRun = {
    at: started, durationMs: Math.max(0, now() - started), ok, persisted, storageError,
    consecutiveFailures: ok ? 0 : (previousRun?.consecutiveFailures ?? 0) + 1, categories,
  };
  if (db && !storageError) { try { await saveRun(db, run); } catch (e) { run.storageError = "d1_write_failed"; console.error("bitget catalogue: run record failed", e instanceof Error ? e.message : e); } }
  if (!ok && (run.consecutiveFailures === 1 || run.consecutiveFailures % 15 === 0)) {
    // Error classes only; never response bodies or credentials. Logged on the first failure and every 15th so a long outage is not one line per minute.
    console.error("bitget catalogue sync degraded", run.consecutiveFailures, JSON.stringify(Object.fromEntries(CATALOGUE_CATEGORIES.filter(c => categories[c].status !== "ok").map(c => [c, `${categories[c].status}:${categories[c].error}`]))));
  }
  return run;
}

export type CatalogueState = "fresh" | "degraded" | "stale" | "never_synced";
/** Public status for GET /api/bitget/catalogue. Counts, ages and change history only: no credentials, no private data. */
export async function catalogueStatus(env: Record<string, any>, now = Date.now()) {
  const db = env.ETI_PORTFOLIO_DB as CatalogueDb | undefined;
  if (!db) return { status: 503, body: { error: "storage_not_configured", message: "ETI_PORTFOLIO_DB is not bound, so the catalogue cannot be persisted or reported." } };
  let stored: Partial<Record<CatalogueCategory, StoredCategory>>, run: CatalogueRun | null, changes: CatalogueEvent[];
  try { stored = await loadCategories(db); run = await loadRun(db); changes = await recentEvents(db, 50); }
  catch { return { status: 503, body: { error: "storage_unavailable", message: "The catalogue tables are unreadable; apply D1 migration 0019." } }; }
  const age = (t: number | undefined) => (t === undefined ? null : Math.max(0, Math.round((now - t) / 1000)));
  const cats = Object.fromEntries(CATALOGUE_CATEGORIES.map(c => {
    const s = stored[c], r = run?.categories?.[c];
    return [c, { pairs: s?.count ?? 0, confirmedAt: s ? new Date(s.fetchedAt).toISOString() : null, confirmedSecondsAgo: age(s?.fetchedAt), changedAt: s ? new Date(s.changedAt).toISOString() : null,
      lastRunStatus: r?.status ?? null, lastError: r?.error ?? null }];
  }));
  const confirmed = CATALOGUE_CATEGORIES.map(c => stored[c]?.fetchedAt);
  const allFresh = confirmed.every(t => t !== undefined && (now - t) / 1000 <= CATALOGUE_FRESH_SECONDS);
  const runFresh = !!run && (now - run.at) / 1000 <= CATALOGUE_FRESH_SECONDS;
  // fresh = every category confirmed recently AND the last run succeeded; degraded = recent activity but a failed run or an old category; stale = nothing recent.
  const state: CatalogueState = !run && !confirmed.some(t => t !== undefined) ? "never_synced" : allFresh && run?.ok === true ? "fresh" : runFresh || allFresh ? "degraded" : "stale";
  const sum = (keys: CatalogueCategory[]) => keys.reduce((n, k) => n + (stored[k]?.count ?? 0), 0);
  return { status: 200, body: {
    venue: "bitget", state, intervalSeconds: CATALOGUE_INTERVAL_SECONDS, freshWithinSeconds: CATALOGUE_FRESH_SECONDS,
    lastRunAt: run ? new Date(run.at).toISOString() : null, lastRunSecondsAgo: age(run?.at), lastRunOk: run?.ok ?? null, lastRunDurationMs: run?.durationMs ?? null,
    consecutiveFailures: run?.consecutiveFailures ?? 0, persisted: run?.persisted ?? null, storageError: run?.storageError ?? null,
    totals: { spot: sum(["SPOT"]), futures: sum(["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]), margin: sum(["MARGIN"]) },
    categories: cats, recentChanges: changes.map(e => ({ at: new Date(e.at).toISOString(), category: e.category, change: e.change, symbol: e.symbol })),
    note: "Pairs come from Bitget's public instrument lists. 'listed' / 'delisted' are changes seen between two successful refreshes by this server, not Bitget's own listing times.",
  } };
}
