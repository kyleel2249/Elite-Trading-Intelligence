/**
 * ETI AUTONOMOUS TRADE JOURNAL: derived views. Pure functions over journal entries; nothing here writes or alters history.
 * Every number is computed from recorded entries. Where an input is unknown (a fee, a stop, a risk amount) the output is null, never a guess.
 */
import type { JournalEntry } from "./store.ts";

export type TradeStatus = "closed" | "open" | "partially_filled" | "filled" | "resting" | "rejected" | "broker_rejected" | "outcome_unknown" | "cancelled" | "expired" | "analysed";
export interface TimelineItem { seq: number; at: number; kind: string; summary: string; entryId: string; source: string; via: string | null }
export interface TradeRecord {
  tradeId: string; symbol: string | null; environment: string | null; origin: "eti" | "manual" | "paper_engine"; strategy: string | null; side: string | null; status: TradeStatus;
  firstAt: number; lastAt: number; decision: string | null; confidence: number | null; reasons: string[]; plan: { stop: number | null; targets: (number | null)[]; entryZone: [number, number] | null } | null;
  entryPrice: number | null; exitPrice: number | null; quantity: number | null; gross: number | null; fees: number | null; net: number | null; feesKnown: boolean; r: number | null; holdingMs: number | null; result: "win" | "loss" | "breakeven" | null;
  notes: number; timeline: TimelineItem[];
}
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const money = (v: number | null) => (v === null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(2));
function summarise(e: JournalEntry): string {
  const d: any = e.data;
  switch (e.kind) {
    case "analysis": return `Analysis: ${d.decision}${d.strategy ? " (" + d.strategy + ")" : ""}${d.confidence != null ? ", evidence score " + d.confidence : ""}`;
    case "order_submitted": return `Order ${d.outcome === "resting" ? "resting in the book" : "executed"}: ${d.side ?? ""} ${d.quantity ?? ""} ${e.symbol ?? ""}${d.fillPrice != null ? " @ " + d.fillPrice : ""}${d.simulated ? " (simulated)" : ""}`.replace(/\s+/g, " ");
    case "order_rejected": return `Order refused before any broker (${d.stage ?? "?"}): ${(d.reasons?.[0] ?? d.error ?? "no reason recorded")}`;
    case "order_broker_rejected": return `Broker rejected the order: ${(d.reasons?.[0] ?? d.error ?? "")}`;
    case "order_outcome_unknown": return `Broker gave no definite answer: ${(d.reasons?.[0] ?? "")}`;
    case "fill": return `Fill: ${d.side} ${d.qty} @ ${d.price}${d.fee != null ? ", fee " + d.fee : ", fee unknown"}`;
    case "order_cancelled": return `Order cancelled: ${d.reason ?? ""}`;
    case "order_expired": return `Order expired: ${d.reason ?? ""}`;
    case "trade_closed": return `Trade closed: ${d.result}, net ${money(n(d.net))}`;
    case "manual_trade": return `Manual trade recorded: ${d.side} ${d.quantity} @ ${d.entryPrice}${d.status === "closed" ? ", closed " + money(n(d.net)) : ", open"}`;
    case "prediction_evaluated": return `Prediction ${d.outcome}${d.reason ? ": " + d.reason : ""}`;
    case "note": return "Note: " + String(d.text ?? "").slice(0, 140);
    case "strategy_event": return `Strategy engine: ${d.type ?? ""}${d.reason ? " (" + d.reason + ")" : ""}`;
    case "anomaly": return `Data anomaly: ${d.kind ?? ""} ${d.detail ?? ""}`;
    default: return e.kind;
  }
}

/** Group entries by trade and derive each trade's status and result from what was actually recorded. */
export function buildTrades(entries: JournalEntry[]): TradeRecord[] {
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) { if (!e.tradeId || e.kind === "insight") continue; (groups.get(e.tradeId) ?? groups.set(e.tradeId, []).get(e.tradeId)!).push(e); }
  const out: TradeRecord[] = [];
  for (const [tradeId, list] of groups) {
    list.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const has = (k: string) => list.filter(e => e.kind === k), last = <T,>(a: T[]) => a[a.length - 1];
    const analysis = last(has("analysis")), closed = last(has("trade_closed")), manual = last(has("manual_trade")), submitted = last(has("order_submitted"));
    const rejected = has("order_rejected"), brokerRej = has("order_broker_rejected"), unknown = has("order_outcome_unknown"), fills = has("fill"), cancelled = has("order_cancelled"), expired = has("order_expired");
    const ad: any = analysis?.data ?? {}, cd: any = closed?.data ?? {}, md: any = manual?.data ?? {}, sd: any = submitted?.data ?? {};
    let status: TradeStatus = "analysed";
    if (closed || md.status === "closed") status = "closed";
    else if (manual) status = "open";
    else if (fills.length && (submitted || fills.length)) status = (fills.some(f => (f.data as any).partial) ? "partially_filled" : "filled");
    else if (submitted) status = sd.outcome === "resting" ? "resting" : "filled";
    if (!closed && !manual && !fills.length && !submitted) status = brokerRej.length ? "broker_rejected" : unknown.length ? "outcome_unknown" : rejected.length ? "rejected" : cancelled.length ? "cancelled" : expired.length ? "expired" : "analysed";
    if (!closed && !manual && submitted && sd.outcome === "resting" && !fills.length && (cancelled.length || expired.length)) status = cancelled.length ? "cancelled" : "expired";
    const reasons: string[] = [];
    for (const e of [...rejected, ...brokerRej, ...unknown, ...cancelled, ...expired]) { const d: any = e.data; for (const r of (d.reasons ?? [d.reason]).filter(Boolean)) if (!reasons.includes(r)) reasons.push(r); }
    const origin: TradeRecord["origin"] = manual ? "manual" : list.some(e => (e.data as any)?.via === "paper_engine") ? "paper_engine" : "eti";
    const first = list[0], env = list.map(e => e.environment).find(Boolean) ?? null, symbol = list.map(e => e.symbol).find(Boolean) ?? null;
    const gross = n(cd.gross) ?? n(md.gross), fees = closed ? n(cd.fees) : n(md.fees), net = n(cd.net) ?? n(md.net);
    const risk = n(cd.riskAmount), result = (cd.result ?? md.result ?? null) as TradeRecord["result"];
    out.push({ tradeId, symbol, environment: env, origin, strategy: (cd.strategy ?? md.strategy ?? ad.strategy ?? sd.executionSource?.strategyId ?? null) as string | null,
      side: (md.side ?? sd.side ?? (closed ? "buy" : null)) as string | null, status, firstAt: first.at, lastAt: last(list)!.at, decision: ad.decision ?? null, confidence: n(ad.confidence),
      reasons, plan: analysis ? { stop: n(ad.stop), targets: (ad.targets ?? []).map(n), entryZone: ad.entryZone ?? null } : (manual ? { stop: n(md.stop), targets: (md.targets ?? []).map(n), entryZone: null } : null),
      entryPrice: n(cd.entryPrice) ?? n(md.entryPrice) ?? n(sd.fillPrice), exitPrice: n(cd.exitPrice) ?? n(md.exitPrice), quantity: n(cd.qty) ?? n(md.quantity) ?? n(sd.quantity), gross, fees, net,
      feesKnown: closed ? !(n(cd.unknownFees) && cd.unknownFees > 0) : md.feesKnown !== false, r: risk && net !== null ? net / risk : null,
      holdingMs: n(cd.holdingMs) ?? (md.exitAt != null && md.entryAt != null ? md.exitAt - md.entryAt : null), result, notes: has("note").length,
      timeline: list.map(e => ({ seq: e.seq, at: e.at, kind: e.kind, summary: summarise(e), entryId: e.id, source: e.source, via: ((e.data as any)?.via ?? null) as string | null })) });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
function wilson(w: number, nn: number) { if (!nn) return null; const z = 1.96, p = w / nn, d = 1 + z * z / nn, c = p + z * z / (2 * nn), m = z * Math.sqrt(p * (1 - p) / nn + z * z / (4 * nn * nn)); return { low: (c - m) / d, high: (c + m) / d }; }
export interface Group { key: string; trades: number; wins: number; losses: number; winRate: number | null; net: number; expectancy: number | null; profitFactor: number | null }
function perf(rows: TradeRecord[]) {
  const done = rows.filter(t => t.status === "closed" && t.net !== null), nets = done.map(t => t.net!), wins = done.filter(t => t.result === "win"), losses = done.filter(t => t.result === "loss");
  const gw = sum(wins.map(t => t.net!)), gl = Math.abs(sum(losses.map(t => t.net!)));
  const ordered = [...done].sort((a, b) => a.lastAt - b.lastAt); let cum = 0, peak = 0, maxDd = 0, streakW = 0, streakL = 0, curW = 0, curL = 0;
  for (const t of ordered) { cum += t.net!; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); if (t.result === "win") { curW++; curL = 0; } else if (t.result === "loss") { curL++; curW = 0; } else { curW = 0; curL = 0; } streakW = Math.max(streakW, curW); streakL = Math.max(streakL, curL); }
  const rs = done.map(t => t.r).filter((v): v is number => v !== null), holds = done.map(t => t.holdingMs).filter((v): v is number => v !== null);
  return { closed: done.length, wins: wins.length, losses: losses.length, breakeven: done.length - wins.length - losses.length, winRate: done.length ? wins.length / done.length : null, winRateInterval: wilson(wins.length, done.length),
    netPnl: sum(nets), grossPnl: sum(done.map(t => t.gross ?? 0)), fees: sum(done.map(t => t.fees ?? 0)), feesUnknownTrades: done.filter(t => !t.feesKnown).length,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null, payoffRatio: wins.length && losses.length ? (gw / wins.length) / (gl / losses.length) : null,
    expectancy: done.length ? sum(nets) / done.length : null, profitFactor: gl > 0 ? gw / gl : null, largestWin: nets.length ? Math.max(...nets) : null, largestLoss: nets.length ? Math.min(...nets) : null,
    maxDrawdown: maxDd, maxWinStreak: streakW, maxLossStreak: streakL, avgR: rs.length ? sum(rs) / rs.length : null, rSample: rs.length, avgHoldingMs: holds.length ? sum(holds) / holds.length : null };
}
function groups(rows: TradeRecord[], key: (t: TradeRecord) => string): Group[] {
  const m = new Map<string, TradeRecord[]>(); for (const t of rows.filter(t => t.status === "closed")) { const k = key(t); (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
  return [...m].map(([k, v]) => { const p = perf(v); return { key: k, trades: p.closed, wins: p.wins, losses: p.losses, winRate: p.winRate, net: p.netPnl, expectancy: p.expectancy, profitFactor: p.profitFactor }; }).sort((a, b) => b.net - a.net);
}
export interface Stats {
  generatedAt: number; entries: number; trades: number; performance: ReturnType<typeof perf>;
  orders: { total: number; executed: number; open: number; refused: number; brokerRejected: number; outcomeUnknown: number; cancelled: number; expired: number; analysedOnly: number; refusalReasons: { reason: string; count: number }[] };
  byStrategy: Group[]; bySymbol: Group[]; byEnvironment: Group[]; byHourUtc: Group[]; byWeekday: Group[];
  predictions: { total: number; evaluated: number; hits: number; misses: number; inconclusive: number; pending: number; hitRate: number | null; byStrategy: { key: string; evaluated: number; hits: number; hitRate: number | null }[]; calibration: { bucket: string; evaluated: number; hitRate: number | null }[] };
  dataQuality: { anomalies: number; manualTrades: number; notes: number; sampleWarning: string | null };
}
export function computeStats(entries: JournalEntry[], now = Date.now()): Stats {
  const trades = buildTrades(entries), by = (s: TradeStatus[]) => trades.filter(t => s.includes(t.status)).length, reasons = new Map<string, number>();
  for (const t of trades.filter(t => t.status === "rejected")) for (const r of t.reasons.slice(0, 1)) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  const analyses = entries.filter(e => e.kind === "analysis" && ["BUY", "SELL"].includes(String((e.data as any).decision).toUpperCase())), evals = new Map(entries.filter(e => e.kind === "prediction_evaluated").map(e => [String((e.data as any).analysisId), e]));
  const evaluated = analyses.map(a => ({ a, ev: evals.get(a.id) })), done = evaluated.filter(x => x.ev && (x.ev.data as any).outcome !== "inconclusive"), hits = done.filter(x => (x.ev!.data as any).outcome === "hit");
  const rate = (h: number, t: number) => (t ? h / t : null), strat = new Map<string, { e: number; h: number }>(), cal = new Map<string, { e: number; h: number }>();
  for (const x of done) {
    const s = String((x.a.data as any).strategy ?? "unspecified"), c = n((x.a.data as any).confidence), b = c === null ? "unknown" : `${Math.min(90, Math.floor(c / 10) * 10)}-${Math.min(100, Math.floor(c / 10) * 10 + 10)}`, hit = (x.ev!.data as any).outcome === "hit" ? 1 : 0;
    const sv = strat.get(s) ?? { e: 0, h: 0 }; sv.e++; sv.h += hit; strat.set(s, sv); const cv = cal.get(b) ?? { e: 0, h: 0 }; cv.e++; cv.h += hit; cal.set(b, cv);
  }
  const perfAll = perf(trades), small = perfAll.closed < 30 ? `Only ${perfAll.closed} closed trade(s): statistics below 30 trades are indicative, not reliable.` : null;
  return { generatedAt: now, entries: entries.length, trades: trades.length, performance: perfAll,
    orders: { total: trades.filter(t => t.origin !== "manual" && t.status !== "analysed").length, executed: by(["closed", "open", "filled", "partially_filled"]) - trades.filter(t => t.origin === "manual").length, open: by(["resting", "open", "partially_filled"]), refused: by(["rejected"]), brokerRejected: by(["broker_rejected"]), outcomeUnknown: by(["outcome_unknown"]), cancelled: by(["cancelled"]), expired: by(["expired"]), analysedOnly: by(["analysed"]),
      refusalReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10) },
    byStrategy: groups(trades, t => t.strategy ?? "unspecified"), bySymbol: groups(trades, t => t.symbol ?? "unknown"), byEnvironment: groups(trades, t => t.environment ?? "unknown"),
    byHourUtc: groups(trades, t => String(new Date(t.firstAt).getUTCHours()).padStart(2, "0")).sort((a, b) => a.key.localeCompare(b.key)), byWeekday: groups(trades, t => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(t.firstAt).getUTCDay()]),
    predictions: { total: analyses.length, evaluated: done.length, hits: hits.length, misses: done.length - hits.length, inconclusive: evaluated.filter(x => x.ev && (x.ev.data as any).outcome === "inconclusive").length, pending: evaluated.filter(x => !x.ev).length, hitRate: rate(hits.length, done.length),
      byStrategy: [...strat].map(([key, v]) => ({ key, evaluated: v.e, hits: v.h, hitRate: rate(v.h, v.e) })), calibration: [...cal].map(([bucket, v]) => ({ bucket, evaluated: v.e, hitRate: rate(v.h, v.e) })).sort((a, b) => a.bucket.localeCompare(b.bucket)) },
    dataQuality: { anomalies: entries.filter(e => e.kind === "anomaly").length, manualTrades: trades.filter(t => t.origin === "manual").length, notes: entries.filter(e => e.kind === "note").length, sampleWarning: small } };
}

/**
 * Learning: transparent, rule-based observations with minimum sample sizes. These are suggestions for the human; they NEVER change trading
 * behaviour or any recorded entry. Each insight states the numbers it is based on.
 */
export interface Insight { key: string; severity: "info" | "watch" | "action"; title: string; detail: string; basis: Record<string, unknown> }
export const MIN_GROUP_SAMPLE = 10;
export function deriveInsights(stats: Stats): Insight[] {
  const out: Insight[] = [], p = stats.performance;
  if (p.closed < MIN_GROUP_SAMPLE) out.push({ key: "sample_small", severity: "info", title: "Not enough closed trades to learn from yet", detail: `${p.closed} closed trade(s) recorded; insights start at ${MIN_GROUP_SAMPLE} per group. Every refused, cancelled and losing trade is already being kept.`, basis: { closed: p.closed } });
  for (const g of stats.byStrategy.filter(g => g.trades >= MIN_GROUP_SAMPLE)) {
    if ((g.expectancy ?? 0) < 0 && (g.profitFactor ?? 0) < 1) out.push({ key: "strategy_negative:" + g.key, severity: "action", title: `Strategy "${g.key}" has lost money over ${g.trades} trades`, detail: `Net ${g.net.toFixed(2)}, expectancy ${(g.expectancy ?? 0).toFixed(2)} per trade, win rate ${((g.winRate ?? 0) * 100).toFixed(0)}%. Consider pausing it and reviewing its entries; this journal does not pause anything by itself.`, basis: { ...g } });
    else if ((g.expectancy ?? 0) > 0 && (g.profitFactor ?? 0) > 1.3 && g.trades >= 30) out.push({ key: "strategy_positive:" + g.key, severity: "info", title: `Strategy "${g.key}" has a positive record over ${g.trades} trades`, detail: `Net ${g.net.toFixed(2)}, profit factor ${(g.profitFactor ?? 0).toFixed(2)}. Past results do not guarantee future ones.`, basis: { ...g } });
  }
  for (const g of stats.bySymbol.filter(g => g.trades >= MIN_GROUP_SAMPLE && (g.expectancy ?? 0) < 0 && (g.winRate ?? 1) < 0.4)) out.push({ key: "symbol_weak:" + g.key, severity: "watch", title: `${g.key} is underperforming`, detail: `${g.trades} trades, win rate ${((g.winRate ?? 0) * 100).toFixed(0)}%, net ${g.net.toFixed(2)}.`, basis: { ...g } });
  const top = stats.orders.refusalReasons[0]; if (top && top.count >= 5 && stats.orders.refused >= 5 && top.count / stats.orders.refused >= 0.5) out.push({ key: "refusal_pattern", severity: "watch", title: "Most refused orders share one reason", detail: `"${top.reason}" accounts for ${top.count} of ${stats.orders.refused} refusals. Check whether the order sizing or the setup is generating them.`, basis: { ...top } });
  if (p.maxLossStreak >= 5) out.push({ key: "loss_streak", severity: "watch", title: `A ${p.maxLossStreak}-trade losing streak has occurred`, detail: "Review those trades together for a common cause (symbol, hour, regime, size).", basis: { maxLossStreak: p.maxLossStreak } });
  if (p.avgWin !== null && p.avgLoss !== null && p.closed >= MIN_GROUP_SAMPLE && Math.abs(p.avgLoss) > p.avgWin && (p.winRate ?? 0) < 0.6) out.push({ key: "payoff_skew", severity: "watch", title: "Average loss is larger than the average win", detail: `Avg win ${p.avgWin.toFixed(2)} vs avg loss ${p.avgLoss.toFixed(2)} with a ${((p.winRate ?? 0) * 100).toFixed(0)}% win rate: losers may be run too long or winners cut too short.`, basis: { avgWin: p.avgWin, avgLoss: p.avgLoss, winRate: p.winRate } });
  const pr = stats.predictions; if (pr.evaluated >= MIN_GROUP_SAMPLE) {
    out.push({ key: "prediction_accuracy", severity: "info", title: `Predictions hit ${(((pr.hitRate ?? 0)) * 100).toFixed(0)}% over ${pr.evaluated} evaluated`, detail: "A hit means the first target was reached before the stop within the horizon; misses are kept and counted.", basis: { evaluated: pr.evaluated, hits: pr.hits } });
    const hi = pr.calibration.filter(c => c.evaluated >= 5 && /^(7|8|9)0-/.test(c.bucket) && (c.hitRate ?? 1) < 0.5); if (hi.length) out.push({ key: "overconfident", severity: "action", title: "High evidence scores are not producing high hit rates", detail: `Buckets ${hi.map(h => h.bucket + " (" + ((h.hitRate ?? 0) * 100).toFixed(0) + "%)").join(", ")} hit under 50%. Treat the score as a ranking, not a probability.`, basis: { buckets: hi } });
  }
  return out;
}
