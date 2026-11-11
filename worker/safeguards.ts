/**
 * In-process paper/testnet execution safeguards.
 *
 * Everything here runs inside the Worker. No separately hosted risk service is contacted, and no live broker host
 * is ever addressed: the only order venues are paper-api.alpaca.markets and testnet.binance.vision (spot) /
 * testnet.binancefuture.com (futures, see futures.ts).
 *
 * Safeguards provided to every paper/testnet order path:
 *   - duplicate protection  : one reservation per clientOrderId plus a short identical-order window (KV, best effort;
 *                             the brokers' own unique-client-order-id rule is the hard backstop)
 *   - balance / holdings    : the paper broker account is read before the order is sent; BUYs need free cash,
 *                             SELLs need held quantity (no short selling through the spot endpoint). If the account
 *                             cannot be read the order is refused (fail closed).
 *   - audit of refusals     : every refused order that reached the authenticated gateway is recorded under "reject:".
 */
import type { ExecutionEnv } from "./execution.ts";

export const ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets";
export const ALPACA_DATA_BASE = "https://data.alpaca.markets";
export const BINANCE_TESTNET_BASE = "https://testnet.binance.vision";
/**
 * Variables that configured the retired external risk gateway. They are never read for any decision: an old deployment
 * that still has them set keeps working, and the status endpoint just reports that they are ignored (so they can be deleted).
 */
export const LEGACY_GATEWAY_VARS = ["ETI_RISK_GATE_URL", "ETI_RISK_GATE_TOKEN"] as const;
export const legacyGatewayConfigPresent = (env: object): boolean => LEGACY_GATEWAY_VARS.some((k) => !!(env as Record<string, unknown>)[k]);
export const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 90;
/** Cloudflare KV cannot expire a key sooner than 60 seconds. */
export const KV_MIN_TTL_SECONDS = 60;
/** Cash held back for fees/slippage when checking a BUY. Market orders get a wider buffer because the fill price is unknown. */
export const LIMIT_BUY_BUFFER = 1.001;
export const MARKET_BUY_BUFFER = 1.01;

export interface SafeKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface OrderFacts {
  broker: "alpaca" | "binance" | "eti_paper";
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  quantity: number;
  limitPrice?: number;
  clientOrderId: string;
  actorId: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Window (seconds) in which an identical order from the same actor is treated as an accidental duplicate. 0 disables it. */
export function duplicateWindowSeconds(env: { ETI_DUPLICATE_WINDOW_SECONDS?: string }): number {
  const raw = env.ETI_DUPLICATE_WINDOW_SECONDS;
  if (raw === undefined || raw === "") return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60;
  return n === 0 ? 0 : Math.max(KV_MIN_TTL_SECONDS, Math.ceil(n));
}

// ---------------------------------------------------------------- duplicate protection
export interface Reservation { idKey: string; fpKey: string | null }
export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; error: "duplicate_client_order_id" | "duplicate_order_window"; state: string; detail: string };

const parse = (raw: string | null): { state?: string; at?: string } | null => {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch { return null; }
};
const isLive = (v: { state?: string } | null) => !!v && v.state !== "released";

async function fingerprintKey(o: OrderFacts): Promise<string> {
  return "fp:" + (await sha256Hex([o.broker, o.symbol, o.side, o.type, o.quantity, o.limitPrice ?? "", o.actorId].join("|")));
}

/**
 * Reserve an order before anything is sent. A clientOrderId can be used once: it stays reserved while the order is in
 * flight, after it executed, and when its outcome is unknown (timeout / 5xx), so an ambiguous submission is never
 * blindly re-sent. It is released only when the order is refused before reaching the broker or the broker definitively
 * rejected it.
 */
export async function reserveOrder(kv: SafeKV, o: OrderFacts, windowSeconds: number, now = Date.now()): Promise<ReserveResult> {
  const idKey = "idem:" + o.clientOrderId;
  const prior = parse(await kv.get(idKey));
  if (isLive(prior)) {
    return { ok: false, error: "duplicate_client_order_id", state: String(prior!.state), detail: `clientOrderId ${o.clientOrderId} was already used (state: ${prior!.state}${prior!.at ? " at " + prior!.at : ""}). Use a new clientOrderId for a new order.` };
  }
  let fpKey: string | null = null;
  if (windowSeconds > 0) {
    fpKey = await fingerprintKey(o);
    const seen = parse(await kv.get(fpKey));
    if (isLive(seen)) {
      return { ok: false, error: "duplicate_order_window", state: "recent", detail: `An identical ${o.side} ${o.quantity} ${o.symbol} order was submitted${seen!.at ? " at " + seen!.at : ""} (window ${windowSeconds}s). Wait for the window to pass or change the order.` };
    }
  }
  const at = new Date(now).toISOString();
  await kv.put(idKey, JSON.stringify({ state: "pending", at }), { expirationTtl: AUDIT_TTL_SECONDS });
  if (fpKey) await kv.put(fpKey, JSON.stringify({ state: "pending", at, clientOrderId: o.clientOrderId }), { expirationTtl: windowSeconds });
  return { ok: true, reservation: { idKey, fpKey } };
}

export async function settleReservation(kv: SafeKV, r: Reservation, state: "executed" | "indeterminate", extra: Record<string, unknown> = {}, now = Date.now()): Promise<void> {
  await kv.put(r.idKey, JSON.stringify({ state, at: new Date(now).toISOString(), ...extra }), { expirationTtl: AUDIT_TTL_SECONDS });
}

/** Free a reservation after a refusal that happened before the order could reach the broker. */
export async function releaseReservation(kv: SafeKV, r: Reservation): Promise<void> {
  for (const key of [r.idKey, r.fpKey]) {
    if (!key) continue;
    if (kv.delete) await kv.delete(key);
    else await kv.put(key, JSON.stringify({ state: "released" }), { expirationTtl: KV_MIN_TTL_SECONDS });
  }
}

// ---------------------------------------------------------------- audit of refused orders
export interface RejectionRecord {
  /** rejected = refused by ETI, broker never contacted; broker_rejected = broker answered 4xx; unknown = broker gave no definite answer. */
  outcome?: "rejected" | "broker_rejected" | "unknown";
  stage: string;
  error: string;
  reasons: string[];
  mode: "paper" | "testnet" | "futures_testnet" | "internal_paper" | "unknown";
  /** Which environment's history this record belongs to (omitted when the request never named a valid venue). */
  environment?: "internal_paper" | "exchange_testnet";
  brokerContacted?: boolean;
  brokerResponse?: unknown;
  request: Record<string, unknown>;
  executionSource?: Record<string, unknown> | null;
}
const clip = (v: unknown, n = 40) => (typeof v === "string" ? v.slice(0, n) : typeof v === "number" || typeof v === "boolean" ? v : null);

/** Whitelisted, length-limited summary of an untrusted request body for the audit log. */
export function summariseRequest(body: any): Record<string, unknown> {
  return {
    broker: clip(body?.broker), symbol: clip(body?.symbol), side: clip(body?.side), type: clip(body?.type), quantity: clip(body?.quantity),
    limitPrice: clip(body?.limitPrice), clientOrderId: typeof body?.clientOrderId === "string" && /^[A-Za-z0-9_-]{8,36}$/.test(body.clientOrderId) ? body.clientOrderId : null,
  };
}
export function summariseSource(src: any): Record<string, unknown> | null {
  if (!src || typeof src !== "object") return null;
  return { actorType: clip(src.actorType), actorId: clip(src.actorId, 80), sourceName: clip(src.sourceName, 80) };
}

/** Best effort: a failed audit write must never turn a refusal into a different outcome. Returns whether it was stored. */
export async function recordRejection(kv: SafeKV, rec: RejectionRecord, now = Date.now()): Promise<boolean> {
  const at = new Date(now).toISOString();
  try {
    await kv.put("reject:" + at + ":" + crypto.randomUUID().slice(0, 8), JSON.stringify({ outcome: "rejected", brokerContacted: false, at, ...rec }), { expirationTtl: AUDIT_TTL_SECONDS });
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- balance and holdings
export interface FundsEvidence {
  broker: "alpaca" | "binance";
  mode: "paper" | "testnet";
  accountStatus: string;
  cashAvailable: number | null;
  quoteAsset: string | null;
  holdingsAvailable: number | null;
  baseAsset: string | null;
  referencePrice: number | null;
  referenceSource: "limit_price" | "latest_trade" | "ticker" | null;
}
export type FundsLoad = { ok: true; evidence: FundsEvidence } | { ok: false; status: number; error: string; detail: string };

const finiteNum = (v: unknown) => { const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN; return Number.isFinite(n) ? n : NaN; };
const unavailable = (detail: string): FundsLoad => ({ ok: false, status: 503, error: "account_state_unavailable", detail: `${detail}; order refused because the paper account state could not be verified.` });

async function loadAlpaca(env: ExecutionEnv & { ALPACA_DATA_FEED?: string }, o: OrderFacts, fetch: typeof globalThis.fetch): Promise<FundsLoad> {
  const headers = { "APCA-API-KEY-ID": env.ALPACA_API_KEY as string, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY as string };
  const sig = () => AbortSignal.timeout(6000);
  try {
    const [acct, pos] = await Promise.all([
      fetch(`${ALPACA_PAPER_BASE}/v2/account`, { headers, signal: sig() }),
      fetch(`${ALPACA_PAPER_BASE}/v2/positions/${encodeURIComponent(o.symbol)}`, { headers, signal: sig() }),
    ]);
    if (!acct.ok) return unavailable(`Alpaca paper account HTTP ${acct.status}`);
    const a: any = await acct.json().catch(() => null);
    if (!a || a.status !== "ACTIVE" || a.trading_blocked === true || a.account_blocked === true) return { ok: false, status: 403, error: "paper_account_not_tradable", detail: "The Alpaca paper account is not active for trading." };
    const cash = finiteNum(a.buying_power);
    if (!Number.isFinite(cash)) return unavailable("Alpaca paper buying power missing");
    let held = 0;
    if (pos.status !== 404) {
      if (!pos.ok) return unavailable(`Alpaca paper position HTTP ${pos.status}`);
      const p: any = await pos.json().catch(() => null);
      held = finiteNum(p?.qty_available ?? p?.qty);
      if (!Number.isFinite(held)) return unavailable("Alpaca paper position quantity missing");
    }
    let price: number | null = null, source: FundsEvidence["referenceSource"] = null;
    if (o.side === "buy") {
      if (o.type === "limit") { price = o.limitPrice ?? null; source = "limit_price"; }
      else {
        const feed = /^[a-z]{2,6}$/.test(env.ALPACA_DATA_FEED ?? "") ? env.ALPACA_DATA_FEED : "iex";
        const r = await fetch(`${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(o.symbol)}/trades/latest?feed=${feed}`, { headers, signal: sig() });
        if (!r.ok) return unavailable(`Alpaca latest trade HTTP ${r.status}`);
        price = finiteNum(((await r.json().catch(() => null)) as any)?.trade?.p); source = "latest_trade";
        if (!(price > 0)) return unavailable("Alpaca latest trade price missing");
      }
    }
    return { ok: true, evidence: { broker: "alpaca", mode: "paper", accountStatus: String(a.status), cashAvailable: cash, quoteAsset: "USD", holdingsAvailable: Math.max(0, held), baseAsset: o.symbol, referencePrice: price, referenceSource: source } };
  } catch (e) { return unavailable(`Alpaca paper account unreachable (${e instanceof Error ? e.message : "error"})`); }
}

async function loadBinance(env: ExecutionEnv, o: OrderFacts, fetch: typeof globalThis.fetch): Promise<FundsLoad> {
  const key = env.BINANCE_API_KEY as string, secret = env.BINANCE_SECRET_KEY as string;
  const sig = () => AbortSignal.timeout(6000);
  try {
    const info = await fetch(`${BINANCE_TESTNET_BASE}/api/v3/exchangeInfo?symbol=${encodeURIComponent(o.symbol)}`, { signal: sig() });
    if (info.status === 400) return { ok: false, status: 400, error: "unknown_symbol", detail: `${o.symbol} is not a Binance Spot Testnet symbol.` };
    if (!info.ok) return unavailable(`Binance testnet exchangeInfo HTTP ${info.status}`);
    const row: any = ((await info.json().catch(() => null)) as any)?.symbols?.find?.((s: any) => s.symbol === o.symbol);
    if (!row?.baseAsset || !row?.quoteAsset) return { ok: false, status: 400, error: "unknown_symbol", detail: `${o.symbol} is not a Binance Spot Testnet symbol.` };
    if (row.status !== "TRADING") return { ok: false, status: 403, error: "symbol_not_tradable", detail: `${o.symbol} is not currently TRADING on the Binance Spot Testnet (status ${row.status}).` };
    const q = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: "5000" });
    q.set("signature", await hmacHex(secret, q.toString()));
    const acct = await fetch(`${BINANCE_TESTNET_BASE}/api/v3/account?${q.toString()}`, { headers: { "X-MBX-APIKEY": key }, signal: sig() });
    if (!acct.ok) return unavailable(`Binance testnet account HTTP ${acct.status}`);
    const a: any = await acct.json().catch(() => null);
    if (!a || a.canTrade !== true) return { ok: false, status: 403, error: "paper_account_not_tradable", detail: "The Binance testnet account cannot trade." };
    const free = (asset: string) => finiteNum((a.balances ?? []).find((b: any) => b.asset === asset)?.free ?? 0);
    const cash = free(String(row.quoteAsset)), held = free(String(row.baseAsset));
    if (!Number.isFinite(cash) || !Number.isFinite(held)) return unavailable("Binance testnet balances malformed");
    let price: number | null = null, source: FundsEvidence["referenceSource"] = null;
    if (o.side === "buy") {
      if (o.type === "limit") { price = o.limitPrice ?? null; source = "limit_price"; }
      else {
        const r = await fetch(`${BINANCE_TESTNET_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(o.symbol)}`, { signal: sig() });
        if (!r.ok) return unavailable(`Binance testnet ticker HTTP ${r.status}`);
        price = finiteNum(((await r.json().catch(() => null)) as any)?.price); source = "ticker";
        if (!(price > 0)) return unavailable("Binance testnet ticker price missing");
      }
    }
    return { ok: true, evidence: { broker: "binance", mode: "testnet", accountStatus: "TRADING", cashAvailable: cash, quoteAsset: String(row.quoteAsset), holdingsAvailable: held, baseAsset: String(row.baseAsset), referencePrice: price, referenceSource: source } };
  } catch (e) { return unavailable(`Binance testnet account unreachable (${e instanceof Error ? e.message : "error"})`); }
}

/** Read the paper broker's own account (cash + holdings for this symbol). Only paper/testnet hosts are contacted. */
export function loadPaperAccount(env: ExecutionEnv, o: OrderFacts, fetchImpl: typeof globalThis.fetch = (...a) => globalThis.fetch(...a)): Promise<FundsLoad> {
  return o.broker === "alpaca" ? loadAlpaca(env, o, fetchImpl) : loadBinance(env, o, fetchImpl);
}

export type FundsDecision = { ok: true; requiredFunds: number | null } | { ok: false; status: 403; error: "insufficient_balance" | "insufficient_holdings"; reasons: string[] };

/** Pure decision on a loaded account: BUYs need free cash; SELLs need held quantity (no shorting through the spot endpoint). */
export function evaluateFunds(o: OrderFacts, e: FundsEvidence): FundsDecision {
  if (o.side === "sell") {
    const held = e.holdingsAvailable ?? 0;
    if (!(o.quantity <= held + 1e-12)) return { ok: false, status: 403, error: "insufficient_holdings", reasons: [`Insufficient paper holdings: selling ${o.quantity} ${e.baseAsset ?? o.symbol} but only ${held} is available. Short selling is not supported by this endpoint.`] };
    return { ok: true, requiredFunds: null };
  }
  const price = e.referencePrice ?? NaN;
  if (!(price > 0)) return { ok: false, status: 403, error: "insufficient_balance", reasons: ["No reference price available to size the required balance."] };
  const required = o.quantity * price * (o.type === "limit" ? LIMIT_BUY_BUFFER : MARKET_BUY_BUFFER);
  const cash = e.cashAvailable ?? 0;
  if (!(required <= cash)) return { ok: false, status: 403, error: "insufficient_balance", reasons: [`Insufficient paper balance: this BUY needs about ${required.toFixed(2)} ${e.quoteAsset ?? ""} (including a ${o.type === "limit" ? "0.1" : "1"}% buffer) but only ${cash.toFixed(2)} is available.`.replace("  ", " ")] };
  return { ok: true, requiredFunds: required };
}
