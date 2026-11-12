/**
 * ETI AUTONOMOUS TRADE JOURNAL: what gets written. Builders turn an ETI record (an order outcome, a refusal, an analysis, a closed trade)
 * into a journal entry with a DETERMINISTIC id. The live hooks and the backfill job both use these builders, so a record is journaled
 * exactly once no matter how many times either runs, and nothing is ever omitted when a hook failed.
 * Nothing here invents data: every field is copied from the originating record; unknown values stay null.
 */
import { openJournal, sha256, type JournalEnv, type JournalEntry, type NewEntry } from "./store.ts";

export const KINDS = ["analysis", "prediction_evaluated", "order_submitted", "order_rejected", "order_broker_rejected", "order_outcome_unknown", "fill", "order_cancelled", "order_expired",
  "trade_closed", "manual_trade", "note", "strategy_event", "anomaly", "insight"] as const;
export type Kind = typeof KINDS[number];
const SYMBOL = /^[A-Z0-9._-]{2,24}$/;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : null);

/** Write an entry; NEVER throws (a journal failure must not block or fail a trade). A failure is logged and left for the backfill job. */
export async function log(env: JournalEnv, n: NewEntry, now = Date.now()): Promise<JournalEntry | null> {
  try { const st = openJournal(env); if (!st) return null; return (await st.append(n, now)).entry; }
  catch (e) { console.error(JSON.stringify({ level: "error", event: "journal_write_failed", id: n.id, kind: n.kind, error: e instanceof Error ? e.message : "unknown" })); return null; }
}

export const idForRejection = (key: string) => "rej:" + key;
/** From a stored `reject:` record (worker/safeguards.ts RejectionRecord). Covers refusals AND broker rejections / unknown outcomes recorded there. */
export function fromRejection(key: string, rec: any): NewEntry {
  const req = rec?.request ?? {}, at = Date.parse(rec?.at) || Date.now(), outcome = rec?.outcome ?? "rejected";
  const kind: Kind = outcome === "broker_rejected" ? "order_broker_rejected" : outcome === "unknown" ? "order_outcome_unknown" : "order_rejected";
  const tradeId = typeof req.clientOrderId === "string" && req.clientOrderId ? req.clientOrderId : "rej-" + key.slice(-12);
  return { id: idForRejection(key), at, kind, tradeId, symbol: typeof req.symbol === "string" ? req.symbol.toUpperCase() : null, environment: rec?.environment ?? null, source: "eti_auto", actor: str(rec?.executionSource?.actorId, 120) ?? "eti",
    data: { outcome, stage: rec?.stage ?? null, error: rec?.error ?? null, reasons: Array.isArray(rec?.reasons) ? rec.reasons.slice(0, 20) : [], brokerContacted: !!rec?.brokerContacted, brokerResponse: rec?.brokerResponse ?? null, mode: rec?.mode ?? null, request: req, executionSource: rec?.executionSource ?? null, via: "order_flow" } };
}

/** From a stored executed-order record (`order:` for exchange paper/testnet, `exec:paper:rec:` for internal paper). */
export function fromExecutionRecord(rec: any): NewEntry {
  const at = Date.parse(rec?.executedAt) || Date.now(), cid = String(rec?.clientOrderId ?? "unknown");
  return { id: "ord:" + cid + ":" + (rec?.outcome === "resting" ? "resting" : "executed"), at, kind: "order_submitted", tradeId: cid, symbol: str(rec?.symbol, 24), environment: rec?.environment ?? null, source: "eti_auto", actor: str(rec?.executionSource?.actorId, 120) ?? "eti",
    data: { outcome: rec?.outcome ?? "executed", side: rec?.side ?? null, type: rec?.type ?? null, quantity: num(rec?.quantity), limitPrice: num(rec?.limitPrice), broker: rec?.broker ?? null, simulated: !!rec?.simulated, exchangeOrderPlaced: !!rec?.exchangeOrderPlaced,
      brokerOrderId: rec?.brokerOrderId ?? null, brokerStatus: rec?.brokerStatus ?? null, marketPrice: num(rec?.marketPrice), fillPrice: num(rec?.fillPrice), notionalUsd: num(rec?.notionalUsd), readiness: rec?.readiness ?? null,
      preTrade: rec?.safeguards?.preTrade ?? null, plan: rec?.plan ?? null, fallback: rec?.fallback ?? null, executionSource: rec?.executionSource ?? null, via: "order_flow" } };
}

/** A decision/prediction BEFORE any order: BUY/SELL/NO_TRADE/WATCH with the evidence that produced it. NO_TRADE decisions are journaled too. */
export interface AnalysisInput { tradeId?: string | null; symbol: string; decision: string; strategy?: string | null; confidence?: number | null; entryZone?: [number, number] | null; stop?: number | null; targets?: (number | null)[]; referencePrice?: number | null;
  horizonMs?: number | null; rationale?: string[]; evidence?: unknown; environment?: string | null; actor?: string; signalId?: string | null; at?: number }
export async function fromAnalysis(a: AnalysisInput): Promise<NewEntry> {
  const at = a.at ?? Date.now(), sym = a.symbol.toUpperCase();
  const body = { symbol: sym, decision: a.decision, strategy: a.strategy ?? null, confidence: num(a.confidence), entryZone: a.entryZone ?? null, stop: num(a.stop), targets: (a.targets ?? []).map(num), referencePrice: num(a.referencePrice), horizonMs: num(a.horizonMs), signalId: a.signalId ?? null };
  const tradeId = a.tradeId || "ana-" + (await sha256(JSON.stringify([at, body]))).slice(0, 20);
  return { id: "ana:" + tradeId + ":" + (await sha256(JSON.stringify(body))).slice(0, 12), at, kind: "analysis", tradeId, symbol: sym, environment: a.environment ?? null, source: "eti_auto", actor: a.actor ?? "eti",
    data: { ...body, rationale: (a.rationale ?? []).slice(0, 20).map(s => String(s).slice(0, 300)), evidence: a.evidence ?? null } };
}

/** User-recorded trade (any venue, including ones ETI did not place). Closed manual trades carry their own exit so P&L is computed, never typed in. */
export interface ManualInput { symbol: string; side: "buy" | "sell"; quantity: number; entryPrice: number; entryAt?: number; exitPrice?: number | null; exitAt?: number | null; fees?: number | null; venue?: string; strategy?: string | null; stop?: number | null; targets?: (number | null)[]; reason?: string; notes?: string; clientRef?: string }
export function validateManual(b: any): { ok: true; v: ManualInput } | { ok: false; error: string } {
  const symbol = typeof b?.symbol === "string" ? b.symbol.toUpperCase() : "";
  if (!SYMBOL.test(symbol)) return { ok: false, error: "invalid_symbol" };
  if (b.side !== "buy" && b.side !== "sell") return { ok: false, error: "invalid_side" };
  const q = Number(b.quantity), ep = Number(b.entryPrice); if (!(q > 0) || !(ep > 0) || !Number.isFinite(q + ep)) return { ok: false, error: "invalid_quantity_or_price" };
  const hasExit = b.exitPrice !== undefined && b.exitPrice !== null && b.exitPrice !== "";
  const xp = hasExit ? Number(b.exitPrice) : null; if (hasExit && !(xp! > 0 && Number.isFinite(xp!))) return { ok: false, error: "invalid_exit_price" };
  const now = Date.now(), ea = b.entryAt === undefined ? now : Number(b.entryAt), xa = hasExit ? (b.exitAt === undefined || b.exitAt === null ? now : Number(b.exitAt)) : null;
  if (!Number.isFinite(ea) || ea > now + 60_000) return { ok: false, error: "invalid_entry_time" };
  if (hasExit && (!Number.isFinite(xa!) || xa! < ea || xa! > now + 60_000)) return { ok: false, error: "invalid_exit_time" };
  const fees = b.fees === undefined || b.fees === null || b.fees === "" ? null : Number(b.fees); if (fees !== null && !(fees >= 0 && Number.isFinite(fees))) return { ok: false, error: "invalid_fees" };
  return { ok: true, v: { symbol, side: b.side, quantity: q, entryPrice: ep, entryAt: ea, exitPrice: xp, exitAt: xa, fees, venue: str(b.venue, 60) ?? "manual", strategy: str(b.strategy, 60), stop: b.stop == null || b.stop === "" ? null : Number(b.stop),
    targets: Array.isArray(b.targets) ? b.targets.map((t: unknown) => (t == null || t === "" ? null : Number(t))) : [], reason: str(b.reason, 1000) ?? undefined, notes: str(b.notes, 2000) ?? undefined, clientRef: str(b.clientRef, 60) ?? undefined } };
}
export async function fromManual(m: ManualInput, actor: string): Promise<NewEntry> {
  const tradeId = "man-" + (m.clientRef ? m.clientRef.replace(/[^A-Za-z0-9_-]/g, "") : (await sha256(JSON.stringify([m.symbol, m.side, m.quantity, m.entryPrice, m.entryAt]))).slice(0, 16));
  const dir = m.side === "buy" ? 1 : -1, closed = m.exitPrice != null, gross = closed ? (m.exitPrice! - m.entryPrice) * m.quantity * dir : null, net = gross === null ? null : gross - (m.fees ?? 0);
  return { id: "manual:" + tradeId, at: m.entryAt!, kind: "manual_trade", tradeId, symbol: m.symbol, environment: "manual", source: "manual", actor,
    data: { side: m.side, quantity: m.quantity, entryPrice: m.entryPrice, entryAt: m.entryAt, exitPrice: m.exitPrice ?? null, exitAt: m.exitAt ?? null, fees: m.fees, feesKnown: m.fees !== null, gross, net, status: closed ? "closed" : "open", venue: m.venue, strategy: m.strategy ?? null,
      stop: m.stop ?? null, targets: m.targets ?? [], reason: m.reason ?? null, notes: m.notes ?? null, result: net === null ? null : net > 0 ? "win" : net < 0 ? "loss" : "breakeven" } };
}
/** Notes/reviews/corrections never edit anything: they are new entries pointing at the trade (and optionally at the entry they correct). */
export async function fromNote(tradeId: string, text: string, actor: string, opts: { tags?: string[]; corrects?: string | null; at?: number } = {}): Promise<NewEntry> {
  const at = opts.at ?? Date.now(), t = text.trim().slice(0, 4000);
  return { id: "note:" + tradeId + ":" + (await sha256(JSON.stringify([at, actor, t, opts.corrects ?? null]))).slice(0, 14), at, kind: "note", tradeId, symbol: null, environment: null, source: "manual", actor, corrects: opts.corrects ?? null,
    data: { text: t, tags: (opts.tags ?? []).slice(0, 10).map(s => String(s).slice(0, 30)) } };
}
