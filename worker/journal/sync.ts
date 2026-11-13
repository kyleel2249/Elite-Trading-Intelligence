/**
 * ETI AUTONOMOUS TRADE JOURNAL: backfill/sync. Idempotent: every entry has a deterministic id, so re-running never duplicates and
 * anything a live hook missed is picked up here. It only READS the ledger and execution records and APPENDS journal entries.
 */
import { openStore, type KVL } from "../portfolio/store.ts";
import type { Environment, Ledger } from "../portfolio/ledger.ts";
import { openJournal, sha256, type JournalEnv, type JournalStore, type NewEntry } from "./store.ts";
import { fromExecutionRecord, fromRejection, idForRejection } from "./record.ts";
import { getMarketData, providerOrder, type Kline } from "../market.ts";

export type SyncEnv = JournalEnv & { [k: string]: any };
export interface SyncResult { ok: boolean; added: number; scanned: number; byKind: Record<string, number>; errors: string[]; predictionsEvaluated: number; at: number }

const ENVS: Environment[] = ["internal_paper", "exchange_testnet"];
const MAX_NEW_PER_RUN = 400;

function ledgerEntries(environment: Environment, L: Ledger): NewEntry[] {
  const out: NewEntry[] = [], tradeOf = (orderId: string) => L.orders[orderId]?.clientOrderId ?? orderId;
  for (const o of Object.values(L.orders)) {
    out.push({ id: `lo:${environment}:${o.orderId}:submitted`, at: o.createdAt, kind: "order_submitted", tradeId: o.clientOrderId, symbol: o.symbol, environment, source: "eti_auto", actor: "eti",
      data: { outcome: o.status === "open" || o.status === "pending" ? "resting" : "executed", side: o.side, type: o.type, quantity: o.qty, limitPrice: o.limitPrice, broker: o.venue, brokerOrderId: o.brokerOrderId, strategy: o.strategy, signalId: o.signalId, reason: o.reason, simulated: environment === "internal_paper", via: "ledger", orderId: o.orderId } });
    if (o.status === "cancelled" || o.status === "expired" || o.status === "rejected") {
      const kind = o.status === "cancelled" ? "order_cancelled" : o.status === "expired" ? "order_expired" : "order_broker_rejected";
      out.push({ id: `lo:${environment}:${o.orderId}:${o.status}`, at: o.updatedAt, kind, tradeId: o.clientOrderId, symbol: o.symbol, environment, source: "eti_auto", actor: "eti", data: { reason: o.statusReason, reasons: o.statusReason ? [o.statusReason] : [], filledQty: o.filledQty, via: "ledger" } });
    }
  }
  for (const f of Object.values(L.fills)) {
    const o = L.orders[f.orderId];
    out.push({ id: `fill:${environment}:${f.fillId}`, at: f.at, kind: "fill", tradeId: tradeOf(f.orderId), symbol: f.symbol, environment, source: "eti_auto", actor: "eti",
      data: { side: f.side, qty: f.qty, price: f.price, fee: f.fee, feeAsset: f.feeAsset, slippageBps: f.slippageBps, verified: f.verified, origin: f.origin, partial: !!o && o.filledQty < o.qty, via: "ledger" } });
  }
  for (const t of L.closed) {
    const entryOrder = t.fills[0]?.orderId, tradeId = entryOrder ? tradeOf(entryOrder) : t.id;
    out.push({ id: `close:${environment}:${t.id}`, at: t.exitAt, kind: "trade_closed", tradeId, symbol: t.symbol, environment, source: "eti_auto", actor: "eti",
      data: { qty: t.qty, entryPrice: t.entryPrice, exitPrice: t.exitPrice, entryAt: t.entryAt, exitAt: t.exitAt, holdingMs: t.holdingMs, gross: t.gross, fees: t.fees, net: t.net, unknownFees: t.unknownFees, slippageCost: t.slippageCost, strategy: t.strategy, signalId: t.signalId, result: t.result, via: "ledger" } });
  }
  return out;
}


/** Sports paper betting (separate "sports_paper" environment): every bet, settlement and model prediction, including losses and misses. */
async function sportsEntries(d: any): Promise<NewEntry[]> {
  const out: NewEntry[] = [];
  const bets = (await d.prepare("SELECT id,created_at,event_name,market,selection,odds,model_probability,stake_cents,status,profit_cents,settled_at,event_id,bookmaker,model_version FROM sports_bets ORDER BY created_at ASC LIMIT 2000").all()).results ?? [];
  for (const b of bets) {
    const tradeId = "sb-" + b.id, symbol = String(b.event_name ?? "").slice(0, 80) || null, stake = Number(b.stake_cents) / 100;
    out.push({ id: `sb:${b.id}:placed`, at: Number(b.created_at), kind: "order_submitted", tradeId, symbol, environment: "sports_paper", source: "eti_auto", actor: "eti_sports",
      data: { outcome: "executed", side: "back " + b.selection, type: b.market, quantity: stake, fillPrice: Number(b.odds), broker: b.bookmaker, strategy: b.model_version, simulated: true, modelProbability: Number(b.model_probability), via: "sports" } });
    if (b.status === "WON" || b.status === "LOST") {
      const profit = Number(b.profit_cents) / 100;
      out.push({ id: `sb:${b.id}:closed`, at: Number(b.settled_at) || Number(b.created_at), kind: "trade_closed", tradeId, symbol, environment: "sports_paper", source: "eti_auto", actor: "eti_sports",
        data: { qty: stake, entryPrice: Number(b.odds), exitPrice: null, gross: profit, fees: 0, net: profit, unknownFees: 0, strategy: b.model_version, result: b.status === "WON" ? "win" : "loss", via: "sports" } });
    } else if (b.status === "VOID") out.push({ id: `sb:${b.id}:void`, at: Number(b.settled_at) || Number(b.created_at), kind: "order_cancelled", tradeId, symbol, environment: "sports_paper", source: "eti_auto", actor: "eti_sports", data: { reason: "bet voided: stake returned", reasons: ["bet voided: stake returned"], via: "sports" } });
  }
  const preds = (await d.prepare("SELECT id,fixture_id,created_at,competition,home_team,away_team,p_home,p_draw,p_away,best_selection,best_odds,expected_value,recommended_stake_cents,decision,model_version,actual_outcome,settled_at FROM sports_model_predictions ORDER BY created_at ASC LIMIT 2000").all()).results ?? [];
  for (const p of preds) {
    const tradeId = "sp-" + p.fixture_id, symbol = `${p.home_team} vs ${p.away_team}`.slice(0, 80), aid = `sp:${p.id}`;
    out.push({ id: aid, at: Number(p.created_at), kind: "analysis", tradeId, symbol, environment: "sports_paper", source: "eti_auto", actor: "eti_sports",
      data: { decision: String(p.decision ?? "NO_BET"), strategy: p.model_version, probabilities: { home: Number(p.p_home), draw: Number(p.p_draw), away: Number(p.p_away) }, bestSelection: p.best_selection, bestOdds: p.best_odds, expectedValue: p.expected_value, recommendedStakeCents: p.recommended_stake_cents, competition: p.competition, via: "sports" } });
    if (p.actual_outcome) {
      const pick = Number(p.p_home) >= Number(p.p_draw) && Number(p.p_home) >= Number(p.p_away) ? "H" : Number(p.p_away) >= Number(p.p_draw) ? "A" : "D";
      out.push({ id: `sp:${p.id}:eval`, at: Number(p.settled_at) || Number(p.created_at), kind: "prediction_evaluated", tradeId, symbol, environment: "sports_paper", source: "derived", actor: "eti_evaluator",
        data: { analysisId: aid, outcome: pick === p.actual_outcome ? "hit" : "miss", reason: `most likely outcome ${pick}, actual ${p.actual_outcome}`, via: "sports" } });
    }
  }
  return out;
}

async function listAll(kv: KVL, prefix: string, cap = 2000): Promise<string[]> {
  const keys: string[] = []; let cursor: string | undefined;
  for (let i = 0; i < 20 && keys.length < cap; i++) { const r = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) }); keys.push(...r.keys.map(k => k.name)); if (r.list_complete !== false || !r.cursor) break; cursor = r.cursor; }
  return keys.slice(0, cap);
}

export async function syncJournal(env: SyncEnv, now = Date.now(), opts: { evaluate?: boolean; fetchImpl?: typeof fetch } = {}): Promise<SyncResult> {
  const res: SyncResult = { ok: true, added: 0, scanned: 0, byKind: {}, errors: [], predictionsEvaluated: 0, at: now }, st = openJournal(env);
  if (!st) return { ...res, ok: false, errors: ["journal_storage_not_configured"] };
  const put = async (n: NewEntry) => { res.scanned++; if (res.added >= MAX_NEW_PER_RUN) return; const r = await st.append(n, now); if (r.created) { res.added++; res.byKind[n.kind] = (res.byKind[n.kind] ?? 0) + 1; } };
  const guarded = async (label: string, f: () => Promise<void>) => { try { await f(); } catch (e) { res.ok = false; res.errors.push(label + ": " + (e instanceof Error ? e.message : "failed")); } };

  for (const environment of ENVS) await guarded("ledger:" + environment, async () => {
    const ps = openStore(env as any, environment); if (!ps) return;
    const { ledger } = await ps.ledger();
    for (const n of ledgerEntries(environment, ledger)) {
      // the order flow journals its own richer submitted record; skip the ledger duplicate when that one already exists
      if (n.kind === "order_submitted" && n.tradeId) { const d: any = n.data; if (await st.get(`ord:${n.tradeId}:executed`) || await st.get(`ord:${n.tradeId}:resting`)) { res.scanned++; continue; } void d; }
      await put(n);
    }
    for (const a of ledger.anomalies ?? []) await put({ id: `anom:${environment}:` + (await sha256(JSON.stringify(a))).slice(0, 16), at: a.at, kind: "anomaly", tradeId: null, symbol: null, environment, source: "eti_auto", actor: "eti", data: { kind: a.kind, detail: a.detail, ref: a.ref ?? null } });
  });

  await guarded("sports", async () => { const d = (env as any).ETI_PORTFOLIO_DB; if (!d) return; let rows: NewEntry[]; try { rows = await sportsEntries(d); } catch { return; /* sports tables not present: nothing to journal */ } for (const n of rows) await put(n); });

  const kv = env.ETI_EXECUTION_LOG as KVL | undefined;
  if (kv) {
    await guarded("rejections", async () => { for (const key of await listAll(kv, "reject:")) { if (res.added >= MAX_NEW_PER_RUN) break; if (await st.get(idForRejection(key))) { res.scanned++; continue; } const raw = await kv.get(key); if (!raw) continue; let rec: any; try { rec = JSON.parse(raw); } catch { continue; } await put(fromRejection(key, rec)); } });
    await guarded("order_records", async () => { for (const prefix of ["order:", "exec:paper:rec:"]) for (const key of await listAll(kv, prefix)) { if (res.added >= MAX_NEW_PER_RUN) break; const raw = await kv.get(key); if (!raw) continue; let rec: any; try { rec = JSON.parse(raw); } catch { continue; } if (!rec?.clientOrderId) continue; await put(fromExecutionRecord(rec)); } });
    await guarded("paper_engine", async () => {
      const raw = await kv.get("eti:paper:state"); if (!raw) return; const s = JSON.parse(raw);
      for (const t of Array.isArray(s?.closed) ? s.closed : []) {
        if (!t?.id || typeof t.pnl !== "number") continue;
        await put({ id: "pe:close:" + t.id, at: Number(t.closedAt) || now, kind: "trade_closed", tradeId: "pe-" + t.id, symbol: t.symbol ?? null, environment: "internal_paper", source: "eti_auto", actor: "paper_engine",
          data: { entryAt: t.openedAt ?? null, exitAt: t.closedAt ?? null, holdingMs: t.openedAt && t.closedAt ? t.closedAt - t.openedAt : null, gross: null, fees: typeof t.fees === "number" ? t.fees : null, net: t.pnl, unknownFees: 0, slippageCost: typeof t.slippage === "number" ? t.slippage : null,
            strategy: t.engine ?? null, riskAmount: typeof t.riskAmount === "number" ? t.riskAmount : null, confidence: t.confidence ?? null, result: t.pnl > 0 ? "win" : t.pnl < 0 ? "loss" : "breakeven", via: "paper_engine" } });
      }
    });
  }
  if (opts.evaluate !== false) await guarded("predictions", async () => { res.predictionsEvaluated = await evaluatePredictions(env, st, now, opts.fetchImpl); });
  await st.setMeta("lastSync", { at: now, added: res.added, ok: res.ok });
  return res;
}

/**
 * Judge each BUY/SELL analysis against what the market then did (1h candles). Misses are recorded exactly like hits.
 * hit = first target reached before the stop; miss = stop reached first, or horizon passed without the target; ambiguous candle = stop first (conservative).
 */
export function judge(a: { decision: string; entryZone: [number, number] | null; stop: number | null; targets: (number | null)[]; referencePrice: number | null }, bars: Kline[]): { outcome: "hit" | "miss" | "inconclusive"; reason: string } {
  const long = String(a.decision).toUpperCase() === "BUY", tp = a.targets.find(t => typeof t === "number") as number | undefined;
  if (!bars.length) return { outcome: "inconclusive", reason: "no market data available for the period" };
  if (tp === undefined || a.stop == null) return { outcome: "inconclusive", reason: "analysis had no stop or target to judge against" };
  for (const k of bars) {
    const hi = k[2], lo = k[3], stopHit = long ? lo <= a.stop : hi >= a.stop, tpHit = long ? hi >= tp : lo <= tp;
    if (stopHit) return { outcome: "miss", reason: tpHit ? "stop and target in the same candle: counted as stop first" : "stop reached before the target" };
    if (tpHit) return { outcome: "hit", reason: "first target reached before the stop" };
  }
  return { outcome: "miss", reason: "neither level reached within the horizon" };
}
async function evaluatePredictions(env: SyncEnv, st: JournalStore, now: number, fetchImpl?: typeof fetch): Promise<number> {
  const { entries } = await st.all(), done = new Set(entries.filter(e => e.kind === "prediction_evaluated").map(e => String((e.data as any).analysisId)));
  const due = entries.filter(e => e.kind === "analysis" && ["BUY", "SELL"].includes(String((e.data as any).decision).toUpperCase()) && !done.has(e.id) && now - e.at >= ((e.data as any).horizonMs ?? 6 * 3600_000)).slice(0, 25);
  let n = 0;
  for (const a of due) {
    const d: any = a.data, horizon = d.horizonMs ?? 6 * 3600_000; let bars: Kline[] = [];
    try { const r = await getMarketData("klines", { symbol: a.symbol!, interval: "1h", limit: 200 }, providerOrder(env as any, null)); bars = (r.data as Kline[]).filter(k => k[0] >= a.at - 3600_000 && k[0] <= a.at + horizon); } catch { bars = []; }
    const j = judge({ decision: d.decision, entryZone: d.entryZone ?? null, stop: d.stop ?? null, targets: d.targets ?? [], referencePrice: d.referencePrice ?? null }, bars);
    if (j.outcome === "inconclusive" && bars.length === 0 && now - a.at < horizon + 24 * 3600_000 && !(d.stop == null)) continue; // data may arrive later; retry next run
    const r = await st.append({ id: "eval:" + a.id, at: now, kind: "prediction_evaluated", tradeId: a.tradeId, symbol: a.symbol, environment: a.environment, source: "derived", actor: "eti_evaluator", data: { analysisId: a.id, outcome: j.outcome, reason: j.reason, barsUsed: bars.length, horizonMs: horizon } }, now);
    if (r.created) n++;
  }
  return n;
}

/** Cron entry point: never throws. */
export const SYNC_INTERVAL_MS = 5 * 60_000;
export async function runJournalCycle(env: SyncEnv, now = Date.now()): Promise<SyncResult | null> {
  try { const st = openJournal(env); if (!st) return null; const last = await st.meta<{ at?: number } | null>("lastSync", null); if (last?.at && now - last.at < SYNC_INTERVAL_MS) return null; return await syncJournal(env, now); } catch (e) { console.error(JSON.stringify({ level: "error", event: "journal_cycle_failed", error: e instanceof Error ? e.message : "unknown" })); return null; }
}
