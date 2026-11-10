/**
 * Portfolio engine: turns orders into ledger events.
 *  - INTERNAL PAPER: ETI simulates the venue. Market orders fill at the live public price +/- slippage with a fee; limit and stop orders rest and
 *    are matched against closed 1-minute bars (a cursor per symbol, so each bar is considered once). Stop-loss and TP1-3 levels exit the
 *    position automatically (stop first when one bar touches both, the conservative assumption).
 *  - EXCHANGE TESTNET: ETI never simulates. Events are written only from what the broker reported (order response, order query, myTrades).
 *    Stop and take-profit levels on testnet are alert-only: ETI places no unattended exchange orders.
 * Nothing here is "live": the live environment has no ledger.
 */
import { loadMinuteBars } from "../algo/market-inputs.ts";
import { hmacHex } from "../auth/credentials.ts";
import type { Kline } from "../market.ts";
import { availableCash, fold, freeQty, isActive, remainingQty, type Environment, type Ledger, type LedgerEvent, type Order, type OrderType, type Plan, type Side } from "./ledger.ts";
import { PortfolioStore, type KVL } from "./store.ts";

export interface EngineEnv {
  ETI_EXECUTION_LOG?: KVL | any; ETI_PAPER_START_BALANCE?: string; ETI_PAPER_FEE_BPS?: string; ETI_PAPER_SLIPPAGE_BPS?: string; ETI_ROUND_TRIP_COST_BPS?: string;
  ALPACA_API_KEY?: string; ALPACA_SECRET_KEY?: string; BINANCE_API_KEY?: string; BINANCE_SECRET_KEY?: string;
}
export interface EngineDeps { now?: () => number; fetchImpl?: typeof fetch; priceOf?: (symbol: string) => Promise<number | null>; barsOf?: (symbol: string, now: number) => Promise<Kline[]> }
export const BAR_MS = 60_000;
export const TP_ALLOCATION = [0.4, 0.3, 0.3];
const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && v !== "" && v !== undefined && v !== null ? n : d; };
export const paperConfig = (env: EngineEnv) => {
  const sb = Number(env.ETI_PAPER_START_BALANCE);
  return { start: Number.isFinite(sb) && sb > 0 ? sb : 10_000, feeBps: num(env.ETI_PAPER_FEE_BPS, 10), slipBps: num(env.ETI_PAPER_SLIPPAGE_BPS, num(env.ETI_ROUND_TRIP_COST_BPS, 10) / 2 || 5) };
};
// Event ids sort within one timestamp in this order: init, submitted, accepted, plan, fill, terminal, mark.
const ID = { init: "e0i-", sub: "e1s-", acc: "e2a-", plan: "e2p-", fill: "e3f-", end: "e4x-", mark: "e5m-" };
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const store = (env: EngineEnv, e: Environment) => new PortfolioStore(env.ETI_EXECUTION_LOG as KVL, e);
const priceOf = async (env: EngineEnv, deps: EngineDeps, s: string, now: number): Promise<number | null> => { try { if (deps.priceOf) return await deps.priceOf(s); return (await loadMinuteBars(env as any, s, null, now)).price; } catch { return null; } };
const barsOf = async (env: EngineEnv, deps: EngineDeps, s: string, now: number): Promise<{ bars: Kline[]; price: number | null }> => {
  try {
    if (deps.barsOf) { const bars = (await deps.barsOf(s, now)).filter(k => k[0] + BAR_MS <= now).sort((a, b) => a[0] - b[0]); const last = bars.at(-1); return { bars, price: last && now - last[0] <= 3 * BAR_MS ? last[4] : null }; }
    const r = await loadMinuteBars(env as any, s, null, now); return { bars: r.bars.sort((a, b) => a[0] - b[0]), price: r.price };
  } catch { return { bars: [], price: null }; }
};
const nextUtcMidnight = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

export async function ensureInit(env: EngineEnv, now: number) {
  const st = store(env, "internal_paper"), c = paperConfig(env);
  await st.append({ id: ID.init + "start", at: now, t: "init", startingBalance: c.start, currency: "USDT" }, { idempotent: true });
  return st;
}

// ================= INTERNAL PAPER =================
export interface PlaceInput { clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; limitPrice?: number | null; stopPrice?: number | null; tif?: string | null; plan?: { stop?: number | null; tp?: (number | null)[] } | null; strategy?: string | null; signalId?: string | null; actorId?: string | null; reason?: string | null }
export type PlaceResult =
  | { ok: true; order: Order; filledNow: boolean; marketPrice: number | null; fills: { fillId: string; qty: number; price: number; fee: number }[] }
  | { ok: false; status: number; code: string; message: string; order?: Order; marketPrice?: number | null };

/** Check TP/stop ordering for a long: stop < entry < TP1 < TP2 < TP3. Returns an error message or null. */
export function validateLevels(plan: PlaceInput["plan"], entry: number | null): string | null {
  if (!plan) return null;
  const tp = (plan.tp ?? []).map(v => v ?? null), stop = plan.stop ?? null;
  for (const v of [stop, ...tp]) if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v > 0)) return "levels must be positive numbers";
  if (stop !== null && entry !== null && !(stop < entry)) return "stop must be below the entry price for a long position";
  let prev = entry ?? 0;
  for (let i = 0; i < tp.length; i++) { const v = tp[i]; if (v === null) continue; if (!(v > prev)) return "take-profit levels must rise: entry < TP1 < TP2 < TP3"; prev = v; }
  return null;
}

export async function placeInternal(env: EngineEnv, deps: EngineDeps, inp: PlaceInput, now: number): Promise<PlaceResult> {
  const st = await ensureInit(env, now), cfg = paperConfig(env), orderId = "paper-" + inp.clientOrderId, venue = "eti_paper";
  const { ledger: L0 } = await st.ledger();
  if (L0.orders[orderId]) return { ok: false, status: 409, code: "duplicate_client_order_id", message: "This clientOrderId was already used." };
  const px = await priceOf(env, deps, inp.symbol, now);
  if (inp.type === "market" && !(px && px > 0)) return { ok: false, status: 503, code: "price_unavailable", marketPrice: null, message: "No fresh public market price for " + inp.symbol + ". Internal paper fills need one (crypto symbols are supported)." };
  if (inp.type === "stop" && inp.side !== "sell") return { ok: false, status: 400, code: "invalid_order", message: "Stop orders protect a long position, so only sell stops are supported." };
  if (inp.type === "stop" && !(inp.stopPrice && inp.stopPrice > 0)) return { ok: false, status: 400, code: "invalid_stop_price", message: "A stop order needs a positive stopPrice." };
  if (inp.side === "sell" && inp.plan) return { ok: false, status: 400, code: "invalid_levels", message: "Stop/take-profit levels apply to buy orders." };
  const refForLevels = inp.side === "buy" ? (inp.type === "limit" ? inp.limitPrice ?? px : px) : null;
  const lvlErr = validateLevels(inp.plan, refForLevels ?? null);
  if (lvlErr) return { ok: false, status: 400, code: "invalid_levels", message: lvlErr };
  const expiresAt = inp.tif === "day" && inp.type !== "market" ? nextUtcMidnight(now) : null;
  await st.append({ id: ID.sub + orderId, at: now, t: "submitted", orderId, clientOrderId: inp.clientOrderId, symbol: inp.symbol, side: inp.side, type: inp.type, qty: inp.qty, limitPrice: inp.limitPrice ?? null, stopPrice: inp.stopPrice ?? null, tif: inp.tif ?? null, venue, refPrice: px, strategy: inp.strategy ?? null, signalId: inp.signalId ?? null, actorId: inp.actorId ?? null, reason: inp.reason ?? null, expiresAt }, { idempotent: true });
  const reject = async (code: string, message: string, status = 422): Promise<PlaceResult> => {
    await st.append({ id: ID.end + orderId, at: now, t: "rejected", orderId, reason: code }, { idempotent: true });
    return { ok: false, status, code, message, marketPrice: px, order: (await st.ledger()).ledger.orders[orderId] };
  };
  // Balance / holdings are checked against the ledger, never assumed.
  if (inp.side === "buy") {
    const est = inp.type === "market" ? px! * (1 + cfg.slipBps / 1e4) : inp.limitPrice!, need = inp.qty * est * (1 + cfg.feeBps / 1e4), have = availableCash(L0);
    if (have === null || have < need) return reject("insufficient_balance", "Insufficient simulated balance: needs " + need.toFixed(2) + " USDT, available " + (have ?? 0).toFixed(2) + " USDT.");
  } else if (freeQty(L0, inp.symbol) + 1e-12 < inp.qty) return reject("insufficient_holdings", "Not enough " + inp.symbol + " held (long-only spot): free quantity " + freeQty(L0, inp.symbol) + ", requested " + inp.qty + ".");
  if (inp.type === "stop" && px && px <= inp.stopPrice!) return reject("stop_already_triggered", "The stop price is at or above the current price, so it would trigger immediately. Use a market sell to exit now.");
  await st.append({ id: ID.acc + orderId, at: now, t: "accepted", orderId, brokerOrderId: orderId, status: "open" }, { idempotent: true });
  const plan = inp.plan ? { stop: inp.plan.stop ?? null, tp: [0, 1, 2].map(i => inp.plan!.tp?.[i] ?? null), strategy: inp.strategy ?? null, signalId: inp.signalId ?? null } : null;
  let price: number | null = null, slipBps: number | null = null;
  if (inp.type === "market") { price = inp.side === "buy" ? px! * (1 + cfg.slipBps / 1e4) : px! * (1 - cfg.slipBps / 1e4); slipBps = cfg.slipBps; }
  else if (inp.type === "limit" && px && (inp.side === "buy" ? inp.limitPrice! >= px : inp.limitPrice! <= px)) { price = inp.side === "buy" ? Math.min(inp.limitPrice!, px * (1 + cfg.slipBps / 1e4)) : Math.max(inp.limitPrice!, px * (1 - cfg.slipBps / 1e4)); slipBps = Math.abs(price - px) / px * 1e4; }
  const fills: { fillId: string; qty: number; price: number; fee: number }[] = [];
  if (price !== null) {
    if (plan && inp.side === "buy") await st.append({ id: ID.plan + rid(), at: now, t: "plan", symbol: inp.symbol, plan });
    const fee = price * inp.qty * cfg.feeBps / 1e4;
    await st.append({ id: ID.fill + orderId + "-1", at: now, t: "fill", orderId, fillId: "1", qty: inp.qty, price, fee, feeAsset: "USDT", slippageBps: slipBps, verified: true, origin: "internal_sim" }, { idempotent: true });
    fills.push({ fillId: "1", qty: inp.qty, price, fee });
  } else {
    if (plan) await st.kvPut("pplan:" + orderId, plan, 60 * 60 * 24 * 30);
    if (inp.tif === "ioc") await st.append({ id: ID.end + orderId, at: now, t: "expired", orderId, reason: "ioc_not_marketable" }, { idempotent: true });
  }
  const order = (await st.ledger()).ledger.orders[orderId];
  return { ok: true, order, filledNow: price !== null, marketPrice: px, fills };
}

/** Walk the closed 1m bars since each symbol's cursor and apply resting orders, protective stops and take-profits. Safe to call repeatedly. */
export async function matchInternal(env: EngineEnv, deps: EngineDeps = {}, now = (deps.now ?? Date.now)()): Promise<{ symbols: number; fills: number; cancelled: number; expired: number; idle: boolean }> {
  const st = store(env, "internal_paper"), cfg = paperConfig(env), out = { symbols: 0, fills: 0, cancelled: 0, expired: 0, idle: true };
  const { events } = await st.events(); if (!events.length) return out;
  const evs: LedgerEvent[] = [...events]; let L: Ledger = fold("internal_paper", evs);
  const apply = async (ev: LedgerEvent, idem = true) => { if (await st.append(ev, { idempotent: idem })) { evs.push(ev); L = fold("internal_paper", evs); return true; } return false; };
  const end = async (o: Order, t: "cancelled" | "expired", reason: string, at: number) => { if (await apply({ id: ID.end + o.orderId, at, t, orderId: o.orderId, reason } as LedgerEvent)) out[t === "cancelled" ? "cancelled" : "expired"]++; };
  const sell = async (orderId: string, symbol: string, type: OrderType, qty: number, price: number, at: number, reason: string, p: { strategy: string | null; signalId: string | null }, existing?: Order) => {
    if (!existing) await apply({ id: ID.sub + orderId, at, t: "submitted", orderId, clientOrderId: orderId, symbol, side: "sell", type, qty, limitPrice: type === "limit" ? price : null, stopPrice: type === "stop" ? price : null, venue: "eti_paper", refPrice: null, strategy: p.strategy, signalId: p.signalId, actorId: "eti-paper-engine", reason });
    await apply({ id: ID.acc + orderId, at, t: "accepted", orderId, brokerOrderId: orderId, status: "open" });
    const fee = price * qty * cfg.feeBps / 1e4;
    if (await apply({ id: ID.fill + orderId + "-1", at, t: "fill", orderId, fillId: "1", qty, price, fee, feeAsset: "USDT", slippageBps: reason === "stop_loss" ? cfg.slipBps : 0, verified: true, origin: "internal_sim" })) out.fills++;
  };
  const symbols = new Set<string>([...Object.values(L.orders).filter(isActive).map(o => o.symbol), ...Object.keys(L.positions)]);
  const priceBySymbol: Record<string, number> = {};
  for (const symbol of symbols) {
    const { bars, price } = await barsOf(env, deps, symbol, now); out.symbols++;
    if (price) priceBySymbol[symbol] = price;
    if (!bars.length) continue;
    const cursor = await st.kvGet<number>("cur:" + symbol, 0);
    for (const bar of bars) {
      const [openT, open, high, low] = bar, close = openT + BAR_MS; if (openT < cursor) continue;
      // 1. day-order expiry
      for (const o of Object.values(L.orders)) if (isActive(o) && o.symbol === symbol && o.expiresAt && o.expiresAt <= close) await end(o, "expired", "day_order_expired", o.expiresAt);
      // 2. protective exits for the open position (stop first)
      const p = L.positions[symbol];
      if (p && openT >= Math.max(p.updatedAt, p.levelsAt) && p.qty > 1e-12) {
        const lv = p.levels;
        if (lv.stop !== null && low <= lv.stop) {
          const px = Math.min(open, lv.stop) * (1 - cfg.slipBps / 1e4);
          await sell("auto-" + p.id + "-sl", symbol, "stop", p.qty, px, close, "stop_loss", p);
        } else {
          for (let i = 0; i < 3; i++) {
            const cur = L.positions[symbol]; if (!cur) break;
            const tp = cur.levels.tp[i]; if (cur.levels.hit[i] || tp === null || high < tp) continue;
            const qty = i === 2 ? cur.qty : Math.min(cur.qty, cur.entryQty * TP_ALLOCATION[i]);
            if (qty > 1e-12) await sell("auto-" + cur.id + "-tp" + (i + 1), symbol, "limit", qty, Math.max(open, tp), close, "take_profit_" + (i + 1), cur);
          }
        }
      }
      // 3. resting user orders created before this bar opened
      for (const o of Object.values(L.orders).filter(x => isActive(x) && x.symbol === symbol && x.createdAt <= openT && x.venue === "eti_paper").sort((a, b) => a.createdAt - b.createdAt)) {
        const live = L.orders[o.orderId]; if (!live || !isActive(live)) continue;
        let px: number | null = null;
        if (o.type === "limit" && o.side === "buy" && low <= o.limitPrice!) px = Math.min(open, o.limitPrice!);
        else if (o.type === "limit" && o.side === "sell" && high >= o.limitPrice!) px = Math.max(open, o.limitPrice!);
        else if (o.type === "stop" && o.side === "sell" && low <= o.stopPrice!) px = Math.min(open, o.stopPrice!) * (1 - cfg.slipBps / 1e4);
        if (px === null) continue;
        let qty = remainingQty(live);
        if (o.side === "sell") { const pos = L.positions[symbol]; if (!pos) { await end(live, "cancelled", "position_closed", close); continue; } qty = Math.min(qty, pos.qty); }
        else if ((L.cash ?? 0) + 1e-9 < px * qty * (1 + cfg.feeBps / 1e4)) { if (await apply({ id: ID.end + o.orderId, at: close, t: "rejected", orderId: o.orderId, reason: "insufficient_balance_at_fill" })) out.cancelled++; continue; }
        const fee = px * qty * cfg.feeBps / 1e4;
        if (o.side === "buy") { const pl = await st.kvGet<Plan | null>("pplan:" + o.orderId, null); if (pl) await apply({ id: ID.plan + o.orderId, at: close, t: "plan", symbol, plan: pl }); }
        if (await apply({ id: ID.fill + o.orderId + "-1", at: close, t: "fill", orderId: o.orderId, fillId: "1", qty, price: px, fee, feeAsset: "USDT", slippageBps: o.type === "stop" ? cfg.slipBps : 0, verified: true, origin: "internal_sim" })) out.fills++;
      }
    }
    await st.kvPut("cur:" + symbol, (bars.at(-1)![0]) + BAR_MS);
  }
  // Orders on a symbol with no fresh data still expire on time; a sell with no position left is cancelled, never left dangling.
  for (const o of Object.values(L.orders)) {
    if (!isActive(o)) continue;
    if (o.expiresAt && o.expiresAt <= now) await end(o, "expired", "day_order_expired", o.expiresAt);
    else if (o.side === "sell" && !L.positions[o.symbol]) await end(o, "cancelled", "position_closed", now);
  }
  const held = Object.keys(L.positions).filter(s => priceBySymbol[s]);
  if (held.length) await apply({ id: ID.mark + Math.floor(now / 300_000), at: now, t: "mark", prices: Object.fromEntries(held.map(s => [s, priceBySymbol[s]])) });
  out.idle = !Object.values(L.orders).some(isActive) && Object.keys(L.positions).length === 0;
  return out;
}

export async function cancelInternal(env: EngineEnv, orderId: string, now: number, actor: string) {
  const st = store(env, "internal_paper"), { ledger: L } = await st.ledger(), o = L.orders[orderId];
  if (!o) return { ok: false as const, status: 404, code: "order_not_found" };
  if (!isActive(o)) return { ok: false as const, status: 409, code: "order_not_cancellable", message: "The order is already " + o.status + "." };
  await st.append({ id: ID.end + orderId, at: now, t: "cancelled", orderId, reason: "user_cancelled:" + actor }, { idempotent: true });
  return { ok: true as const, order: (await st.ledger()).ledger.orders[orderId] };
}

/** Update stop / TP levels of an open position (or the pending plan of a symbol). Levels are validated against the average entry. */
export async function setPlan(env: EngineEnv, environment: Environment, symbol: string, plan: { stop?: number | null; tp?: (number | null)[] }, now: number) {
  const st = store(env, environment), { ledger: L } = await st.ledger(), p = L.positions[symbol];
  if (!p) return { ok: false as const, status: 409, code: "no_open_position", message: "There is no open " + symbol + " position to attach levels to." };
  const merged = { stop: plan.stop === undefined ? p.levels.stop : plan.stop, tp: [0, 1, 2].map(i => plan.tp?.[i] === undefined ? p.levels.tp[i] : plan.tp![i]) };
  const err = validateLevels(merged, p.avgEntry); if (err) return { ok: false as const, status: 400, code: "invalid_levels", message: err };
  await st.append({ id: ID.plan + rid(), at: now, t: "plan", symbol, plan: merged });
  return { ok: true as const, levels: merged };
}

// ================= EXCHANGE TESTNET =================
export interface BrokerFill { id: string; qty: number; price: number; fee: number | null; feeAsset: string | null; at: number | null }
export interface BrokerView { brokerOrderId: string | null; status: "open" | "partially_filled" | "filled" | "cancelled" | "expired" | "rejected" | "pending"; filledQty: number; avgPrice: number | null; fills: BrokerFill[]; reason?: string }
const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USD", "BTC", "ETH", "BNB"];
const quoteOf = (symbol: string) => QUOTES.find(q => symbol.endsWith(q) && symbol.length > q.length) ?? null;
const fin = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
function feeIn(symbol: string, f: any, price: number): number | null {
  const c = fin(f?.commission), a = String(f?.commissionAsset ?? ""), q = quoteOf(symbol); if (!(c >= 0) || !a || !q) return null;
  if (c === 0) return 0; if (a === q) return c; if (symbol.startsWith(a)) return c * price; return null; // e.g. BNB-paid fee: no trustworthy conversion
}
export function parseBinanceOrder(symbol: string, d: any, trades?: any[]): BrokerView {
  const s = String(d?.status ?? "").toUpperCase(), exec = fin(d?.executedQty), cq = fin(d?.cummulativeQuoteQty);
  const map: Record<string, BrokerView["status"]> = { NEW: "open", PARTIALLY_FILLED: "partially_filled", FILLED: "filled", CANCELED: "cancelled", PENDING_CANCEL: "open", REJECTED: "rejected", EXPIRED: "expired", EXPIRED_IN_MATCH: "expired" };
  const raw: any[] = Array.isArray(trades) ? trades : Array.isArray(d?.fills) ? d.fills : [];
  const fills: BrokerFill[] = raw.map((f, i) => { const price = fin(f.price), qty = fin(f.qty); return { id: String(f.tradeId ?? f.id ?? "x" + i), qty, price, fee: feeIn(symbol, f, price), feeAsset: f.commissionAsset ?? null, at: Number.isFinite(fin(f.time)) ? fin(f.time) : null }; }).filter(f => f.qty > 0 && f.price > 0);
  return { brokerOrderId: d?.orderId != null ? String(d.orderId) : null, status: map[s] ?? "pending", filledQty: exec > 0 ? exec : 0, avgPrice: exec > 0 && cq > 0 ? cq / exec : null, fills, reason: s === "REJECTED" ? "broker_rejected" : undefined };
}
export function parseAlpacaOrder(d: any): BrokerView {
  const s = String(d?.status ?? "").toLowerCase(), fq = fin(d?.filled_qty), ap = fin(d?.filled_avg_price);
  const map: Record<string, BrokerView["status"]> = { new: "open", accepted: "open", pending_new: "pending", accepted_for_bidding: "open", partially_filled: "partially_filled", filled: "filled", canceled: "cancelled", expired: "expired", rejected: "rejected", done_for_day: "expired", replaced: "cancelled" };
  return { brokerOrderId: d?.id ? String(d.id) : null, status: map[s] ?? "pending", filledQty: fq > 0 ? fq : 0, avgPrice: ap > 0 ? ap : null, fills: [], reason: s === "rejected" ? "broker_rejected" : undefined };
}
/** Write only the events the broker evidence supports. Idempotent: repeating it with the same evidence changes nothing. */
export async function applyBrokerView(st: PortfolioStore, orderId: string, v: BrokerView, now: number): Promise<number> {
  let written = 0; const { ledger } = await st.ledger(), o = ledger.orders[orderId]; if (!o) return 0;
  const have = new Set(ledger.fills.filter(f => f.orderId === orderId).map(f => f.fillId)); let known = o.filledQty, cost = known * (o.avgFillPrice ?? 0);
  for (const f of v.fills) {
    if (have.has(f.id)) continue;
    const q = Math.min(f.qty, Math.max(0, o.qty - known)); if (q <= 1e-12) continue;
    if (await st.append({ id: ID.fill + orderId + "-" + f.id, at: f.at ?? now, t: "fill", orderId, fillId: f.id, qty: q, price: f.price, fee: f.fee, feeAsset: f.feeAsset, slippageBps: null, verified: true, origin: "exchange_reported" }, { idempotent: true })) { written++; known += q; cost += q * f.price; }
  }
  if (known + 1e-12 < v.filledQty && v.avgPrice) { // aggregate-only evidence (Alpaca, or Binance without per-trade rows)
    const delta = v.filledQty - known, price = (v.avgPrice * v.filledQty - cost) / delta;
    if (delta > 1e-12 && price > 0 && Number.isFinite(price) && await st.append({ id: ID.fill + orderId + "-cum" + v.filledQty, at: now, t: "fill", orderId, fillId: "cum" + v.filledQty, qty: delta, price, fee: null, feeAsset: null, slippageBps: null, verified: true, origin: "exchange_reported" }, { idempotent: true })) written++;
  }
  if (v.brokerOrderId) { if (await st.append({ id: ID.acc + orderId + "-" + v.brokerOrderId, at: now, t: "accepted", orderId, brokerOrderId: v.brokerOrderId, status: "open" }, { idempotent: true })) written++; }
  if (v.status === "cancelled" || v.status === "expired" || v.status === "rejected") { if (await st.append({ id: ID.end + orderId, at: now, t: v.status, orderId, reason: v.reason ?? "broker_" + v.status }, { idempotent: true })) written++; }
  return written;
}
export interface ExchangeOrderInput { broker: "alpaca" | "binance"; clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; limitPrice?: number | null; tif?: string | null; plan?: PlaceInput["plan"]; strategy?: string | null; signalId?: string | null; actorId?: string | null }
const venueOf = (b: string) => b === "binance" ? "binance_testnet" : "alpaca_paper";
const oid = (b: string, c: string) => (b === "binance" ? "bn-" : "ap-") + c;
/** Record an order the broker has just answered. `response` is the broker JSON; `ok:false` records a rejection with the broker's own message. */
export async function recordExchangeOrder(env: EngineEnv, inp: ExchangeOrderInput, response: any, ok: boolean, now: number, refPrice: number | null = null) {
  const st = store(env, "exchange_testnet"), orderId = oid(inp.broker, inp.clientOrderId);
  await st.append({ id: ID.sub + orderId, at: now, t: "submitted", orderId, clientOrderId: inp.clientOrderId, symbol: inp.symbol, side: inp.side, type: inp.type, qty: inp.qty, limitPrice: inp.limitPrice ?? null, stopPrice: null, tif: inp.tif ?? null, venue: venueOf(inp.broker), refPrice, strategy: inp.strategy ?? null, signalId: inp.signalId ?? null, actorId: inp.actorId ?? null }, { idempotent: true });
  if (!ok) { const msg = String(response?.msg ?? response?.message ?? response?.code ?? "broker_rejected").slice(0, 200); await st.append({ id: ID.end + orderId, at: now, t: "rejected", orderId, reason: msg }, { idempotent: true }); return; }
  if (inp.plan && inp.side === "buy") await st.append({ id: ID.plan + rid(), at: now, t: "plan", symbol: inp.symbol, plan: { stop: inp.plan.stop ?? null, tp: [0, 1, 2].map(i => inp.plan!.tp?.[i] ?? null), strategy: inp.strategy ?? null, signalId: inp.signalId ?? null } });
  const view = inp.broker === "binance" ? parseBinanceOrder(inp.symbol, response) : parseAlpacaOrder(response);
  await applyBrokerView(st, orderId, view, now);
}

async function binanceGet(env: EngineEnv, deps: EngineDeps, path: string, params: Record<string, string>, method = "GET") {
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" }); q.set("signature", await hmacHex(env.BINANCE_SECRET_KEY!, q.toString()));
  const r = await (deps.fetchImpl ?? fetch)("https://testnet.binance.vision" + path + "?" + q.toString(), { method, headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY! } });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) as any };
}
async function alpacaReq(env: EngineEnv, deps: EngineDeps, path: string, method = "GET") {
  const r = await (deps.fetchImpl ?? fetch)("https://paper-api.alpaca.markets" + path, { method, headers: { "APCA-API-KEY-ID": env.ALPACA_API_KEY!, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY! } });
  return { ok: r.ok, status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})) as any };
}
const hasKeys = (env: EngineEnv, venue: string) => venue === "binance_testnet" ? !!(env.BINANCE_API_KEY && env.BINANCE_SECRET_KEY) : !!(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY);

async function syncOne(env: EngineEnv, deps: EngineDeps, st: PortfolioStore, o: Order, now: number): Promise<number> {
  if (!o.brokerOrderId || !hasKeys(env, o.venue)) return 0;
  if (o.venue === "binance_testnet") {
    const r = await binanceGet(env, deps, "/api/v3/order", { symbol: o.symbol, origClientOrderId: o.clientOrderId }); if (!r.ok) return 0;
    let trades: any[] | undefined; if (fin(r.data.executedQty) > 0) { const t = await binanceGet(env, deps, "/api/v3/myTrades", { symbol: o.symbol, orderId: String(r.data.orderId) }); if (t.ok && Array.isArray(t.data)) trades = t.data; }
    return applyBrokerView(st, o.orderId, parseBinanceOrder(o.symbol, r.data, trades), now);
  }
  const r = await alpacaReq(env, deps, "/v2/orders/" + encodeURIComponent(o.brokerOrderId)); if (!r.ok) return 0;
  return applyBrokerView(st, o.orderId, parseAlpacaOrder(r.data), now);
}
/** Pull the broker's current view of every order that is still active (fills, cancels, expiries that happened outside ETI). */
export async function syncExchange(env: EngineEnv, deps: EngineDeps = {}, now = (deps.now ?? Date.now)()) {
  const st = store(env, "exchange_testnet"), { ledger: L } = await st.ledger(); let checked = 0, written = 0, skipped = 0;
  for (const o of Object.values(L.orders).filter(isActive)) { if (!hasKeys(env, o.venue)) { skipped++; continue; } checked++; try { written += await syncOne(env, deps, st, o, now); } catch { /* next poll retries */ } }
  return { checked, written, skipped, idle: checked + skipped === 0 };
}
export async function cancelExchange(env: EngineEnv, deps: EngineDeps, orderId: string, now: number) {
  const st = store(env, "exchange_testnet"), { ledger: L } = await st.ledger(), o = L.orders[orderId];
  if (!o) return { ok: false as const, status: 404, code: "order_not_found" };
  if (!isActive(o)) return { ok: false as const, status: 409, code: "order_not_cancellable", message: "The order is already " + o.status + "." };
  if (!hasKeys(env, o.venue)) return { ok: false as const, status: 503, code: "credentials_unavailable", message: "Exchange testnet credentials are not configured, so the exchange order cannot be cancelled from here." };
  try {
    const r = o.venue === "binance_testnet" ? await binanceGet(env, deps, "/api/v3/order", { symbol: o.symbol, origClientOrderId: o.clientOrderId }, "DELETE") : await alpacaReq(env, deps, "/v2/orders/" + encodeURIComponent(o.brokerOrderId ?? ""), "DELETE");
    if (!r.ok && !(o.venue === "binance_testnet" && r.data?.code === -2011) && r.status !== 422 && r.status !== 404) return { ok: false as const, status: 502, code: "broker_rejected", message: String(r.data?.msg ?? r.data?.message ?? "The broker did not cancel the order.") };
    await syncOne(env, deps, st, o, now); // the broker's answer decides the final status (it may have filled first)
    return { ok: true as const, order: (await st.ledger()).ledger.orders[orderId] };
  } catch (e) { return { ok: false as const, status: 502, code: "execution_upstream_error", message: e instanceof Error ? e.message : "upstream error" }; }
}

// ================= RECONCILIATION =================
export interface Reconciliation { environment: Environment; checkedAt: number; ok: boolean; source: "ledger_self_check" | "binance_testnet" | "alpaca_paper"; exchange: Record<string, unknown> | null; diffs: { symbol: string; etiQty: number; exchangeQty: number | null; delta: number | null; note: string }[]; problems: string[] }
/** Internal: recompute cash and quantities straight from the fills and compare with the folded ledger. */
export function selfCheck(L: Ledger, now: number): Reconciliation {
  const problems: string[] = [], bought: Record<string, number> = {}, sold: Record<string, number> = {}; let cash = L.startingBalance;
  for (const f of L.fills) { if (!f.applied) continue; const v = f.price * f.qty; if (f.side === "buy") { bought[f.symbol] = (bought[f.symbol] ?? 0) + f.qty; if (cash !== null) cash -= v + (f.fee ?? 0); } else { sold[f.symbol] = (sold[f.symbol] ?? 0) + f.qty; if (cash !== null) cash += v - (f.fee ?? 0); } }
  if (cash !== null && L.cash !== null && Math.abs(cash - L.cash) > 1e-6) problems.push("cash differs from the fills: ledger " + L.cash + " vs recomputed " + cash);
  const diffs: Reconciliation["diffs"] = [];
  for (const sym of new Set([...Object.keys(bought), ...Object.keys(sold), ...Object.keys(L.positions)])) {
    const exp = (bought[sym] ?? 0) - (sold[sym] ?? 0), have = L.positions[sym]?.qty ?? 0;
    if (Math.abs(exp - have) > 1e-9) { problems.push(sym + " quantity differs from fills"); diffs.push({ symbol: sym, etiQty: have, exchangeQty: exp, delta: have - exp, note: "ledger vs fills" }); }
  }
  for (const o of Object.values(L.orders)) { const f = L.fills.filter(x => x.orderId === o.orderId).reduce((s, x) => s + x.qty, 0); if (Math.abs(f - o.filledQty) > 1e-9) problems.push("order " + o.orderId + " filled quantity differs from its fills"); }
  for (const o of Object.values(L.orders).filter(x => isActive(x) && x.side === "sell")) if (remainingQty(o) > (L.positions[o.symbol]?.qty ?? 0) + 1e-9) problems.push("sell order " + o.orderId + " exceeds the open position");
  if (L.cash !== null && L.cash < -1e-6) problems.push("negative cash");
  for (const a of L.anomalies) if (["sell_without_position", "oversell", "overfill"].includes(a.kind)) problems.push(a.kind + ": " + a.detail);
  return { environment: L.environment, checkedAt: now, ok: problems.length === 0, source: "ledger_self_check", exchange: null, diffs, problems };
}
export async function reconcile(env: EngineEnv, deps: EngineDeps, environment: Environment, now: number): Promise<Reconciliation> {
  const st = store(env, environment), { ledger: L } = await st.ledger();
  let rec: Reconciliation;
  if (environment === "internal_paper") rec = selfCheck(L, now);
  else {
    const venues = new Set(Object.values(L.positions).map(p => p.venue).concat(Object.values(L.orders).map(o => o.venue)));
    const useBinance = venues.has("binance_testnet") || (!venues.has("alpaca_paper") && hasKeys(env, "binance_testnet")), source = useBinance ? "binance_testnet" as const : "alpaca_paper" as const;
    rec = { environment, checkedAt: now, ok: false, source, exchange: null, diffs: [], problems: [] };
    if (!hasKeys(env, source)) rec.problems.push("Exchange testnet credentials are not configured: nothing to reconcile against.");
    else {
      try {
        if (source === "binance_testnet") {
          const r = await binanceGet(env, deps, "/api/v3/account", {});
          if (!r.ok) rec.problems.push("Binance testnet account query failed (HTTP " + r.status + ").");
          else {
            const bal: Record<string, number> = {}; for (const b of r.data.balances ?? []) { const t = fin(b.free) + fin(b.locked); if (t > 0) bal[String(b.asset)] = t; }
            rec.exchange = { balances: bal, canTrade: !!r.data.canTrade };
            for (const p of Object.values(L.positions).filter(x => x.venue === "binance_testnet")) { const q = quoteOf(p.symbol), base = q ? p.symbol.slice(0, -q.length) : p.symbol, ex = bal[base] ?? 0, d = p.qty - ex; rec.diffs.push({ symbol: p.symbol, etiQty: p.qty, exchangeQty: ex, delta: d, note: d > 1e-8 ? "ETI holds more than the exchange reports" : d < -1e-8 ? "exchange holds more than ETI tracks (pre-existing balance or outside trades; not counted in ETI P&L)" : "match" }); }
          }
        } else {
          const [a, ps] = await Promise.all([alpacaReq(env, deps, "/v2/account"), alpacaReq(env, deps, "/v2/positions")]);
          if (!a.ok || !ps.ok) rec.problems.push("Alpaca paper account query failed (HTTP " + (a.ok ? ps.status : a.status) + ").");
          else {
            rec.exchange = { cash: fin(a.data.cash), equity: fin(a.data.equity), buyingPower: fin(a.data.buying_power), positions: (ps.data as any[]).map(x => ({ symbol: x.symbol, qty: fin(x.qty), avgEntry: fin(x.avg_entry_price), unrealizedPl: fin(x.unrealized_pl) })) };
            const exq: Record<string, number> = {}; for (const x of ps.data as any[]) exq[String(x.symbol).replace("/", "")] = fin(x.qty);
            for (const p of Object.values(L.positions).filter(x => x.venue === "alpaca_paper")) { const ex = exq[p.symbol] ?? 0, d = p.qty - ex; rec.diffs.push({ symbol: p.symbol, etiQty: p.qty, exchangeQty: ex, delta: d, note: Math.abs(d) > 1e-8 ? "quantity differs from the broker" : "match" }); }
          }
        }
      } catch (e) { rec.problems.push("Reconciliation could not reach the exchange: " + (e instanceof Error ? e.message : "error")); }
    }
    for (const d of rec.diffs) if (d.note !== "match") rec.problems.push(d.symbol + ": " + d.note);
    for (const a of L.anomalies) if (["sell_without_position", "oversell", "overfill"].includes(a.kind)) rec.problems.push(a.kind + ": " + a.detail);
    rec.ok = rec.problems.length === 0 && rec.exchange !== null;
  }
  await st.kvPut("recon", rec, 60 * 60 * 24 * 30);
  return rec;
}
