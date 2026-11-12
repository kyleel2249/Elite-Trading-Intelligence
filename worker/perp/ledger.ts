/**
 * Perpetual-futures ledger: an append-only event log folded into orders, positions, closed trades and balances.
 * One-way position mode, ISOLATED margin, USDT-margined. Pure functions, no I/O.
 *
 *  - Orders are not positions: only FILL events change positions.
 *  - Opposite-side fills reduce first (realising P&L), and any remainder opens a new position the other way (a flip). Reduce-only orders never flip.
 *  - Wallet balance moves only by realised P&L and fees. Margin is reserved, not spent: available = wallet - position margin - resting-order margin.
 *  - Liquidation price (isolated) = entry x (1 -/+ margin/notional +/- maintenance rate). Binance uses tiered maintenance rates per symbol; this
 *    uses one configurable rate, so on a real exchange liquidation can differ. Funding payments are NOT simulated.
 *  - Duplicate events and over-fills are applied once; unknown fees stay unknown (null) and are reported, not guessed.
 */
export type PerpEnvironment = "perp_paper" | "perp_testnet";
export type Side = "buy" | "sell";
export type Direction = "long" | "short";
export type OrderType = "market" | "limit" | "stop";
export type OrderStatus = "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired";
interface Base { id: string; at: number }
export type PerpEvent = Base & (
  | { t: "init"; startingBalance: number; currency: string; mmr: number }
  | { t: "submitted"; orderId: string; clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; limitPrice?: number | null; stopPrice?: number | null; reduceOnly: boolean; leverage: number; refPrice?: number | null; venue: string; reason?: string | null; source?: string | null }
  | { t: "accepted"; orderId: string; brokerOrderId?: string | null; status: "open" | "pending" }
  | { t: "fill"; orderId: string; fillId: string; qty: number; price: number; fee: number | null; liquidity?: "maker" | "taker" | null; verified: boolean; origin: "internal_sim" | "exchange_testnet" | "liquidation" }
  | { t: "cancelled" | "rejected" | "expired"; orderId: string; reason: string }
  | { t: "mark"; prices: Record<string, number> }
);
export interface Order { orderId: string; clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; filledQty: number; avgFillPrice: number | null; limitPrice: number | null; stopPrice: number | null; reduceOnly: boolean; leverage: number; status: OrderStatus; statusReason: string | null; refPrice: number | null; brokerOrderId: string | null; venue: string; reason: string | null; source: string | null; createdAt: number; updatedAt: number }
export interface Fill { orderId: string; fillId: string; symbol: string; side: Side; qty: number; price: number; fee: number | null; liquidity: "maker" | "taker" | null; origin: string; verified: boolean; at: number; applied: boolean; realized: number }
export interface Position { symbol: string; side: Direction; qty: number; avgEntry: number; leverage: number; margin: number; openedAt: number; updatedAt: number; entryQty: number; exitQty: number; exitNotional: number; realizedGross: number; fees: number; unknownFees: number; liqPrice: number }
export interface ClosedTrade { id: string; symbol: string; direction: Direction; qty: number; leverage: number; entryPrice: number; exitPrice: number; entryAt: number; exitAt: number; holdingMs: number; gross: number; fees: number; net: number; unknownFees: number; liquidated: boolean; result: "win" | "loss" | "breakeven" }
export interface Anomaly { at: number; kind: string; detail: string; ref?: string }
export interface Ledger { environment: PerpEnvironment; startingBalance: number | null; currency: string; mmr: number; cash: number | null; orders: Record<string, Order>; fills: Fill[]; positions: Record<string, Position>; closed: ClosedTrade[]; marks: Record<string, number>; leverage: Record<string, number>; anomalies: Anomaly[]; eventCount: number; realizedGross: number; fees: number; unknownFees: number; curve: { t: number; equity: number }[] }
export const EPS = 1e-9;
export const DEFAULT_MMR = 0.005;
const TERMINAL: OrderStatus[] = ["filled", "cancelled", "rejected", "expired"];
export const isTerminal = (s: OrderStatus) => TERMINAL.includes(s);
export const isActive = (o: Order) => !isTerminal(o.status);
export const remainingQty = (o: Order) => Math.max(0, o.qty - o.filledQty);
export const dirOf = (side: Side): Direction => side === "buy" ? "long" : "short";

export function liqPriceOf(side: Direction, avgEntry: number, qty: number, margin: number, mmr: number): number {
  const r = margin / (qty * avgEntry);
  return side === "long" ? Math.max(0, avgEntry * (1 - r + mmr)) : avgEntry * (1 + r - mmr);
}
export function emptyLedger(environment: PerpEnvironment): Ledger {
  return { environment, startingBalance: null, currency: "USDT", mmr: DEFAULT_MMR, cash: null, orders: {}, fills: [], positions: {}, closed: [], marks: {}, leverage: {}, anomalies: [], eventCount: 0, realizedGross: 0, fees: 0, unknownFees: 0, curve: [] };
}
export const unrealizedOf = (p: Position, mark: number) => (p.side === "long" ? mark - p.avgEntry : p.avgEntry - mark) * p.qty;
const equityOf = (L: Ledger) => { if (L.cash === null) return null; let v = L.cash; for (const p of Object.values(L.positions)) v += unrealizedOf(p, L.marks[p.symbol] ?? p.avgEntry); return v; };
const point = (L: Ledger, at: number) => { const e = equityOf(L); if (e !== null) L.curve.push({ t: at, equity: e }); };

export function fold(environment: PerpEnvironment, events: PerpEvent[]): Ledger {
  const L = emptyLedger(environment), seen = new Set<string>(), seenFill = new Set<string>();
  for (const ev of [...events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (seen.has(ev.id)) { L.anomalies.push({ at: ev.at, kind: "duplicate_event", detail: "ignored a repeated event", ref: ev.id }); continue; }
    seen.add(ev.id); L.eventCount++;
    switch (ev.t) {
      case "init": if (L.startingBalance === null) { L.startingBalance = ev.startingBalance; L.currency = ev.currency; L.cash = ev.startingBalance; L.mmr = ev.mmr > 0 && ev.mmr < 0.5 ? ev.mmr : DEFAULT_MMR; point(L, ev.at); } break;
      case "submitted":
        if (L.orders[ev.orderId]) { L.anomalies.push({ at: ev.at, kind: "duplicate_order", detail: "order id submitted twice", ref: ev.orderId }); break; }
        L.orders[ev.orderId] = { orderId: ev.orderId, clientOrderId: ev.clientOrderId, symbol: ev.symbol, side: ev.side, type: ev.type, qty: ev.qty, filledQty: 0, avgFillPrice: null, limitPrice: ev.limitPrice ?? null, stopPrice: ev.stopPrice ?? null, reduceOnly: !!ev.reduceOnly, leverage: ev.leverage, status: "pending", statusReason: null, refPrice: ev.refPrice ?? null, brokerOrderId: null, venue: ev.venue, reason: ev.reason ?? null, source: ev.source ?? null, createdAt: ev.at, updatedAt: ev.at };
        if (!ev.reduceOnly) L.leverage[ev.symbol] = ev.leverage;
        break;
      case "accepted": { const o = L.orders[ev.orderId]; if (!o) { L.anomalies.push({ at: ev.at, kind: "orphan_event", detail: "accepted for unknown order", ref: ev.orderId }); break; } if (!o.brokerOrderId && ev.brokerOrderId) o.brokerOrderId = ev.brokerOrderId; if (!isTerminal(o.status) && o.filledQty === 0) o.status = ev.status; o.updatedAt = ev.at; break; }
      case "cancelled": case "rejected": case "expired": {
        const o = L.orders[ev.orderId]; if (!o) { L.anomalies.push({ at: ev.at, kind: "orphan_event", detail: ev.t + " for unknown order", ref: ev.orderId }); break; }
        if (o.status === "filled") { L.anomalies.push({ at: ev.at, kind: "late_" + ev.t, detail: "ignored: the order was already fully filled", ref: ev.orderId }); break; }
        o.status = ev.t; o.statusReason = ev.reason; o.updatedAt = ev.at; break;
      }
      case "mark": Object.assign(L.marks, ev.prices); point(L, ev.at); break;
      case "fill": applyFill(L, ev, seenFill); break;
    }
  }
  return L;
}

function applyFill(L: Ledger, ev: Extract<PerpEvent, { t: "fill" }>, seenFill: Set<string>) {
  const o = L.orders[ev.orderId];
  if (!o) { L.anomalies.push({ at: ev.at, kind: "orphan_event", detail: "fill for unknown order", ref: ev.orderId }); return; }
  const key = ev.orderId + "|" + ev.fillId;
  if (seenFill.has(key)) { L.anomalies.push({ at: ev.at, kind: "duplicate_fill", detail: "fill already applied", ref: key }); return; }
  seenFill.add(key);
  if (!(ev.qty > 0) || !(ev.price > 0) || !Number.isFinite(ev.qty + ev.price) || (ev.fee !== null && !(ev.fee >= 0))) { L.anomalies.push({ at: ev.at, kind: "invalid_fill", detail: "non-positive quantity, price or fee ignored", ref: key }); return; }
  const room = remainingQty(o), qty = Math.min(ev.qty, room);
  if (qty <= EPS) { L.anomalies.push({ at: ev.at, kind: "overfill", detail: "fill beyond the order quantity ignored", ref: key }); return; }
  if (qty < ev.qty - EPS) L.anomalies.push({ at: ev.at, kind: "overfill", detail: "fill clamped to the remaining order quantity", ref: key });
  const fee = ev.fee === null ? null : ev.fee * (qty / ev.qty), dir = dirOf(o.side);
  const fill: Fill = { orderId: o.orderId, fillId: ev.fillId, symbol: o.symbol, side: o.side, qty, price: ev.price, fee, liquidity: ev.liquidity ?? null, origin: ev.origin, verified: ev.verified, at: ev.at, applied: true, realized: 0 };
  let p = L.positions[o.symbol], useQty = qty;
  if (o.reduceOnly && (!p || p.side === dir)) { fill.applied = false; L.fills.push(fill); L.anomalies.push({ at: ev.at, kind: "reduce_only_without_position", detail: "reduce-only fill with nothing to reduce; excluded from P&L and balances", ref: key }); return; }
  if (o.reduceOnly && p && qty > p.qty + EPS) { useQty = p.qty; L.anomalies.push({ at: ev.at, kind: "reduce_only_clamped", detail: "reduce-only fill larger than the position; excess excluded", ref: key }); fill.qty = useQty; }
  const feeFor = (q: number) => fee === null ? null : fee * (q / qty);
  o.avgFillPrice = ((o.filledQty * (o.avgFillPrice ?? 0)) + qty * ev.price) / (o.filledQty + qty); o.filledQty += qty; o.updatedAt = ev.at;
  o.status = o.filledQty >= o.qty - EPS ? "filled" : "partially_filled";
  const bookFee = (f: number | null, pos: Position | undefined) => { if (f === null) { L.unknownFees++; if (pos) pos.unknownFees++; } else { L.fees += f; if (L.cash !== null) L.cash -= f; if (pos) pos.fees += f; } };
  let rest = useQty;
  if (p && p.side !== dir) {                                   // reduce / close / flip
    const close = Math.min(rest, p.qty), pnl = (p.side === "long" ? ev.price - p.avgEntry : p.avgEntry - ev.price) * close;
    p.realizedGross += pnl; p.exitQty += close; p.exitNotional += ev.price * close; p.margin *= (p.qty - close) / p.qty; p.qty -= close; p.updatedAt = ev.at;
    L.realizedGross += pnl; fill.realized = pnl; if (L.cash !== null) L.cash += pnl; bookFee(feeFor(close), p); rest -= close;
    if (p.qty > 0) p.liqPrice = liqPriceOf(p.side, p.avgEntry, p.qty, p.margin, L.mmr);
    if (p.qty <= EPS) {
      const net = p.realizedGross - p.fees, entry = p.avgEntry;   // entry average is of the whole holding
      L.closed.push({ id: "trade-" + p.symbol + "-" + p.openedAt + "-" + ev.at, symbol: p.symbol, direction: p.side, qty: p.entryQty, leverage: p.leverage, entryPrice: entry, exitPrice: p.exitNotional / p.exitQty, entryAt: p.openedAt, exitAt: ev.at, holdingMs: ev.at - p.openedAt, gross: p.realizedGross, fees: p.fees, net, unknownFees: p.unknownFees, liquidated: ev.origin === "liquidation", result: Math.abs(net) < 1e-8 ? "breakeven" : net > 0 ? "win" : "loss" });
      delete L.positions[o.symbol]; p = undefined;
    }
  }
  if (rest > EPS && !o.reduceOnly) {                            // open or add (also the remainder of a flip)
    if (!p) p = L.positions[o.symbol] = { symbol: o.symbol, side: dir, qty: 0, avgEntry: 0, leverage: o.leverage, margin: 0, openedAt: ev.at, updatedAt: ev.at, entryQty: 0, exitQty: 0, exitNotional: 0, realizedGross: 0, fees: 0, unknownFees: 0, liqPrice: 0 };
    p.avgEntry = (p.avgEntry * p.qty + ev.price * rest) / (p.qty + rest); p.qty += rest; p.entryQty += rest; p.margin += ev.price * rest / o.leverage; p.leverage = o.leverage; p.updatedAt = ev.at;
    p.liqPrice = liqPriceOf(p.side, p.avgEntry, p.qty, p.margin, L.mmr);
    bookFee(feeFor(rest), p);
  }
  L.marks[o.symbol] = ev.price; L.fills.push(fill); point(L, ev.at);
}

// ---------- reservations ----------
export const openOrders = (L: Ledger) => Object.values(L.orders).filter(isActive).sort((a, b) => b.createdAt - a.createdAt);
export const positionMargin = (L: Ledger) => Object.values(L.positions).reduce((s, p) => s + p.margin, 0);
/** Margin promised to resting orders that could open or add exposure (reduce-only orders reserve nothing). */
export const orderMargin = (L: Ledger) => openOrders(L).filter(o => !o.reduceOnly).reduce((s, o) => s + remainingQty(o) * (o.limitPrice ?? o.stopPrice ?? o.refPrice ?? 0) / o.leverage, 0);
export const availableBalance = (L: Ledger) => L.cash === null ? null : Math.max(0, L.cash - positionMargin(L) - orderMargin(L));

// ---------- presentation ----------
export interface PositionView extends Position { markPrice: number | null; markStale: boolean; notional: number | null; unrealized: number | null; roePct: number | null; liqDistancePct: number | null; marginRatioPct: number | null; holdingMs: number }
export function statsOf(trades: ClosedTrade[]) {
  const w = trades.filter(t => t.result === "win"), l = trades.filter(t => t.result === "loss"), gw = w.reduce((s, t) => s + t.net, 0), gl = -l.reduce((s, t) => s + t.net, 0);
  return { trades: trades.length, wins: w.length, losses: l.length, winRate: trades.length ? w.length / trades.length : null, profitFactor: gl > 0 ? gw / gl : null, netRealized: trades.reduce((s, t) => s + t.net, 0), liquidations: trades.filter(t => t.liquidated).length, best: trades.length ? Math.max(...trades.map(t => t.net)) : null, worst: trades.length ? Math.min(...trades.map(t => t.net)) : null };
}
export function present(L: Ledger, liveMarks: Record<string, number | null>, now: number) {
  const positions: PositionView[] = Object.values(L.positions).map(p => {
    const live = liveMarks[p.symbol], mark = typeof live === "number" && live > 0 ? live : null, un = mark === null ? null : unrealizedOf(p, mark);
    return { ...p, markPrice: mark, markStale: mark === null, notional: mark === null ? null : p.qty * mark, unrealized: un, roePct: un === null ? null : un / p.margin * 100,
      liqDistancePct: mark === null ? null : Math.abs(mark - p.liqPrice) / mark * 100, marginRatioPct: mark === null || un === null ? null : (L.mmr * p.qty * mark) / Math.max(1e-12, p.margin + un) * 100, holdingMs: now - p.openedAt };
  }).sort((a, b) => b.openedAt - a.openedAt);
  const known = positions.every(p => p.unrealized !== null), unreal = known ? positions.reduce((s, p) => s + (p.unrealized ?? 0), 0) : null;
  const equity = L.cash === null || unreal === null ? null : L.cash + unreal, pm = positionMargin(L), om = orderMargin(L);
  const exposure = known ? positions.reduce((s, p) => s + (p.notional ?? 0), 0) : null;
  return { positions, openOrders: openOrders(L), closed: [...L.closed].sort((a, b) => b.exitAt - a.exitAt), stats: statsOf(L.closed),
    balances: { currency: L.currency, starting: L.startingBalance, wallet: L.cash, available: availableBalance(L), positionMargin: pm, orderMargin: om, unrealized: unreal, equity, exposure, effectiveLeverage: exposure !== null && equity ? exposure / equity : null },
    pnl: { realizedGross: L.realizedGross, fees: L.fees, realizedNet: L.realizedGross - L.fees, total: equity !== null && L.startingBalance !== null ? equity - L.startingBalance : null } };
}
