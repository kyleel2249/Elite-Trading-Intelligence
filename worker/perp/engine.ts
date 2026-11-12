/**
 * Perpetual-futures engine for ETI INTERNAL PAPER (perp_paper): ETI simulates the venue.
 *  - Market orders fill at the live Binance USDT-M price +/- slippage as taker. Limit orders rest and fill as maker when a closed 1m bar trades
 *    through them. Stop orders (stop-market) trigger when a bar touches them and fill with slippage; a bar that gaps through fills at the open.
 *  - Within one bar the order is: liquidation, then stops, then limits (the conservative assumption).
 *  - Isolated margin, one-way mode, configurable maintenance rate. Funding is not simulated; fees are the configured taker/maker rates.
 * The testnet environment lives in testnet.ts and records only what the exchange reported.
 */
import { loadMinuteBars } from "../algo/market-inputs.ts";
import type { Kline } from "../market.ts";
import { PortfolioStore, openStore, type KVL } from "../portfolio/store.ts";
import { DEFAULT_MMR, availableBalance, dirOf, fold, isActive, liqPriceOf, remainingQty, type Ledger, type Order, type OrderType, type PerpEnvironment, type PerpEvent, type Side } from "./ledger.ts";

export interface PerpEnv {
  ETI_EXECUTION_LOG?: KVL | any; ETI_PORTFOLIO_DB?: any; ETI_PAPER_START_BALANCE?: string; ETI_PERP_FEE_TAKER_BPS?: string; ETI_PERP_FEE_MAKER_BPS?: string; ETI_PERP_SLIPPAGE_BPS?: string;
  ETI_PERP_MMR?: string; ETI_PERP_MAX_LEVERAGE?: string; ETI_PERP_MIN_NOTIONAL?: string; BINANCE_FUTURES_API_KEY?: string; BINANCE_FUTURES_SECRET_KEY?: string; ETI_KILL_SWITCH?: string;
}
export interface PerpDeps { now?: () => number; fetchImpl?: typeof fetch; priceOf?: (symbol: string) => Promise<number | null>; barsOf?: (symbol: string, now: number) => Promise<Kline[]> }
export const BAR_MS = 60_000;
const pos = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 && v !== "" && v !== null && v !== undefined ? n : d; };
export const perpConfig = (env: PerpEnv) => ({
  start: pos(env.ETI_PAPER_START_BALANCE, 10_000), takerBps: pos(env.ETI_PERP_FEE_TAKER_BPS, 5), makerBps: pos(env.ETI_PERP_FEE_MAKER_BPS, 2), slipBps: pos(env.ETI_PERP_SLIPPAGE_BPS, 5),
  mmr: Math.min(0.2, pos(env.ETI_PERP_MMR, DEFAULT_MMR)), maxLeverage: Math.min(125, Math.floor(pos(env.ETI_PERP_MAX_LEVERAGE, 50))), minNotional: pos(env.ETI_PERP_MIN_NOTIONAL, 5),
});
export const ID = { init: "e0i-", sub: "e1s-", acc: "e2a-", fill: "e3f-", end: "e4x-", mark: "e5m-" };
export const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
export const perpStore = (env: PerpEnv, e: PerpEnvironment): PortfolioStore => { const s = openStore(env as any, e as any); if (!s) throw new Error("no portfolio storage configured (bind ETI_PORTFOLIO_DB or ETI_EXECUTION_LOG)"); return s; };
export const perpLedger = async (st: PortfolioStore, e: PerpEnvironment) => { const { events } = await st.events(); return { events: events as unknown as PerpEvent[], ledger: fold(e, events as unknown as PerpEvent[]) }; };
const append = (st: PortfolioStore, ev: PerpEvent, idem = true) => st.append(ev as any, { idempotent: idem });
/** Events are applied in (at, id) order, so every new event must be strictly later than anything already recorded: same-millisecond writes must not reorder an open and its close. */
export const nextAt = (events: PerpEvent[], now: number) => events.reduce((m, e) => e.at >= m ? e.at + 1 : m, now);
export const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;

export async function futuresPrice(env: PerpEnv, deps: PerpDeps, symbol: string, now: number): Promise<number | null> {
  try { if (deps.priceOf) return await deps.priceOf(symbol); return (await loadMinuteBars(env as any, symbol, null, now, "futures")).price; } catch { return null; }
}
async function futuresBars(env: PerpEnv, deps: PerpDeps, symbol: string, now: number): Promise<{ bars: Kline[]; price: number | null }> {
  try {
    if (deps.barsOf) { const bars = (await deps.barsOf(symbol, now)).filter(k => k[0] + BAR_MS <= now).sort((a, b) => a[0] - b[0]); const last = bars.at(-1); return { bars, price: last && now - last[0] <= 3 * BAR_MS ? last[4] : null }; }
    const r = await loadMinuteBars(env as any, symbol, null, now, "futures"); return { bars: r.bars.sort((a, b) => a[0] - b[0]), price: r.price };
  } catch { return { bars: [], price: null }; }
}
export async function ensurePaperInit(env: PerpEnv, now: number) {
  const st = perpStore(env, "perp_paper"), c = perpConfig(env);
  await append(st, { id: ID.init + "start", at: now, t: "init", startingBalance: c.start, currency: "USDT", mmr: c.mmr });
  return st;
}

export interface PerpOrderInput { clientOrderId: string; symbol: string; side: Side; type: OrderType; qty: number; limitPrice?: number | null; stopPrice?: number | null; leverage: number; reduceOnly: boolean; source?: string | null }
/** Shape and range checks shared by paper and testnet. Returns an error message or null. */
export function validateInput(i: PerpOrderInput, maxLeverage: number): string | null {
  if (!SYMBOL_RE.test(i.symbol)) return "Enter a valid futures symbol such as BTCUSDT.";
  if (i.side !== "buy" && i.side !== "sell") return "Side must be buy (long) or sell (short).";
  if (!["market", "limit", "stop"].includes(i.type)) return "Order type must be market, limit or stop.";
  if (!(Number.isFinite(i.qty) && i.qty > 0)) return "Quantity must be greater than zero.";
  if (!Number.isInteger(i.leverage) || i.leverage < 1 || i.leverage > maxLeverage) return "Leverage must be a whole number from 1 to " + maxLeverage + ".";
  if (i.type === "limit" && !(Number.isFinite(i.limitPrice) && i.limitPrice! > 0)) return "A limit order needs a positive limit price.";
  if (i.type === "stop" && !(Number.isFinite(i.stopPrice) && i.stopPrice! > 0)) return "A stop order needs a positive stop price.";
  return null;
}
export interface Estimate { refPrice: number | null; fillPrice: number | null; notional: number | null; openQty: number; margin: number | null; fee: number | null; liqPrice: number | null; available: number | null; resultingSide: "long" | "short" | null }
/** What an order would do to the account: price, margin it needs, fee, and the liquidation price of the resulting position. Pure; no writes. */
export function estimate(L: Ledger, i: PerpOrderInput, px: number | null, cfg: ReturnType<typeof perpConfig>): Estimate {
  const taker = i.type !== "limit" || (px !== null && (i.side === "buy" ? i.limitPrice! >= px : i.limitPrice! <= px));
  const ref = i.type === "limit" ? i.limitPrice! : i.type === "stop" ? i.stopPrice! : px;
  const fillPrice = ref === null ? null : i.type === "market" ? ref * (i.side === "buy" ? 1 + cfg.slipBps / 1e4 : 1 - cfg.slipBps / 1e4) : ref;
  const p = L.positions[i.symbol], dir = dirOf(i.side), opposite = p && p.side !== dir ? p.qty : 0, openQty = i.reduceOnly ? 0 : Math.max(0, i.qty - opposite);
  const notional = fillPrice === null ? null : i.qty * fillPrice, margin = fillPrice === null ? null : openQty * fillPrice / i.leverage;
  const fee = notional === null ? null : notional * (taker ? cfg.takerBps : cfg.makerBps) / 1e4;
  let liq: number | null = null, side: "long" | "short" | null = null;
  if (fillPrice !== null && !i.reduceOnly) {
    if (openQty > 0) {
      const same = p && p.side === dir ? p : null, q = (same?.qty ?? 0) + openQty, avg = ((same?.avgEntry ?? 0) * (same?.qty ?? 0) + fillPrice * openQty) / q, m = (same?.margin ?? 0) + margin!;
      liq = liqPriceOf(dir, avg, q, m, L.mmr); side = dir;
    } else if (p) { side = p.side; }
  }
  return { refPrice: px, fillPrice, notional, openQty, margin, fee, liqPrice: liq, available: availableBalance(L), resultingSide: side };
}

export type PlaceResult =
  | { ok: true; order: Order; filledNow: boolean; marketPrice: number | null; estimate: Estimate }
  | { ok: false; status: number; code: string; message: string; order?: Order; marketPrice?: number | null; estimate?: Estimate };

export async function placePaper(env: PerpEnv, deps: PerpDeps, inp: PerpOrderInput, now: number): Promise<PlaceResult> {
  const cfg = perpConfig(env), bad = validateInput(inp, cfg.maxLeverage);
  if (bad) return { ok: false, status: 400, code: "invalid_order", message: bad };
  const st = await ensurePaperInit(env, now), orderId = "pperp-" + inp.clientOrderId, { ledger: L0, events: E0 } = await perpLedger(st, "perp_paper"), at = nextAt(E0, now);
  if (L0.orders[orderId]) return { ok: false, status: 409, code: "duplicate_client_order_id", message: "This clientOrderId was already used." };
  const px = await futuresPrice(env, deps, inp.symbol, now);
  if (!(px && px > 0)) return { ok: false, status: 503, code: "price_unavailable", marketPrice: null, message: "No fresh Binance futures price for " + inp.symbol + ". Check that the symbol is a listed USDT-M perpetual." };
  const est = estimate(L0, inp, px, cfg), p = L0.positions[inp.symbol], dir = dirOf(inp.side);
  const refuse = (code: string, message: string, status = 422): PlaceResult => ({ ok: false, status, code, message, marketPrice: px, estimate: est });
  if (inp.reduceOnly && (!p || p.side === dir)) return refuse("reduce_only_rejected", "Reduce-only needs an open " + (dir === "long" ? "short" : "long") + " position on " + inp.symbol + " to reduce.");
  if (inp.reduceOnly && p && inp.qty > p.qty + 1e-12) return refuse("reduce_only_rejected", "Reduce-only quantity " + inp.qty + " exceeds the open position (" + p.qty + ").");
  if (!inp.reduceOnly && p && p.side === dir && p.leverage !== inp.leverage) return refuse("leverage_conflict", "You hold a " + p.side + " " + inp.symbol + " position at " + p.leverage + "x. Use " + p.leverage + "x to add to it, or close it first to change leverage.");
  if (!inp.reduceOnly && est.notional !== null && est.notional < cfg.minNotional) return refuse("below_min_notional", "Order value " + est.notional.toFixed(2) + " USDT is below the minimum " + cfg.minNotional + " USDT.");
  if (inp.type === "stop" && (inp.side === "sell" ? px <= inp.stopPrice! : px >= inp.stopPrice!)) return refuse("stop_would_trigger_immediately", "A " + (inp.side === "sell" ? "sell" : "buy") + " stop must be " + (inp.side === "sell" ? "below" : "above") + " the current price (" + px + ").");
  if (est.margin !== null && est.fee !== null && est.margin + est.fee > (est.available ?? 0) + 1e-9) return refuse("insufficient_margin", "Needs " + (est.margin + est.fee).toFixed(2) + " USDT of margin and fees, available " + (est.available ?? 0).toFixed(2) + " USDT.");
  const evSub: PerpEvent = { id: ID.sub + orderId, at, t: "submitted", orderId, clientOrderId: inp.clientOrderId, symbol: inp.symbol, side: inp.side, type: inp.type, qty: inp.qty, limitPrice: inp.limitPrice ?? null, stopPrice: inp.stopPrice ?? null, reduceOnly: inp.reduceOnly, leverage: inp.leverage, refPrice: px, venue: "eti_paper_futures", source: inp.source ?? "dashboard" };
  await append(st, evSub); await append(st, { id: ID.acc + orderId, at, t: "accepted", orderId, brokerOrderId: orderId, status: "open" });
  const marketable = inp.type === "market" || (inp.type === "limit" && (inp.side === "buy" ? inp.limitPrice! >= px : inp.limitPrice! <= px));
  if (marketable) {
    const price = inp.type === "market" ? est.fillPrice! : inp.side === "buy" ? Math.min(inp.limitPrice!, px * (1 + cfg.slipBps / 1e4)) : Math.max(inp.limitPrice!, px * (1 - cfg.slipBps / 1e4));
    await append(st, { id: ID.fill + orderId + "-1", at, t: "fill", orderId, fillId: "1", qty: inp.qty, price, fee: price * inp.qty * cfg.takerBps / 1e4, liquidity: "taker", verified: true, origin: "internal_sim" });
  }
  return { ok: true, order: (await perpLedger(st, "perp_paper")).ledger.orders[orderId], filledNow: marketable, marketPrice: px, estimate: est };
}

export async function cancelPaper(env: PerpEnv, orderId: string, now: number) {
  const st = perpStore(env, "perp_paper"), { ledger: L, events: E } = await perpLedger(st, "perp_paper"), o = L.orders[orderId];
  if (!o) return { ok: false as const, status: 404, code: "order_not_found", message: "No such order." };
  if (!isActive(o)) return { ok: false as const, status: 409, code: "order_not_active", message: "The order is already " + o.status + "." };
  await append(st, { id: ID.end + orderId, at: nextAt(E, now), t: "cancelled", orderId, reason: "user_cancelled" });
  return { ok: true as const, order: (await perpLedger(st, "perp_paper")).ledger.orders[orderId] };
}

/** Walk closed 1m bars since each symbol's cursor: liquidations, stops, then limits. Safe to call repeatedly. */
export async function matchPaper(env: PerpEnv, deps: PerpDeps = {}, now = (deps.now ?? Date.now)()) {
  const st = perpStore(env, "perp_paper"), cfg = perpConfig(env), out = { symbols: 0, fills: 0, cancelled: 0, liquidations: 0, idle: true };
  const first = await perpLedger(st, "perp_paper"); if (!first.events.length) return out;
  const evs = [...first.events]; let L: Ledger = first.ledger;
  const apply = async (ev: PerpEvent) => { ev = { ...ev, at: nextAt(evs, ev.at) }; if (await append(st, ev)) { evs.push(ev); L = fold("perp_paper", evs); return true; } return false; };
  const symbols = new Set<string>([...Object.values(L.orders).filter(isActive).map(o => o.symbol), ...Object.keys(L.positions)]);
  const prices: Record<string, number> = {};
  for (const symbol of symbols) {
    out.idle = false; out.symbols++;
    const { bars, price } = await futuresBars(env, deps, symbol, now); if (price) prices[symbol] = price; if (!bars.length) continue;
    const cursor = await st.kvGet<number>("cur:" + symbol, 0);
    for (const bar of bars) {
      const [openT, open, high, low] = bar, close = openT + BAR_MS; if (openT < cursor) continue;
      const p = L.positions[symbol];
      if (p && openT >= p.updatedAt && (p.side === "long" ? low <= p.liqPrice : high >= p.liqPrice) && p.liqPrice > 0) {  // 1. liquidation
        const id = "liq-" + symbol + "-" + close, side: Side = p.side === "long" ? "sell" : "buy";
        await apply({ id: ID.sub + id, at: close, t: "submitted", orderId: id, clientOrderId: id, symbol, side, type: "market", qty: p.qty, reduceOnly: true, leverage: p.leverage, venue: "eti_paper_futures", reason: "liquidation", source: "engine" });
        await apply({ id: ID.acc + id, at: close, t: "accepted", orderId: id, brokerOrderId: id, status: "open" });
        if (await apply({ id: ID.fill + id + "-1", at: close, t: "fill", orderId: id, fillId: "1", qty: p.qty, price: p.liqPrice, fee: 0, liquidity: "taker", verified: true, origin: "liquidation" })) { out.liquidations++; out.fills++; }
      }
      const active = Object.values(L.orders).filter(o => isActive(o) && o.symbol === symbol && o.createdAt <= openT).sort((a, b) => a.createdAt - b.createdAt);
      const fillOrder = async (o: Order, price: number, liquidity: "maker" | "taker") => {
        const cur = L.positions[symbol], dir = dirOf(o.side);
        if (o.reduceOnly && (!cur || cur.side === dir)) { if (await apply({ id: ID.end + o.orderId, at: close, t: "cancelled", orderId: o.orderId, reason: "reduce_only_no_position" })) out.cancelled++; return; }
        const qty = o.reduceOnly && cur ? Math.min(remainingQty(o), cur.qty) : remainingQty(o);
        if (!o.reduceOnly) {
          const own = remainingQty(o) * (o.limitPrice ?? o.stopPrice ?? o.refPrice ?? price) / o.leverage, opp = cur && cur.side !== dir ? cur.qty : 0, openQty = Math.max(0, qty - opp);
          const need = openQty * price / o.leverage + price * qty * (liquidity === "maker" ? cfg.makerBps : cfg.takerBps) / 1e4;
          if (need > (availableBalance(L) ?? 0) + own + 1e-9) { if (await apply({ id: ID.end + o.orderId, at: close, t: "rejected", orderId: o.orderId, reason: "insufficient_margin_at_fill" })) out.cancelled++; return; }
        }
        if (await apply({ id: ID.fill + o.orderId + "-" + close, at: close, t: "fill", orderId: o.orderId, fillId: String(close), qty, price, fee: price * qty * (liquidity === "maker" ? cfg.makerBps : cfg.takerBps) / 1e4, liquidity, verified: true, origin: "internal_sim" })) out.fills++;
      };
      for (const o of active.filter(x => x.type === "stop" && x.stopPrice)) {           // 2. stops
        if (!isActive(L.orders[o.orderId])) continue;
        if (o.side === "sell" && low <= o.stopPrice!) await fillOrder(L.orders[o.orderId], Math.min(open, o.stopPrice!) * (1 - cfg.slipBps / 1e4), "taker");
        else if (o.side === "buy" && high >= o.stopPrice!) await fillOrder(L.orders[o.orderId], Math.max(open, o.stopPrice!) * (1 + cfg.slipBps / 1e4), "taker");
      }
      for (const o of active.filter(x => x.type === "limit" && x.limitPrice)) {         // 3. limits (fill at the limit price, a conservative assumption)
        if (!isActive(L.orders[o.orderId])) continue;
        if ((o.side === "buy" && low <= o.limitPrice!) || (o.side === "sell" && high >= o.limitPrice!)) await fillOrder(L.orders[o.orderId], o.limitPrice!, "maker");
      }
    }
    await st.kvPut("cur:" + symbol, bars.at(-1)![0] + BAR_MS);
  }
  if (Object.keys(prices).length && Object.keys(L.positions).length) { const last = await st.kvGet<number>("lastmark", 0); if (now - last >= 300_000) { await append(st, { id: ID.mark + now, at: now, t: "mark", prices }); await st.kvPut("lastmark", now); } }
  const finalL = fold("perp_paper", evs); out.idle = out.idle || (!Object.values(finalL.orders).some(isActive) && !Object.keys(finalL.positions).length);
  return out;
}
