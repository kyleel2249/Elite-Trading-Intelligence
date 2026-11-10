// Universe-wide market scanning. The universe is built from the exchange's own 24h ticker list (one request), filtered for liquidity
// and tradability, then analysed in small rotating batches (Workers cap subrequests per invocation, ~10 per symbol). Results persist in
// KV, so a leaderboard covers the whole universe over time. Rows carry their age; rows older than the staleness limit are never ranked.
// Read-only analysis: nothing here places an order. Pre-selection uses only liquidity, never an opinion about direction.
import type { MarketEnv } from "../market.ts";
import { BINANCE_HOSTS } from "./replay-io.ts";
import { scan, rankRows, type ScanRow } from "./scan.ts";
import type { Strategy } from "./timeframes.ts";

export const UNIVERSE_KEY = "algo:universe:v1";
export const UNIVERSE_CRON = "*/5 * * * *";
type KV = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
export interface Ticker { symbol: string; lastPrice: number; quoteVolume: number; trades: number; bid: number; ask: number; changePct: number }
export interface UniverseConfig { quote: string; minQuoteVolume: number; minTrades: number; maxSpreadBps: number; maxSymbols: number; batch: number; staleMs: number; refreshMs: number }
export const DEFAULTS: UniverseConfig = { quote: "USDT", minQuoteVolume: 5_000_000, minTrades: 5_000, maxSpreadBps: 25, maxSymbols: 150, batch: 3, staleMs: 8 * 3600_000, refreshMs: 6 * 3600_000 };
export const MAX_BATCH = 25, MAX_UNIVERSE = 300;
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USDE", "USD1", "AEUR", "EUR", "EURI", "UST", "USDS", "PAXG_"]);
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;
export interface UniverseState { version: 1; strategy: Strategy; builtAt: number; config: UniverseConfig; symbols: { symbol: string; quoteVolume: number; changePct: number }[]; rejected: Record<string, number>; rows: Record<string, ScanRow & { analysedAt: number }> }

export function configFrom(env: Record<string, unknown>): UniverseConfig {
  const n = (k: string, d: number, lo: number, hi: number) => { const v = Number(env[k]); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
  return { ...DEFAULTS, minQuoteVolume: n("ETI_UNIVERSE_MIN_QUOTE_VOLUME", DEFAULTS.minQuoteVolume, 0, 1e12), maxSymbols: Math.floor(n("ETI_UNIVERSE_MAX_SYMBOLS", DEFAULTS.maxSymbols, 1, MAX_UNIVERSE)), batch: Math.floor(n("ETI_UNIVERSE_BATCH", DEFAULTS.batch, 1, MAX_BATCH)), maxSpreadBps: n("ETI_UNIVERSE_MAX_SPREAD_BPS", DEFAULTS.maxSpreadBps, 0.1, 1000) };
}

/** Pure: filter raw tickers into a ranked, liquid universe and count why symbols were excluded. */
export function buildUniverse(tickers: Ticker[], cfg: UniverseConfig = DEFAULTS): { symbols: UniverseState["symbols"]; rejected: Record<string, number> } {
  const rej: Record<string, number> = {}, bad = (k: string) => { rej[k] = (rej[k] ?? 0) + 1; }, keep: Ticker[] = [];
  for (const t of tickers) {
    if (!/^[A-Z0-9]{5,20}$/.test(t.symbol) || !t.symbol.endsWith(cfg.quote)) { bad("other_quote"); continue; }
    const base = t.symbol.slice(0, -cfg.quote.length);
    if (STABLES.has(base) || LEVERAGED.test(base) && base.length > 4) { bad("stable_or_leveraged"); continue; }
    if (!(t.lastPrice > 0) || !(t.bid > 0) || !(t.ask >= t.bid)) { bad("no_valid_quote"); continue; }
    if (t.quoteVolume < cfg.minQuoteVolume) { bad("low_volume"); continue; }
    if (t.trades < cfg.minTrades) { bad("few_trades"); continue; }
    if ((t.ask - t.bid) / ((t.ask + t.bid) / 2) * 1e4 > cfg.maxSpreadBps) { bad("wide_spread"); continue; }
    keep.push(t);
  }
  keep.sort((a, b) => b.quoteVolume - a.quoteVolume || a.symbol.localeCompare(b.symbol));
  if (keep.length > cfg.maxSymbols) rej.beyond_cap = keep.length - cfg.maxSymbols;
  return { symbols: keep.slice(0, cfg.maxSymbols).map(t => ({ symbol: t.symbol, quoteVolume: t.quoteVolume, changePct: t.changePct })), rejected: rej };
}

export function parseTickers(raw: unknown): Ticker[] {
  if (!Array.isArray(raw) || raw.length < 10) throw new Error("ticker_list_invalid");
  const num = (x: unknown) => { const v = Number(x); return Number.isFinite(v) ? v : NaN; };
  return raw.filter(r => r && typeof r === "object" && typeof (r as any).symbol === "string").map((r: any) => ({ symbol: r.symbol, lastPrice: num(r.lastPrice), quoteVolume: num(r.quoteVolume), trades: num(r.count), bid: num(r.bidPrice), ask: num(r.askPrice), changePct: num(r.priceChangePercent) }));
}
export async function fetchTickers(fetchImpl: typeof fetch = fetch): Promise<Ticker[]> {
  const errs: string[] = [];
  for (const host of BINANCE_HOSTS) {
    try { const r = await fetchImpl(`${host}/api/v3/ticker/24hr`, { headers: { accept: "application/json" } }); if (!r.ok) { errs.push(`${host} HTTP ${r.status}`); continue; } return parseTickers(await r.json()); }
    catch (e) { errs.push(`${host} ${e instanceof Error ? e.message : "error"}`); }
  }
  throw new Error("ticker_unavailable: " + errs.join("; "));
}

/** Pure: which symbols to analyse next. Never-analysed first, then active movers that have not been looked at for an hour, then the stalest. */
export function nextBatch(state: Pick<UniverseState, "symbols" | "rows">, now: number, batch: number): string[] {
  const score = (s: UniverseState["symbols"][number]) => { const r = state.rows[s.symbol]; if (!r) return -Infinity; const age = now - r.analysedAt; return Math.abs(s.changePct) >= 4 && age > 3600_000 ? -age - 1e12 : -age; };
  return [...state.symbols].sort((a, b) => score(a) - score(b) || b.quoteVolume - a.quoteVolume).slice(0, batch).map(s => s.symbol);
}

export interface Coverage { universeSize: number; fresh: number; stale: number; neverAnalysed: number; errors: number; oldestAgeMs: number | null; builtAt: string | null; strategy: Strategy | null; rejected: Record<string, number> }
export function leaderboardOf(state: UniverseState | null, now: number, limit = 25): { leaderboard: ScanRow[]; coverage: Coverage; actionable: number } {
  if (!state) return { leaderboard: [], actionable: 0, coverage: { universeSize: 0, fresh: 0, stale: 0, neverAnalysed: 0, errors: 0, oldestAgeMs: null, builtAt: null, strategy: null, rejected: {} } };
  const all = state.symbols.map(s => state.rows[s.symbol]), seen = all.filter(Boolean), fresh = seen.filter(r => now - r.analysedAt <= state.config.staleMs);
  const ranked = rankRows(fresh.map(({ analysedAt: _a, ...r }) => r)), act = ranked.filter(r => r.rank !== null);
  return { leaderboard: [...act, ...ranked.filter(r => r.rank === null && r.decision !== "DATA_UNRELIABLE" && r.decision !== "ERROR")].slice(0, limit), actionable: act.length,
    coverage: { universeSize: state.symbols.length, fresh: fresh.length, stale: seen.length - fresh.length, neverAnalysed: all.length - seen.length, errors: fresh.filter(r => r.decision === "DATA_UNRELIABLE" || r.decision === "ERROR").length, oldestAgeMs: seen.length ? Math.max(...seen.map(r => now - r.analysedAt)) : null, builtAt: new Date(state.builtAt).toISOString(), strategy: state.strategy, rejected: state.rejected } };
}

export async function loadUniverse(kv: KV): Promise<UniverseState | null> {
  const raw = await kv.get(UNIVERSE_KEY); if (!raw) return null;
  try { const s = JSON.parse(raw) as UniverseState; return s?.version === 1 && Array.isArray(s.symbols) && s.rows && typeof s.rows === "object" ? s : null; } catch { return null; }
}

export interface BatchResult { refreshedUniverse: boolean; universeError?: string; analysed: string[]; errors: string[]; coverage: Coverage }
/** One bounded pass: refresh the universe if it is missing or old, then analyse the next batch and persist. */
export async function runUniverseBatch(env: MarketEnv & Record<string, any>, kv: KV, now: number, strategy: Strategy = "intraday", deps: { fetchImpl?: typeof fetch; analyse?: typeof scan } = {}): Promise<BatchResult> {
  const cfg = configFrom(env as any); let state = await loadUniverse(kv), refreshed = false, universeError: string | undefined;
  if (!state || now - state.builtAt > cfg.refreshMs || state.strategy !== strategy) {
    try {
      const u = buildUniverse(await fetchTickers(deps.fetchImpl), cfg), keep = new Set(u.symbols.map(s => s.symbol)), rows: UniverseState["rows"] = {};
      if (state && state.strategy === strategy) for (const [k, v] of Object.entries(state.rows)) if (keep.has(k)) rows[k] = v;
      if (!u.symbols.length) throw new Error("universe_empty_after_filters");
      state = { version: 1, strategy, builtAt: now, config: cfg, symbols: u.symbols, rejected: u.rejected, rows }; refreshed = true;
    } catch (e) { universeError = e instanceof Error ? e.message : "universe_error"; if (!state) return { refreshedUniverse: false, universeError, analysed: [], errors: [], coverage: leaderboardOf(null, now).coverage }; }
  }
  state = { ...state!, config: { ...state!.config, batch: cfg.batch, staleMs: cfg.staleMs } };
  const analyse = deps.analyse ?? scan, analysed: string[] = [], errors: string[] = [];
  for (const symbol of nextBatch(state, now, cfg.batch)) {
    try { const [row] = await analyse(env, [symbol], strategy, now); if (!row) throw new Error("no_row"); state.rows[symbol] = { ...row, rank: null, analysedAt: now }; analysed.push(symbol); if (row.decision === "DATA_UNRELIABLE" || row.decision === "ERROR") errors.push(symbol); }
    catch (e) { errors.push(symbol); state.rows[symbol] = { rank: null, symbol, decision: "ERROR", direction: null, opportunityScore: null, validationScore: null, confidence: 0, riskRewardToTP3: null, agreement: null, liquidity: null, entryZone: null, stopLoss: null, reason: e instanceof Error ? e.message.slice(0, 120) : "error", analysedAt: now } as any; }
  }
  await kv.put(UNIVERSE_KEY, JSON.stringify(state));
  return { refreshedUniverse: refreshed, universeError, analysed, errors, coverage: leaderboardOf(state, now).coverage };
}
