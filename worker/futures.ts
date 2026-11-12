/**
 * ETI futures gateway: Binance USD-M Futures TESTNET only (fixed URL). There is no live route.
 * Supports BUY / SELL / SHORT / COVER with one-way mode, isolated margin, limit orders, reduce-only exits.
 * Deterministic hard limits here are final: neither the agents nor the caller can relax them. They run in-process
 * together with duplicate-order protection and the kill switch; no separately hosted risk service is involved.
 * Refused orders never reach the exchange and are audited under "reject:". No withdrawal, transfer or wallet endpoints are called.
 */
import type { ExecutionEnv } from "./execution.ts";
import { journalExecution, journalRejection } from "./journal/hooks.ts";
import { AUDIT_TTL_SECONDS, duplicateWindowSeconds, recordRejection, releaseReservation, reserveOrder, settleReservation, summariseRequest, summariseSource, type OrderFacts, type Reservation, type SafeKV } from "./safeguards.ts";

export interface FuturesEnv extends ExecutionEnv {
  BINANCE_FUTURES_API_KEY?: string; BINANCE_FUTURES_SECRET_KEY?: string;
  ETI_FUTURES_ENABLED?: string; ETI_FUTURES_MAX_LEVERAGE?: string; ETI_FUTURES_MAX_NOTIONAL_USD?: string;
}
export const FUTURES_BASE = "https://testnet.binancefuture.com";
export const HARD_MAX_LEVERAGE = 5;
export type Intent = "BUY" | "SELL" | "SHORT" | "COVER";

/** BUY opens/increases a long, SELL reduces/closes a long, SHORT opens/increases a short, COVER reduces/closes a short (one-way mode). */
export function classifyIntent(side: "buy" | "sell", positionAmt: number): Intent {
  if (side === "buy") return positionAmt < 0 ? "COVER" : "BUY";
  return positionAmt > 0 ? "SELL" : "SHORT";
}
/** Approximation of an isolated-margin liquidation price (maintenance-margin tiers vary; the exchange-reported price is preferred when a position exists). */
export function estimateLiquidation(entry: number, leverage: number, side: "buy" | "sell", mmr = 0.005): number {
  return side === "buy" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export interface FuturesState {
  positionAmt: number; entryPrice: number; markPrice: number; liquidationPrice: number; leverage: number; marginType: string;
  availableBalance: number; walletBalance: number; fundingRate: number; canTrade: boolean; dualSide: boolean;
}
export interface FuturesOrder { side: "buy" | "sell"; quantity: number; limitPrice: number; reduceOnly: boolean; leverage: number; stopPrice?: number }
export interface FuturesCaps { maxLeverage: number; maxNotionalUsd: number; mmr?: number }
export type HardCheck = { ok: true; intent: Intent; notionalUsd: number; estLiquidation: number | null; warnings: string[] } | { ok: false; reasons: string[] };

export function futuresHardChecks(o: FuturesOrder, s: FuturesState, c: FuturesCaps): HardCheck {
  const r: string[] = [], w: string[] = [], pos = s.positionAmt, intent = classifyIntent(o.side, pos);
  const opposes = (o.side === "buy" && pos < 0) || (o.side === "sell" && pos > 0), notional = o.quantity * o.limitPrice;
  if (!s.canTrade) r.push("account_cannot_trade");
  if (s.dualSide) r.push("hedge_mode_unsupported");
  if (!(s.markPrice > 0) || Math.abs(o.limitPrice - s.markPrice) / s.markPrice > 0.02) r.push("limit_price_far_from_mark");
  if (!(o.quantity > 0) || !(o.limitPrice > 0)) r.push("invalid_quantity_or_price");
  if (o.reduceOnly) {
    if (pos === 0) r.push("reduce_only_without_position");
    else if (!opposes) r.push("reduce_only_must_oppose_position");
    else if (o.quantity > Math.abs(pos) + 1e-12) r.push("reduce_quantity_exceeds_position");
    return r.length ? { ok: false, reasons: r } : { ok: true, intent, notionalUsd: notional, estLiquidation: null, warnings: w };
  }
  if (opposes) { r.push("opposing_order_must_be_reduce_only"); return { ok: false, reasons: r }; }
  if (!Number.isInteger(o.leverage) || o.leverage < 1 || o.leverage > c.maxLeverage) r.push("leverage_above_cap");
  if (!(notional > 0) || notional > c.maxNotionalUsd) r.push("notional_above_cap");
  if (pos !== 0 && s.marginType.toLowerCase() !== "isolated") r.push("existing_position_not_isolated");
  if (pos !== 0 && o.leverage !== s.leverage) r.push("leverage_mismatch_with_open_position");
  const stop = o.stopPrice, stopOk = typeof stop === "number" && stop > 0 && (o.side === "buy" ? stop < o.limitPrice : stop > o.limitPrice);
  if (!stopOk) r.push("protective_stop_price_required");
  if (Math.abs(pos) * s.markPrice + notional > c.maxNotionalUsd) r.push("total_exposure_above_cap");
  if (notional / o.leverage > 0.5 * s.availableBalance) r.push("insufficient_margin_buffer");
  const same = pos !== 0, entry = same ? (Math.abs(pos) * s.entryPrice + o.quantity * o.limitPrice) / (Math.abs(pos) + o.quantity) : o.limitPrice;
  let liq = estimateLiquidation(entry, o.leverage, o.side, c.mmr ?? 0.005);
  if (same && s.liquidationPrice > 0) liq = o.side === "buy" ? Math.max(liq, s.liquidationPrice) : Math.min(liq, s.liquidationPrice);
  if (stopOk) {
    const gap = Math.abs(o.limitPrice - (stop as number));
    if (!(o.side === "buy" ? liq <= (stop as number) - gap : liq >= (stop as number) + gap)) r.push("liquidation_too_close_to_stop");
  }
  const adverse = o.side === "buy" ? s.fundingRate : -s.fundingRate;
  if (adverse > 0.001) r.push("adverse_funding_extreme"); else if (adverse > 0.0003) w.push(`Funding ${(s.fundingRate * 100).toFixed(4)}% per 8h works against this position.`);
  return r.length ? { ok: false, reasons: r } : { ok: true, intent, notionalUsd: notional, estLiquidation: liq, warnings: w };
}

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
const fmt = (n: number) => { const s = String(n); return /e/i.test(s) ? n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") : s; };
async function authorized(req: Request, env: FuturesEnv): Promise<boolean> {
  const token = env.ETI_EXECUTION_TOKEN, supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function hmacHex(secret: string, q: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(q)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function signed(env: FuturesEnv, method: "GET" | "POST", path: string, params: Record<string, string>): Promise<Response> {
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" });
  q.set("signature", await hmacHex(env.BINANCE_FUTURES_SECRET_KEY as string, q.toString()));
  const headers = { "X-MBX-APIKEY": env.BINANCE_FUTURES_API_KEY as string };
  return method === "GET"
    ? fetch(FUTURES_BASE + path + "?" + q.toString(), { headers, signal: AbortSignal.timeout(6000) })
    : fetch(FUTURES_BASE + path, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: q.toString(), signal: AbortSignal.timeout(6000) });
}

/** Read-only account/position/funding snapshot. Returns null on any failure (callers must fail closed). */
export async function loadFuturesState(env: FuturesEnv, symbol: string): Promise<FuturesState | null> {
  if (!env.BINANCE_FUTURES_API_KEY || !env.BINANCE_FUTURES_SECRET_KEY) return null;
  try {
    const [acc, pos, dual, prem] = await Promise.all([
      signed(env, "GET", "/fapi/v2/account", {}), signed(env, "GET", "/fapi/v2/positionRisk", { symbol }), signed(env, "GET", "/fapi/v1/positionSide/dual", {}),
      fetch(FUTURES_BASE + "/fapi/v1/premiumIndex?symbol=" + encodeURIComponent(symbol), { signal: AbortSignal.timeout(6000) }),
    ]);
    if (!acc.ok || !pos.ok || !dual.ok || !prem.ok) return null;
    const a: any = await acc.json(), p: any = await pos.json(), d: any = await dual.json(), m: any = await prem.json();
    const row = Array.isArray(p) ? p.find((x: any) => x.symbol === symbol) : null, n = (v: unknown) => Number(v);
    const s: FuturesState = {
      positionAmt: n(row?.positionAmt ?? 0), entryPrice: n(row?.entryPrice ?? 0), markPrice: n(m.markPrice), liquidationPrice: n(row?.liquidationPrice ?? 0), leverage: n(row?.leverage ?? 0),
      marginType: String(row?.marginType ?? "none"), availableBalance: n(a.availableBalance), walletBalance: n(a.totalWalletBalance), fundingRate: n(m.lastFundingRate), canTrade: a.canTrade === true, dualSide: d.dualSidePosition === true,
    };
    return [s.positionAmt, s.entryPrice, s.markPrice, s.liquidationPrice, s.leverage, s.availableBalance, s.walletBalance, s.fundingRate].every(Number.isFinite) && s.markPrice > 0 ? s : null;
  } catch { return null; }
}

function caps(env: FuturesEnv): FuturesCaps | null {
  const lev = Math.min(Number(env.ETI_FUTURES_MAX_LEVERAGE ?? "3"), HARD_MAX_LEVERAGE), notional = Number(env.ETI_FUTURES_MAX_NOTIONAL_USD ?? "");
  return Number.isFinite(lev) && lev >= 1 && Number.isFinite(notional) && notional > 0 ? { maxLeverage: Math.floor(lev), maxNotionalUsd: notional } : null;
}

export async function handleFutures(req: Request, env: FuturesEnv): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  const ready = !!(env.BINANCE_FUTURES_API_KEY && env.BINANCE_FUTURES_SECRET_KEY);
  if (path === "/api/futures/status" && req.method === "GET")
    return reply({ mode: "binance_futures_testnet_only", enabled: env.ETI_FUTURES_ENABLED === "true", credentials_configured: ready, caps_configured: !!caps(env), max_leverage_hard_cap: HARD_MAX_LEVERAGE, external_risk_gateway: false, safeguards: { engine: "in_process", hard_limits: !!caps(env), duplicate_protection: true, duplicate_window_seconds: duplicateWindowSeconds(env) }, audit_log_configured: !!env.ETI_EXECUTION_LOG, kill_switch: env.ETI_KILL_SWITCH === "true", live_futures: false, withdrawal_permissions: false });
  if (path === "/api/futures/positions" || path === "/api/futures/reconcile") {
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
    if (!ready) return reply({ error: "futures_credentials_not_configured" }, 503);
    const pr = await signed(env, "GET", "/fapi/v2/positionRisk", {}).catch(() => null);
    if (!pr || !pr.ok) return reply({ error: "futures_state_unavailable" }, 503);
    const rows: any[] = ((await pr.json()) as any[]).filter((x) => Number(x.positionAmt) !== 0);
    const positions = rows.map((x) => {
      const mark = Number(x.markPrice), liq = Number(x.liquidationPrice), amt = Number(x.positionAmt), dist = liq > 0 && mark > 0 ? (Math.abs(mark - liq) / mark) * 100 : null;
      return { symbol: x.symbol, direction: amt > 0 ? "long" : "short", positionAmt: amt, entryPrice: Number(x.entryPrice), markPrice: mark, liquidationPrice: liq || null, leverage: Number(x.leverage), marginType: x.marginType, unrealizedPnl: Number(x.unRealizedProfit), liquidationDistancePct: dist, liquidationRisk: dist === null ? "unknown" : dist < 8 ? "critical" : dist < 15 ? "warning" : "ok" };
    });
    if (path === "/api/futures/positions") return reply({ positions, note: "Point-in-time snapshot; no background monitor runs. Poll this endpoint." });
    const oo = await signed(env, "GET", "/fapi/v1/openOrders", {}).catch(() => null);
    const open = oo && oo.ok ? ((await oo.json()) as any[]).map((o) => ({ symbol: o.symbol, side: o.side, price: o.price, origQty: o.origQty, reduceOnly: o.reduceOnly, clientOrderId: o.clientOrderId })) : null;
    let audited: Set<string> | null = null;
    if (env.ETI_EXECUTION_LOG) {
      const listed = await env.ETI_EXECUTION_LOG.list({ prefix: "order:", limit: 100 });
      const recs = await Promise.all(listed.keys.map(async (k) => JSON.parse((await env.ETI_EXECUTION_LOG!.get(k.name)) || "null")));
      audited = new Set(recs.filter((r) => r && r.mode === "futures_testnet").map((r) => r.symbol));
    }
    return reply({ positions, openOrders: open, unauditedPositions: audited ? positions.filter((p) => !audited!.has(p.symbol)).map((p) => p.symbol) : null, note: "Compares exchange positions with the ETI audit log (last 100 records); positions with no audited ETI futures order were not opened through ETI." });
  }
  if (path !== "/api/futures/orders") return reply({ error: "not_found" }, 404);
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (env.ETI_KILL_SWITCH === "true") return reply({ error: "execution_disabled", reason: "Emergency kill switch is active" }, 423);
  if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
  if (env.ETI_FUTURES_ENABLED !== "true") return reply({ error: "futures_disabled", message: "Set ETI_FUTURES_ENABLED=true after testnet validation to enable futures orders." }, 423);
  if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured" }, 503);
  if (!ready) return reply({ error: "futures_credentials_not_configured" }, 503);
  const cp = caps(env); if (!cp) return reply({ error: "futures_caps_not_configured", message: "Set ETI_FUTURES_MAX_NOTIONAL_USD (and optionally ETI_FUTURES_MAX_LEVERAGE, hard cap 5)." }, 503);
  const kv = env.ETI_EXECUTION_LOG as unknown as SafeKV;
  let b: any; try { b = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); }
  const symbol = typeof b?.symbol === "string" ? b.symbol.toUpperCase() : "", side = b?.side, quantity = Number(b?.quantity), limitPrice = Number(b?.limitPrice), leverage = Number(b?.leverage);
  const reduceOnly = b?.reduceOnly === true, stopPrice = b?.stopPrice === undefined ? undefined : Number(b.stopPrice), src = b?.executionSource;

  let reservation: Reservation | null = null;
  /** Refuse before the exchange is contacted: free any reservation, audit the refusal, answer. */
  const refuse = async (stage: string, status: number, error: string, reasons: string[], extra: Record<string, unknown> = {}) => {
    if (reservation) { await releaseReservation(kv, reservation).catch(() => undefined); reservation = null; }
    const recorded = await recordRejection(kv, { stage, error, reasons, mode: "futures_testnet", request: summariseRequest(b), executionSource: summariseSource(src) }, undefined, (k, r) => journalRejection(env, k, r));
    return reply({ ok: false, outcome: "rejected", error, stage, message: reasons[0], reasons, broker_contacted: false, audit_recorded: recorded, ...extra }, status);
  };

  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !["buy", "sell"].includes(side) || !(quantity > 0) || !(limitPrice > 0) || !/^[A-Za-z0-9_-]{8,36}$/.test(b?.clientOrderId ?? "") || b?.riskConfirmed !== true || (stopPrice !== undefined && !(stopPrice > 0)))
    return refuse("validation", 400, "invalid_order", ["Provide symbol, buy/sell, positive quantity and limitPrice, unique clientOrderId, riskConfirmed:true (and stopPrice when opening or increasing)."]);
  if (!src || !["manual_user", "strategy", "system", "automation"].includes(src.actorType) || typeof src.actorId !== "string" || !src.actorId.trim() || typeof src.sourceName !== "string" || !src.sourceName.trim())
    return refuse("validation", 400, "execution_source_required", ["Identify who or what initiated the order using executionSource.actorType, actorId and sourceName."]);
  const st = await loadFuturesState(env, symbol); if (!st) return refuse("account", 503, "futures_state_unavailable", ["Account, position, funding or mark price could not be read; failing closed."]);
  const check = futuresHardChecks({ side, quantity, limitPrice, reduceOnly, leverage: reduceOnly ? (st.leverage || 1) : leverage, stopPrice }, st, cp);
  if (!check.ok) return refuse("hard_limits", 403, "futures_risk_limit_rejected", check.reasons);
  if (b.intent !== undefined && b.intent !== check.intent) return refuse("validation", 400, "intent_mismatch", [`Order is ${check.intent}, not ${String(b.intent).slice(0, 20)}.`], { expected: check.intent, supplied: b.intent });

  const facts: OrderFacts = { broker: "binance", symbol: "fut:" + symbol, side, type: "limit", quantity, limitPrice, clientOrderId: b.clientOrderId, actorId: src.actorId.trim() };
  try {
    const reserved = await reserveOrder(kv, facts, duplicateWindowSeconds(env));
    if (!reserved.ok) return refuse("duplicate", 409, reserved.error, [reserved.detail], { state: reserved.state });
    reservation = reserved.reservation;
  } catch { return refuse("duplicate", 503, "duplicate_check_unavailable", ["Duplicate-order protection could not be verified; order refused."]); }

  let orderSent = false;
  try {
    if (!reduceOnly) {
      if (st.positionAmt === 0 && st.marginType.toLowerCase() !== "isolated") {
        const m = await signed(env, "POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" }), mj: any = await m.json().catch(() => ({}));
        if (!m.ok && mj?.code !== -4046) { await releaseReservation(kv, reservation!).catch(() => undefined); return reply({ error: "margin_setup_failed", detail: mj }, 502); }
      }
      if (st.leverage !== leverage) {
        const l = await signed(env, "POST", "/fapi/v1/leverage", { symbol, leverage: String(leverage) });
        if (!l.ok) { const detail = await l.json().catch(() => ({})); await releaseReservation(kv, reservation!).catch(() => undefined); return reply({ error: "leverage_setup_failed", detail }, 502); }
      }
    }
    const params: Record<string, string> = { symbol, side: String(side).toUpperCase(), type: "LIMIT", quantity: fmt(quantity), price: fmt(limitPrice), timeInForce: "GTC", newClientOrderId: b.clientOrderId };
    if (reduceOnly) params.reduceOnly = "true";
    orderSent = true;
    const r = await signed(env, "POST", "/fapi/v1/order", params), data: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const definite = r.status >= 400 && r.status < 500 && r.status !== 408;
      if (definite) await releaseReservation(kv, reservation!).catch(() => undefined); else await settleReservation(kv, reservation!, "indeterminate", { status: r.status }).catch(() => undefined);
      const recorded = await recordRejection(kv, { outcome: definite ? "broker_rejected" : "unknown", stage: "broker", error: definite ? "broker_rejected" : "broker_outcome_unknown", reasons: [definite ? `Binance futures testnet rejected the order (HTTP ${r.status}).` : `Binance futures testnet gave no definite answer (HTTP ${r.status}, undefined, (k, r) => journalRejection(env, k, r)); check the exchange before retrying. This clientOrderId stays reserved.`], mode: "futures_testnet", brokerContacted: true, brokerResponse: data, request: summariseRequest(b), executionSource: summariseSource(src) }, undefined, (k, r) => journalRejection(env, k, r));
      return reply({ error: definite ? "broker_rejected" : "broker_outcome_unknown", outcome: definite ? "broker_rejected" : "unknown", status: r.status, detail: data, mode: "futures_testnet", broker_contacted: true, audit_recorded: recorded }, 502);
    }
    const rec = { outcome: "executed", executedAt: new Date().toISOString(), broker: "binance", mode: "futures_testnet", symbol, side, type: "limit", quantity, limitPrice, intent: check.intent, reduceOnly, leverage: reduceOnly ? st.leverage : leverage, stopPrice: stopPrice ?? null, clientOrderId: b.clientOrderId, brokerOrderId: data?.orderId ?? null, brokerStatus: data?.status ?? null, executionSource: { actorType: src.actorType, actorId: src.actorId, sourceName: src.sourceName, strategyId: src.strategyId ?? null, signalId: src.signalId ?? null, triggerReason: src.triggerReason ?? null }, preTrade: { positionAmt: st.positionAmt, markPrice: st.markPrice, fundingRate: st.fundingRate, estLiquidation: check.estLiquidation }, safeguards: { engine: "in_process", notionalUsd: check.notionalUsd }, order: data };
    await settleReservation(kv, reservation!, "executed", { brokerOrderId: rec.brokerOrderId }).catch(() => undefined);
    let auditRecorded = true;
    try { await kv.put("order:" + rec.executedAt + ":" + b.clientOrderId, JSON.stringify(rec), { expirationTtl: AUDIT_TTL_SECONDS }); } catch { auditRecorded = false; }
    await journalExecution(env, { ...rec, environment: "futures_testnet", clientOrderId: b.clientOrderId });
    return reply({ ok: true, outcome: "executed", mode: "futures_testnet", intent: check.intent, order: data, brokerOrderId: rec.brokerOrderId, brokerStatus: rec.brokerStatus, estLiquidation: check.estLiquidation, warnings: check.warnings, protectiveStop: "NOT placed automatically: monitor GET /api/futures/positions and manage the stop yourself", executedAt: rec.executedAt, audit_recorded: auditRecorded }, 201);
  } catch (e) {
    if (reservation) { if (orderSent) await settleReservation(kv, reservation, "indeterminate", {}).catch(() => undefined); else await releaseReservation(kv, reservation).catch(() => undefined); }
    return reply({ error: "execution_upstream_error", outcome: orderSent ? "unknown" : "rejected", message: e instanceof Error ? e.message : "Unknown error" }, 502);
  }
}
