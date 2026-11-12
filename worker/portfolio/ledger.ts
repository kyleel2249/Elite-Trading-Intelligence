/**
 * ETI portfolio ledger: an append-only event log folded into orders, positions, closed trades, balances and statistics.
 * Pure functions, no I/O. The persisted events are the single source of truth; everything shown on the dashboard is derived.
 *
 * Rules enforced here (see worker/portfolio.test.ts):
 *  - An order is not a holding. Only FILL events create or change positions.
 *  - Profit is computed from fill prices, never from requested prices.
 *  - Spot, long-only: a sell can only reduce an existing ETI position. A sell fill with no position is flagged as an anomaly and is not
 *    counted in P&L or cash (it is not ETI's trade). An over-fill beyond the order quantity is flagged and ignored.
 *  - Duplicate events (same event id, or same orderId+fillId) are applied once.
 *  - Unknown fees stay unknown (null): they are reported, never guessed.
 */
export type Environment = "internal_paper" | "exchange_testnet" | "live";
export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop";
export type OrderStatus = "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired";
export interface Plan { stop?: number | null; tp?: (number | null)[]; strategy?: string | null; signalId?: string | null }
interface Base { id: string; at: number }
export type LedgerEvent = Base & (
  | { t: "init"; startingBalance: number; currency: string }
  | { t: "submitted"; orderId: string; clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; limitPrice?: number | null; stopPrice?: number | null; tif?: string | null; venue: string; refPrice?: number | null; strategy?: string | null; signalId?: string | null; actorId?: string | null; reason?: string | null; expiresAt?: number | null }
  | { t: "accepted"; orderId: string; brokerOrderId?: string | null; status: "open" | "pending" }
  | { t: "fill"; orderId: string; fillId: string; qty: number; price: number; fee: number | null; feeAsset?: string | null; slippageBps?: number | null; verified: boolean; origin: "internal_sim" | "exchange_reported" }
  | { t: "cancelled" | "rejected" | "expired"; orderId: string; reason: string }
  | { t: "plan"; symbol: string; plan: Plan }
  | { t: "mark"; prices: Record<string, number> }
);
export interface Order { orderId: string; clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; filledQty: number; avgFillPrice: number | null; limitPrice: number | null; stopPrice: number | null; status: OrderStatus; statusReason: string | null; createdAt: number; updatedAt: number; venue: string; brokerOrderId: string | null; strategy: string | null; signalId: string | null; reason: string | null; tif: string | null; expiresAt: number | null; refPrice: number | null }
export interface Fill { orderId: string; fillId: string; symbol: string; side: Side; qty: number; price: number; fee: number | null; feeAsset: string | null; slippageBps: number | null; verified: boolean; origin: string; at: number; positionId: string | null; applied: boolean }
export interface Levels { stop: number | null; tp: (number | null)[]; hit: boolean[] }
export interface Position { id: string; symbol: string; venue: string; direction: "long"; qty: number; avgEntry: number; totalBoughtQty: number; totalBoughtCost: number; totalSoldQty: number; totalSoldProceeds: number; realizedGross: number; fees: number; unknownFees: number; slippageCost: number; openedAt: number; updatedAt: number; strategy: string | null; signalId: string | null; levels: Levels; levelsAt: number; entryQty: number; fillIds: string[] }
export interface ClosedTrade { id: string; symbol: string; direction: "long"; qty: number; entryPrice: number; exitPrice: number; entryAt: number; exitAt: number; holdingMs: number; gross: number; fees: number; net: number; unknownFees: number; slippageCost: number; strategy: string | null; signalId: string | null; fills: Fill[]; result: "win" | "loss" | "breakeven" }
export interface Anomaly { at: number; kind: string; detail: string; ref?: string }
export interface CurvePoint { t: number; equity: number; cash: number }
export interface Ledger {
  environment: Environment; startingBalance: number | null; currency: string; orders: Record<string, Order>; fills: Fill[]; positions: Record<string, Position>; closed: ClosedTrade[]; cash: number | null;
  plans: Record<string, Plan>; marks: Record<string, number>; curve: CurvePoint[]; anomalies: Anomaly[]; eventCount: number; lastEventAt: number | null; realizedGross: number; fees: number; unknownFees: number; slippageCost: number;
}
const EPS = 1e-9;
const TERMINAL: OrderStatus[] = ["filled", "cancelled", "rejected", "expired"];
export const isTerminal = (s: OrderStatus) => TERMINAL.includes(s);
export const isActive = (o: Order) => !isTerminal(o.status);
const remaining = (o: Order) => Math.max(0, o.qty - o.filledQty);

export function emptyLedger(environment: Environment): Ledger {
  return { environment, startingBalance: null, currency: "USDT", orders: {}, fills: [], positions: {}, closed: [], cash: null, plans: {}, marks: {}, curve: [], anomalies: [], eventCount: 0, lastEventAt: null, realizedGross: 0, fees: 0, unknownFees: 0, slippageCost: 0 };
}
const levelsFor = (plan?: Plan): Levels => ({ stop: plan?.stop ?? null, tp: [0, 1, 2].map(i => plan?.tp?.[i] ?? null), hit: [false, false, false] });
const equityOf = (L: Ledger) => {
  if (L.cash === null) return null; let v = L.cash;
  for (const p of Object.values(L.positions)) v += p.qty * (L.marks[p.symbol] ?? p.avgEntry);
  return v;
};
const point = (L: Ledger, at: number) => { const e = equityOf(L); if (e !== null && L.cash !== null) L.curve.push({ t: at, equity: e, cash: L.cash }); };

/** Fold events (any order) into a ledger. Events are applied in (at, id) order so late-arriving writes cannot reorder history differently on different reads. */
export function fold(environment: Environment, events: LedgerEvent[]): Ledger {
  const L = emptyLedger(environment), seen = new Set<string>(), seenFill = new Set<string>();
  const sorted = [...events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const ev of sorted) {
    if (seen.has(ev.id)) { L.anomalies.push({ at: ev.at, kind: "duplicate_event", detail: "ignored a repeated event", ref: ev.id }); continue; }
    seen.add(ev.id); L.eventCount++; L.lastEventAt = ev.at;
    switch (ev.t) {
      case "init":
        if (L.startingBalance === null) { L.startingBalance = ev.startingBalance; L.currency = ev.currency; L.cash = ev.startingBalance; point(L, ev.at); }
        break;
      case "submitted":
        if (L.orders[ev.orderId]) { L.anomalies.push({ at: ev.at, kind: "duplicate_order", detail: "order id submitted twice", ref: ev.orderId }); break; }
        L.orders[ev.orderId] = { orderId: ev.orderId, clientOrderId: ev.clientOrderId, symbol: ev.symbol, side: ev.side, type: ev.type, qty: ev.qty, filledQty: 0, avgFillPrice: null, limitPrice: ev.limitPrice ?? null, stopPrice: ev.stopPrice ?? null, status: "pending", statusReason: null, createdAt: ev.at, updatedAt: ev.at, venue: ev.venue, brokerOrderId: null, strategy: ev.strategy ?? null, signalId: ev.signalId ?? null, reason: ev.reason ?? null, tif: ev.tif ?? null, expiresAt: ev.expiresAt ?? null, refPrice: ev.refPrice ?? null };
        break;
      case "accepted": {
        const o = L.orders[ev.orderId]; if (!o) { L.anomalies.push({ at: ev.at, kind: "orphan_event", detail: "accepted for unknown order", ref: ev.orderId }); break; }
        if (o.brokerOrderId === null && ev.brokerOrderId) o.brokerOrderId = ev.brokerOrderId;
        if (!isTerminal(o.status) && o.filledQty === 0) o.status = ev.status; o.updatedAt = ev.at; break;
      }
      case "cancelled": case "rejected": case "expired": {
        const o = L.orders[ev.orderId]; if (!o) { L.anomalies.push({ at: ev.at, kind: "orphan_event", detail: ev.t + " for unknown order", ref: ev.orderId }); break; }
        if (o.status === "filled") { L.anomalies.push({ at: ev.at, kind: "late_" + ev.t, detail: "ignored: the order was already fully filled", ref: ev.orderId }); break; }
        o.status = ev.t; o.statusReason = ev.reason; o.updatedAt = ev.at; break;
      }
      case "plan": L.plans[ev.symbol] = { ...L.plans[ev.symbol], ...ev.plan }; { const p = L.positions[ev.symbol]; if (p) { p.levels = { ...levelsFor(L.plans[ev.symbol]), hit: p.levels.hit }; p.levelsAt = ev.at; } } break;
      case "mark": Object.assign(L.marks, ev.prices); point(L, ev.at); break;
      case "fill": {
        const o = L.orders[ev.orderId];
        if (!o) { L.anomalies.push({ at: ev.at, kind: "orphan_event", detail: "fill for unknown order", ref: ev.orderId }); break; }
        const key = ev.orderId + "|" + ev.fillId;
        if (seenFill.has(key)) { L.anomalies.push({ at: ev.at, kind: "duplicate_fill", detail: "fill already applied", ref: key }); break; }
        seenFill.add(key);
        if (!(ev.qty > 0) || !(ev.price > 0) || !Number.isFinite(ev.qty + ev.price)) { L.anomalies.push({ at: ev.at, kind: "invalid_fill", detail: "non-positive quantity or price ignored", ref: key }); break; }
        const room = remaining(o), qty = Math.min(ev.qty, room);
        if (qty <= EPS) { L.anomalies.push({ at: ev.at, kind: "overfill", detail: "fill beyond the order quantity ignored", ref: key }); break; }
        if (qty < ev.qty - EPS) L.anomalies.push({ at: ev.at, kind: "overfill", detail: "fill clamped to the remaining order quantity", ref: key });
        const fee = ev.fee === null ? null : ev.fee * (qty / ev.qty);
        const prev = o.filledQty * (o.avgFillPrice ?? 0); o.filledQty += qty; o.avgFillPrice = (prev + qty * ev.price) / o.filledQty; o.updatedAt = ev.at;
        o.status = o.filledQty >= o.qty - EPS ? "filled" : (o.status === "cancelled" || o.status === "expired" ? o.status : "partially_filled");
        const fill: Fill = { orderId: o.orderId, fillId: ev.fillId, symbol: o.symbol, side: o.side, qty, price: ev.price, fee, feeAsset: ev.feeAsset ?? null, slippageBps: ev.slippageBps ?? null, verified: ev.verified, origin: ev.origin, at: ev.at, positionId: null, applied: true };
        const slip = (o.refPrice && o.refPrice > 0) ? Math.abs(ev.price - o.refPrice) * qty : 0;
        if (o.side === "buy") {
          L.slippageCost += slip; if (fee === null) L.unknownFees++; else L.fees += fee;
          let p = L.positions[o.symbol];
          if (!p) { p = L.positions[o.symbol] = { id: "pos-" + o.symbol + "-" + ev.at + "-" + ev.id.slice(-6), symbol: o.symbol, venue: o.venue, direction: "long", qty: 0, avgEntry: 0, totalBoughtQty: 0, totalBoughtCost: 0, totalSoldQty: 0, totalSoldProceeds: 0, realizedGross: 0, fees: 0, unknownFees: 0, slippageCost: 0, openedAt: ev.at, updatedAt: ev.at, strategy: o.strategy, signalId: o.signalId, levels: levelsFor(L.plans[o.symbol]), levelsAt: ev.at, entryQty: 0, fillIds: [] }; }
          p.avgEntry = (p.avgEntry * p.qty + ev.price * qty) / (p.qty + qty); p.qty += qty; p.entryQty += qty; p.totalBoughtQty += qty; p.totalBoughtCost += ev.price * qty; p.updatedAt = ev.at;
          if (fee === null) p.unknownFees++; else p.fees += fee; p.slippageCost += slip; fill.positionId = p.id; p.fillIds.push(o.orderId + "|" + ev.fillId);
          if (L.cash !== null) L.cash -= ev.price * qty + (fee ?? 0);
          L.fills.push(fill);
        } else {
          const p = L.positions[o.symbol];
          if (!p || p.qty <= EPS) { fill.applied = false; L.fills.push(fill); L.anomalies.push({ at: ev.at, kind: "sell_without_position", detail: "sell fill with no ETI position (pre-existing balance or another source); excluded from P&L and cash", ref: key }); break; }
          const sellQty = Math.min(qty, p.qty);
          if (sellQty < qty - EPS) L.anomalies.push({ at: ev.at, kind: "oversell", detail: "sell fill larger than the ETI position; excess excluded", ref: key });
          const gross = (ev.price - p.avgEntry) * sellQty;
          p.realizedGross += gross; p.totalSoldQty += sellQty; p.totalSoldProceeds += ev.price * sellQty; p.qty -= sellQty; p.updatedAt = ev.at;
          if (fee === null) p.unknownFees++; else p.fees += fee; p.slippageCost += slip; fill.positionId = p.id; fill.qty = sellQty; p.fillIds.push(o.orderId + "|" + ev.fillId);
          L.realizedGross += gross; L.slippageCost += slip; if (fee === null) L.unknownFees++; else L.fees += fee; if (L.cash !== null) L.cash += ev.price * sellQty - (fee ?? 0);
          if (o.reason) { const m = /^take_profit_([123])$/.exec(o.reason); if (m) p.levels.hit[Number(m[1]) - 1] = true; }
          L.fills.push(fill);
          if (p.qty <= EPS) {
            const fills: Fill[] = L.fills.filter(f => f.positionId === p.id), entryPrice = p.totalBoughtCost / p.totalBoughtQty, exitPrice = p.totalSoldProceeds / p.totalSoldQty, net = p.realizedGross - p.fees;
            L.closed.push({ id: "trade-" + p.id, symbol: p.symbol, direction: "long", qty: p.totalBoughtQty, entryPrice, exitPrice, entryAt: p.openedAt, exitAt: ev.at, holdingMs: ev.at - p.openedAt, gross: p.realizedGross, fees: p.fees, net, unknownFees: p.unknownFees, slippageCost: p.slippageCost, strategy: p.strategy, signalId: p.signalId, fills, result: Math.abs(net) < 1e-9 ? "breakeven" : net > 0 ? "win" : "loss" });
            delete L.positions[p.symbol];
          }
        }
        L.marks[o.symbol] = ev.price; point(L, ev.at);
        break;
      }
    }
  }
  return L;
}

// ---------- order-level helpers used by the engine ----------
export const openOrders = (L: Ledger) => Object.values(L.orders).filter(isActive).sort((a, b) => b.createdAt - a.createdAt);
/** Quantity of a symbol already promised to resting sell orders. */
export const reservedQty = (L: Ledger, symbol: string) => openOrders(L).filter(o => o.symbol === symbol && o.side === "sell").reduce((s, o) => s + remaining(o), 0);
/** Cash promised to resting buy orders (limit price x remaining). Market orders reserve nothing because they fill immediately or not at all. */
export const reservedCash = (L: Ledger) => openOrders(L).filter(o => o.side === "buy").reduce((s, o) => s + remaining(o) * (o.limitPrice ?? o.refPrice ?? 0), 0);
export const availableCash = (L: Ledger) => L.cash === null ? null : L.cash - reservedCash(L);
export const freeQty = (L: Ledger, symbol: string) => Math.max(0, (L.positions[symbol]?.qty ?? 0) - reservedQty(L, symbol));
export { remaining as remainingQty };

// ---------- presentation: needs live marks ----------
export interface PositionView extends Position { markPrice: number | null; markStale: boolean; value: number | null; unrealized: number | null; unrealizedPct: number | null; realizedNet: number; holdingMs: number; status: "open"; reservedQty: number }
export interface Stats { trades: number; wins: number; losses: number; breakeven: number; winRate: number | null; avgWin: number | null; avgLoss: number | null; profitFactor: number | null; bestTrade: number | null; worstTrade: number | null; grossRealized: number; netRealized: number; fees: number; unknownFees: number; slippageCost: number }
export function statsOf(trades: ClosedTrade[]): Stats {
  const w = trades.filter(t => t.result === "win"), l = trades.filter(t => t.result === "loss"), sum = (a: ClosedTrade[], f: (t: ClosedTrade) => number) => a.reduce((s, t) => s + f(t), 0);
  const gw = sum(w, t => t.net), gl = -sum(l, t => t.net);
  return { trades: trades.length, wins: w.length, losses: l.length, breakeven: trades.length - w.length - l.length, winRate: trades.length ? w.length / trades.length : null, avgWin: w.length ? gw / w.length : null, avgLoss: l.length ? -gl / l.length : null, profitFactor: gl > 0 ? gw / gl : null, bestTrade: trades.length ? Math.max(...trades.map(t => t.net)) : null, worstTrade: trades.length ? Math.min(...trades.map(t => t.net)) : null, grossRealized: sum(trades, t => t.gross), netRealized: sum(trades, t => t.net), fees: sum(trades, t => t.fees), unknownFees: sum(trades, t => t.unknownFees), slippageCost: sum(trades, t => t.slippageCost) };
}
export interface Present { positions: PositionView[]; openOrders: Order[]; closed: ClosedTrade[]; stats: Stats; pnl: { unrealized: number | null; realizedNet: number; realizedGross: number; fees: number; daily: number | null; total: number | null; totalPct: number | null }; balances: { currency: string; starting: number | null; cash: number | null; available: number | null; reservedForOrders: number | null; positionValue: number | null; equity: number | null; exposure: number | null; exposurePct: number | null }; curve: CurvePoint[] }
export function present(L: Ledger, liveMarks: Record<string, number | null>, now: number, staleSymbols: string[] = []): Present {
  const positions: PositionView[] = Object.values(L.positions).map(p => {
    const live = liveMarks[p.symbol], mark = typeof live === "number" && live > 0 ? live : null, stale = mark === null;
    const value = mark === null ? null : p.qty * mark, unreal = mark === null ? null : (mark - p.avgEntry) * p.qty;
    return { ...p, markPrice: mark, markStale: stale || staleSymbols.includes(p.symbol), value, unrealized: unreal, unrealizedPct: mark === null ? null : (mark / p.avgEntry - 1) * 100, realizedNet: p.realizedGross - p.fees, holdingMs: now - p.openedAt, status: "open", reservedQty: reservedQty(L, p.symbol) };
  }).sort((a, b) => b.openedAt - a.openedAt);
  const known = positions.every(p => p.value !== null), posValue = known ? positions.reduce((s, p) => s + (p.value ?? 0), 0) : null;
  const unreal = known ? positions.reduce((s, p) => s + (p.unrealized ?? 0), 0) : null;
  const equity = L.cash === null || posValue === null ? null : L.cash + posValue;
  const stats = statsOf(L.closed), realizedNet = L.realizedGross - L.fees;
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  let base: number | null = null; for (const c of L.curve) if (c.t < dayStart) base = c.equity; if (base === null && L.curve.length) base = L.curve[0].equity;
  const curve = L.curve.slice(); if (equity !== null) curve.push({ t: now, equity, cash: L.cash! });
  return { positions, openOrders: openOrders(L), closed: [...L.closed].sort((a, b) => b.exitAt - a.exitAt), stats,
    pnl: { unrealized: unreal, realizedNet, realizedGross: L.realizedGross, fees: L.fees, daily: equity !== null && base !== null ? equity - base : null, total: equity !== null && L.startingBalance !== null ? equity - L.startingBalance : null, totalPct: equity !== null && L.startingBalance ? (equity / L.startingBalance - 1) * 100 : null },
    balances: { currency: L.currency, starting: L.startingBalance, cash: L.cash, available: availableCash(L), reservedForOrders: L.cash === null ? null : reservedCash(L), positionValue: posValue, equity, exposure: posValue, exposurePct: posValue !== null && equity ? posValue / equity * 100 : null }, curve };
}
