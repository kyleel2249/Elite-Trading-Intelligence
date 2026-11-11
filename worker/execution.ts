/**
 * ETI execution gateway: PAPER / TESTNET ONLY (Alpaca Paper, Binance Spot Testnet).
 *
 * There is no live order path in this build. /api/orders/live exists only to answer 423, and no live broker host or
 * live credential is referenced anywhere in this file. No withdrawal, transfer, funding or wallet endpoints are exposed.
 *
 * Every order is checked in-process, in this order, before a broker is contacted (see safeguards.ts):
 *   kill switch -> bearer auth -> audit log bound -> valid order -> quantity cap -> broker configured ->
 *   duplicate protection -> readiness (advisory by default) -> paper balance / holdings -> broker.
 * A refusal at any step never reaches the broker and is written to the audit log under "reject:".
 * No separately hosted risk service is required.
 */
import { journalExecution, journalRejection } from "./journal/hooks.ts";
import { readinessForOrder } from "./readiness/api.ts";
import { authenticate, can, rateLimit, type EnvScope } from "./auth/session.ts";
import { credentialReport, markInvalid } from "./auth/credentials.ts";
import { placeInternal, recordExchangeOrder, type EngineEnv } from "./portfolio/engine.ts";
import {
  AUDIT_TTL_SECONDS, ALPACA_PAPER_BASE, BINANCE_TESTNET_BASE, duplicateWindowSeconds, evaluateFunds, hmacHex, legacyGatewayConfigPresent, loadPaperAccount,
  recordRejection, releaseReservation, reserveOrder, settleReservation, summariseRequest, summariseSource,
  type FundsEvidence, type OrderFacts, type Reservation, type SafeKV,
} from "./safeguards.ts";

/** off | advisory (default: readiness is recorded on every order, never blocks) | enforce (AVOID TRADING and HIGH RISK block orders; a readiness failure blocks too) */
export type ReadinessGateMode = "off" | "advisory" | "enforce";
export interface ExecutionEnv {
  ETI_READINESS_GATE?: string;
  ETI_EXECUTION_TOKEN?: string;
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  ETI_MAX_ORDER_QUANTITY?: string;
  ETI_KILL_SWITCH?: string;
  /** Seconds in which an identical order from the same actor is refused as an accidental duplicate (default 60, 0 disables). */
  ETI_DUPLICATE_WINDOW_SECONDS?: string;
  /** Ignored: this build has no live execution path. A value of "true" is reported as a misconfiguration, never honoured. */
  ETI_LIVE_TRADING_ENABLED?: string;
  ETI_EXECUTION_LOG?: KVNamespace;
  /** Cloudflare secret used to sign execution sessions (a random key is kept in KV when unset). */
  ETI_SESSION_SECRET?: string;
  ETI_SESSION_SECRET_PREVIOUS?: string;
  /** off | paper | paper_testnet (default). */
  ETI_AUTO_SESSIONS?: string;
  ETI_KEY_ROTATION_DAYS?: string;
  ETI_ROUND_TRIP_COST_BPS?: string;
  /** Simulated starting balance (default 10000), fee and slippage in basis points for the internal paper venue. */
  ETI_PAPER_START_BALANCE?: string;
  ETI_PAPER_FEE_BPS?: string;
  ETI_PAPER_SLIPPAGE_BPS?: string;
}
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const safeOrderId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{8,36}$/.test(value);
const maxQuantity = (env: ExecutionEnv) => Number(env.ETI_MAX_ORDER_QUANTITY ?? "100");
const readinessMode = (env: ExecutionEnv): ReadinessGateMode => {
  const raw = (env.ETI_READINESS_GATE || "advisory").toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "advisory";
};
export const EXEC_ENVIRONMENTS = ["internal_paper", "exchange_testnet", "live"] as const;
export type ExecEnvironment = typeof EXEC_ENVIRONMENTS[number];
export interface ExecDeps { now?: () => number; fetchImpl?: typeof fetch; priceOf?: (symbol: string) => Promise<number | null> }
interface KVList extends SafeKV {
  list(o: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }>;
}

export async function authorized(req: Request, env: ExecutionEnv): Promise<boolean> {
  const token = env.ETI_EXECUTION_TOKEN;
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

/** Public, secret-free description of how orders are handled. The dashboard renders this verbatim. */
export function executionStatus(env: ExecutionEnv) {
  const cap = maxQuantity(env);
  return {
    mode: "paper_testnet_only",
    live_trading_enabled: false,
    live_trading_available: false,
    live_flag_ignored: env.ETI_LIVE_TRADING_ENABLED === "true",
    external_risk_gateway: false,
    legacy_gateway_config_ignored: legacyGatewayConfigPresent(env),
    safeguards: {
      engine: "in_process",
      kill_switch: env.ETI_KILL_SWITCH === "true",
      valid_order_checks: true,
      max_order_quantity: Number.isFinite(cap) && cap > 0 ? cap : null,
      balance_check: true,
      holdings_check: true,
      duplicate_protection: true,
      duplicate_window_seconds: duplicateWindowSeconds(env),
      rejection_audit: !!env.ETI_EXECUTION_LOG,
    },
    readiness_gate: readinessMode(env),
    alpaca_paper_configured: !!(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY),
    binance_testnet_configured: !!(env.BINANCE_API_KEY && env.BINANCE_SECRET_KEY),
    audit_log_configured: !!env.ETI_EXECUTION_LOG,
    kill_switch: env.ETI_KILL_SWITCH === "true",
    withdrawal_permissions: false,
    transfers: false,
    internal_paper_available: true,
    auto_sessions: env.ETI_AUTO_SESSIONS || "paper_testnet",
  };
}

const isoOf = (key: string, prefix: string) => key.slice(prefix.length, prefix.length + 24);
/** Environment a stored record belongs to (refusal records carry only a mode). */
const environmentOf = (r: any): ExecEnvironment | "any" =>
  r.environment || (r.mode === "live" ? "live" : r.mode === "internal_paper" ? "internal_paper" : r.mode === "paper" || r.mode === "testnet" ? "exchange_testnet" : "any");
/** Newest-first page of audit records (executed and refused) across the given environments. KV lists keys oldest-first, so keys are listed (1 subrequest per 1000) and only the newest `limit` are fetched. */
async function newestRecords(kv: KVList, want: ExecEnvironment[], limit: number): Promise<any[]> {
  const prefixes = new Set<string>(["reject:"]);
  for (const e of want) prefixes.add(e === "internal_paper" ? "exec:paper:rec:" : e === "live" ? "exec:live:rec:" : "order:");
  const names: { name: string; at: string }[] = [];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const l = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const k of l.keys) names.push({ name: k.name, at: isoOf(k.name, prefix) });
      if (l.list_complete !== false || !l.cursor) break;
      cursor = l.cursor;
    }
  }
  names.sort((a, b) => b.at.localeCompare(a.at));
  const rows = await Promise.all(names.slice(0, limit * 2).map(async (k) => { try { return JSON.parse((await kv.get(k.name)) || "null"); } catch { return null; } }));
  return rows.filter(Boolean)
    .filter((r) => { const env = environmentOf(r); return env === "any" || want.includes(env); })
    .map((r) => ({ ...r, outcome: r.outcome ?? "executed", at: r.executedAt ?? r.at }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

type Sent = { ok: true; data: any } | { ok: false; definite: boolean; status: number; data: any };
/** Sends the order to the PAPER / TESTNET venue only. Definite = the broker answered with a 4xx, so the order does not exist there. */
async function sendPaperOrder(env: ExecutionEnv, f: OrderFacts, tif: unknown, fetchImpl: typeof fetch): Promise<Sent> {
  try {
    let r: Response;
    if (f.broker === "alpaca") {
      const payload: any = { symbol: f.symbol, qty: String(f.quantity), side: f.side, type: f.type, time_in_force: tif === "gtc" ? "gtc" : "day", client_order_id: f.clientOrderId };
      if (f.type === "limit") payload.limit_price = String(f.limitPrice);
      r = await fetchImpl(`${ALPACA_PAPER_BASE}/v2/orders`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json", "APCA-API-KEY-ID": env.ALPACA_API_KEY as string, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY as string },
        body: JSON.stringify(payload),
      });
    } else {
      const params = new URLSearchParams({ symbol: f.symbol, side: f.side.toUpperCase(), type: f.type.toUpperCase(), quantity: String(f.quantity), newClientOrderId: f.clientOrderId, timestamp: String(Date.now()), recvWindow: "5000" });
      if (f.type === "limit") { params.set("price", String(f.limitPrice)); params.set("timeInForce", tif === "ioc" ? "IOC" : "GTC"); }
      params.set("signature", await hmacHex(env.BINANCE_SECRET_KEY as string, params.toString()));
      r = await fetchImpl(`${BINANCE_TESTNET_BASE}/api/v3/order`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY as string, "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, data };
    return { ok: false, definite: r.status >= 400 && r.status < 500 && r.status !== 408, status: r.status, data };
  } catch (e) {
    return { ok: false, definite: false, status: 0, data: { message: e instanceof Error ? e.message : "request failed" } };
  }
}

export async function handleExecution(req: Request, env: ExecutionEnv, deps: ExecDeps = {}): Promise<Response> {
  const url = new URL(req.url), now = (deps.now ?? Date.now)(), fetchImpl = deps.fetchImpl ?? fetch;
  if (url.pathname === "/api/execution/status" && req.method === "GET") return reply(executionStatus(env));
  if (url.pathname === "/api/execution/history") {
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    const auth = await authenticate(req, env, now);
    if (!auth.master && auth.scopes.size === 0) return reply({ error: "unauthorized" }, 401);
    if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured" }, 503);
    // Separate records per environment. A session sees only its own environment; the master token may ask for any.
    const asked = url.searchParams.get("environment");
    const allowed: ExecEnvironment[] = auth.master ? [...EXEC_ENVIRONMENTS] : [...(auth.scopes.has("paper") ? ["internal_paper" as const] : []), ...(auth.scopes.has("testnet") ? ["exchange_testnet" as const] : [])];
    const want: ExecEnvironment[] = asked && (allowed as string[]).includes(asked) ? [asked as ExecEnvironment] : allowed;
    const limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get("limit") || 40)) || 40));
    const records = await newestRecords(env.ETI_EXECUTION_LOG as unknown as KVList, want, limit);
    return reply({ environments: want, records, count: records.length, limit, note: "Executed orders and refused orders (outcome 'rejected': never sent to a broker), newest first." });
  }
  if (url.pathname !== "/api/orders" && url.pathname !== "/api/orders/live") return reply({ error: "not_found" }, 404);
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (env.ETI_KILL_SWITCH === "true") return reply({ error: "execution_disabled", reason: "Emergency kill switch is active" }, 423);
  const auth = await authenticate(req, env, now);
  if (!auth.master && auth.scopes.size === 0) return reply({ error: "unauthorized", message: "No valid ETI session or execution token. Open the dashboard to start an automatic session." }, 401);
  if (url.pathname === "/api/orders/live") {
    if (!auth.master) return reply({ error: "live_requires_master_credentials", message: "Sessions can never authorise live orders." }, 403);
    return reply({ error: "live_trading_disabled", message: "This build has no live execution path. Orders are paper/testnet only and are never routed to a real-money account." }, 423);
  }
  if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured", message: "Configure the ETI_EXECUTION_LOG KV binding before submitting orders." }, 503);
  const kv = env.ETI_EXECUTION_LOG as unknown as KVList;

  let body: any;
  try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); }
  const broker = body?.broker, symbol = typeof body?.symbol === "string" ? body.symbol.toUpperCase() : "";
  const side = body?.side, type = body?.type ?? "market", quantity = num(body?.quantity), clientOrderId = body?.clientOrderId;
  const source = body?.executionSource;
  const internal = broker === "eti_paper";
  const mode = internal ? "internal_paper" : broker === "binance" ? "testnet" : "paper";

  let reservation: Reservation | null = null;
  /** Refuse before any broker is contacted: free any reservation, audit the refusal, answer. */
  const refuse = async (stage: string, status: number, error: string, reasons: string[], extra: Record<string, unknown> = {}) => {
    if (reservation) { await releaseReservation(kv, reservation).catch(() => undefined); reservation = null; }
    const recorded = await recordRejection(kv, { stage, error, reasons, mode: broker === "binance" || broker === "alpaca" || internal ? mode : "unknown", ...(internal ? { environment: "internal_paper" as const } : broker === "binance" || broker === "alpaca" ? { environment: "exchange_testnet" as const } : {}), request: summariseRequest(body), executionSource: summariseSource(source) }, now, (k, r) => journalRejection(env, k, r));
    return reply({ ok: false, outcome: "rejected", error, stage, message: reasons[0], reasons, broker_contacted: false, exchangeOrderPlaced: false, audit_recorded: recorded, ...extra }, status);
  };

  const sourceTypes = ["manual_user", "strategy", "system", "automation"];
  if (!source || !sourceTypes.includes(source.actorType) || typeof source.actorId !== "string" || !source.actorId.trim() || typeof source.sourceName !== "string" || !source.sourceName.trim())
    return refuse("validation", 400, "execution_source_required", ["Identify who or what initiated the order using executionSource.actorType, actorId and sourceName."]);
  if (!["alpaca", "binance", "eti_paper"].includes(broker) || !/^[A-Z0-9._-]{2,24}$/.test(symbol) || !["buy", "sell"].includes(side) || !(broker === "eti_paper" ? ["market", "limit", "stop"] : ["market", "limit"]).includes(type) ||
    !Number.isFinite(quantity) || quantity <= 0 || !safeOrderId(clientOrderId) || body?.riskConfirmed !== true)
    return refuse("validation", 400, "invalid_order", ["Provide broker, symbol, buy/sell, market/limit, positive quantity, unique clientOrderId (8–36 safe characters), and riskConfirmed:true after user review."]);
  // Optional protective levels for a buy: {stop, tp1, tp2, tp3}. Validated against the entry inside the engine (internal) or stored as alert-only levels (testnet).
  let plan: { stop: number | null; tp: (number | null)[] } | null = null;
  if (body?.plan && typeof body.plan === "object") {
    const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    plan = { stop: n(body.plan.stop), tp: [n(body.plan.tp1), n(body.plan.tp2), n(body.plan.tp3)] };
    if ([plan.stop, ...plan.tp].some((v) => v !== null && (!Number.isFinite(v) || (v as number) <= 0))) return refuse("validation", 400, "invalid_levels", ["Stop and take-profit levels must be positive numbers."]);
    if (side !== "buy") return refuse("validation", 400, "invalid_levels", ["Stop/take-profit levels apply to buy orders."]);
    if (plan.stop === null && plan.tp.every((v) => v === null)) plan = null;
  }
  if (type === "stop" && !(num(body.stopPrice) > 0)) return refuse("validation", 400, "invalid_stop_price", ["A stop order needs a positive stopPrice."]);
  const needScope: EnvScope = internal ? "paper" : "testnet";
  if (!can(auth, needScope))
    return refuse("scope", 403, "environment_scope_mismatch", [internal ? "Internal paper orders need an INTERNAL PAPER session." : "Exchange testnet orders need an EXCHANGE TESTNET session. Sessions are isolated per environment."], { required_session: needScope });
  if (!auth.master) {
    const rl = await rateLimit(env, "order:" + (auth.refs[needScope] || "anon"), 60, 600, now);
    if (!rl.ok) return reply({ error: "rate_limited", message: "Too many orders from this session; wait and retry." }, 429);
  }
  const maxQty = maxQuantity(env);
  if (!Number.isFinite(maxQty) || maxQty <= 0 || quantity > maxQty)
    return refuse("quantity_limit", 403, "risk_limit_exceeded", [`Quantity ${quantity} exceeds the maximum order quantity ${Number.isFinite(maxQty) ? maxQty : "(misconfigured)"}.`], { limit: "max_quantity", max: maxQty });
  if (type === "limit" && (!Number.isFinite(num(body.limitPrice)) || num(body.limitPrice) <= 0)) return refuse("validation", 400, "invalid_limit_price", ["A limit order needs a positive limitPrice."]);
  if (type === "market" && body.limitPrice !== undefined) return refuse("validation", 400, "unexpected_limit_price", ["A market order must not carry a limitPrice."]);

  const facts: OrderFacts = { broker, symbol, side, type, quantity, limitPrice: type === "limit" ? num(body.limitPrice) : undefined, clientOrderId, actorId: source.actorId.trim() };
  // Sessions (and API clients that set fallbackToPaper:true) fall back to internal paper when exchange credentials are missing or rejected.
  const allowFallback = !internal && (!auth.master || body.fallbackToPaper === true);
  let fallback: { from: string; reason: string } | null = null;
  if (!internal) {
    const hasCreds = broker === "alpaca" ? !!(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY) : !!(env.BINANCE_API_KEY && env.BINANCE_SECRET_KEY);
    if (allowFallback) {
      const rep = await credentialReport(env as any, broker, { validate: true, fetchImpl, now });
      if (rep.status === "missing" || rep.status === "invalid") fallback = { from: rep.environment, reason: rep.status === "missing" ? "exchange_credentials_missing" : "exchange_credentials_invalid" };
    } else if (!hasCreds) {
      return refuse("broker", 503, "broker_not_configured", [`No ${broker === "alpaca" ? "Alpaca paper" : "Binance testnet"} credentials are configured.`], { broker, mode });
    }
  }
  const useInternal = internal || !!fallback;

  try {
    const reserved = await reserveOrder(kv, facts, duplicateWindowSeconds(env), now);
    if (!reserved.ok) return refuse("duplicate", 409, reserved.error, [reserved.detail], { state: reserved.state });
    reservation = reserved.reservation;
  } catch { return refuse("duplicate", 503, "duplicate_check_unavailable", ["Duplicate-order protection could not be verified; order refused."]); }

  let readinessEvidence: any = null;
  const gate = readinessMode(env);
  if (gate !== "off") {
    try {
      const r = await readinessForOrder(env as any, broker === "binance" ? "crypto" : "equities", symbol, now);
      readinessEvidence = { gate, status: r.status, reasons: r.reasons, evaluated: r.evaluated, notEvaluated: r.notEvaluated, generatedAt: r.generatedAt };
      if (gate === "enforce" && (r.status === "AVOID_TRADING" || r.status === "HIGH_RISK"))
        return refuse("readiness", 403, "readiness_gate_rejected", ["The ETI Market Readiness Engine advises against opening new positions now."], { readiness: { status: r.status, recommendation: r.recommendation, reasons: r.reasons, blockers: r.blockers } });
    } catch {
      if (gate === "enforce") return refuse("readiness", 503, "readiness_unavailable", ["Order blocked because the readiness check could not be completed (ETI_READINESS_GATE=enforce)."]);
      readinessEvidence = { gate, status: "unavailable" };
    }
  }

  const execSource = { actorType: source.actorType, actorId: source.actorId, sourceName: source.sourceName, strategyId: source.strategyId ?? null, signalId: source.signalId ?? null, triggerReason: source.triggerReason ?? null };
  const authRef = { kind: auth.master ? "master_token" : "session", sessionRef: auth.master ? null : (auth.refs[needScope] || null) };

  /** ETI INTERNAL PAPER: simulated by ETI against the persistent ledger (balance, holdings, resting orders). No exchange or broker is contacted and none is claimed. */
  const fillInternal = async (fb: { from: string; reason: string } | null): Promise<Response> => {
    if (await kv.get("exec:paper:id:" + clientOrderId)) return refuse("duplicate", 409, "duplicate_client_order_id", ["This clientOrderId was already used."]);
    const tif = body.timeInForce === "day" ? "day" : body.timeInForce === "ioc" ? "ioc" : "gtc";
    const r = await placeInternal(env as EngineEnv, deps, { clientOrderId, symbol, side, type, qty: quantity, limitPrice: type === "limit" ? num(body.limitPrice) : null, stopPrice: type === "stop" ? num(body.stopPrice) : null, tif, plan, strategy: source.strategyId ?? null, signalId: source.signalId ?? null, actorId: source.actorId, reason: fb ? "fallback:" + fb.reason : null }, now);
    if (!r.ok) return refuse(r.code === "price_unavailable" ? "price" : "ledger", r.status, r.code, [r.message], { marketPrice: r.marketPrice ?? null, order: r.order ?? null });
    const executedAt = new Date(now).toISOString(), f = r.fills[0], resting = !f;
    const rec = { outcome: resting ? "resting" : "executed", executedAt, broker: "eti_paper", environment: "internal_paper", mode: "internal_paper", simulated: true, exchangeOrderPlaced: false, symbol, side, type, quantity, clientOrderId, marketPrice: r.marketPrice ?? null, fillPrice: f?.price ?? null, notionalUsd: f ? f.price * f.qty : null, status: r.order?.status ?? "open", statusReason: null, readiness: readinessEvidence, brokerOrderId: "paper-" + clientOrderId, fallback: fb, executionSource: execSource, auth: authRef, safeguards: { engine: "in_process" }, plan };
    let auditRecorded = true;
    try {
      await kv.put("exec:paper:rec:" + executedAt + ":" + clientOrderId, JSON.stringify(rec), { expirationTtl: AUDIT_TTL_SECONDS });
      await kv.put("exec:paper:id:" + clientOrderId, "1", { expirationTtl: AUDIT_TTL_SECONDS });
    } catch { auditRecorded = false; }
    await journalExecution(env, rec);
    await settleReservation(kv, reservation!, "executed", { brokerOrderId: rec.brokerOrderId }, now).catch(() => undefined);
    const base = { ok: true, outcome: rec.outcome, broker: "eti_paper", mode: "internal_paper", environment: "internal_paper", simulated: true, exchangeOrderPlaced: false, order: r.order, marketPrice: r.marketPrice, fallback: fb, executionSource: execSource, executedAt, live_trading: false, readiness: readinessEvidence, audit_recorded: auditRecorded };
    if (f) return reply({ ...base, fill: { price: f.price, marketPrice: r.marketPrice, quantity: f.qty, notionalUsd: f.price * f.qty, fee: f.fee },
      notice: fb ? "Exchange credentials unavailable (" + fb.reason + "): this order was filled in ETI INTERNAL PAPER mode. No exchange testnet order was placed." : "Simulated fill in ETI internal paper mode. No exchange was contacted." }, 201);
    return reply({ ...base, fill: null, resting: true, notice: r.order?.status === "expired" ? "Immediate-or-cancel order expired unfilled (simulated)." : "Order is resting in the ETI internal paper book; it fills only when the market trades through its price." }, 202);
  };
  if (useInternal) return fillInternal(fallback);

  /** Mirror an exchange paper/testnet order into the portfolio ledger. The exchange order stands even if this fails; the next sync backfills it. */
  const portfolioRecord = async (ok: boolean, resp: unknown) => {
    try { await recordExchangeOrder(env as EngineEnv, { broker: broker as "alpaca" | "binance", clientOrderId, symbol, side, type, qty: quantity, limitPrice: type === "limit" ? num(body.limitPrice) : null, tif: body.timeInForce === "gtc" || body.timeInForce === "ioc" ? body.timeInForce : null, plan, strategy: source.strategyId ?? null, signalId: source.signalId ?? null, actorId: source.actorId }, resp, ok, now); } catch { /* see above */ }
  };

  // ---- exchange paper/testnet: balance and holdings are read from the broker's own paper account (fail closed)
  const funds = await loadPaperAccount(env, facts, fetchImpl);
  if (!funds.ok) return refuse("account", funds.status, funds.error, [funds.detail]);
  const verdict = evaluateFunds(facts, funds.evidence);
  if (!verdict.ok) return refuse("funds", verdict.status, verdict.error, verdict.reasons, { preTrade: funds.evidence });
  const preTrade: FundsEvidence & { requiredFunds: number | null } = { ...funds.evidence, requiredFunds: verdict.requiredFunds };

  // ---- the only place an exchange paper/testnet venue is contacted
  const sent = await sendPaperOrder(env, facts, body.timeInForce, fetchImpl);
  if (!sent.ok) {
    const brokerName = broker === "alpaca" ? "Alpaca paper" : "Binance testnet";
    const authFailure = sent.status === 401 || sent.status === 403 || [-2014, -2015, -1022].includes(Number(sent.data?.code));
    if (allowFallback && authFailure) {
      await markInvalid(env as any, broker, now);
      return fillInternal({ from: broker === "alpaca" ? "alpaca_paper" : "binance_testnet", reason: "exchange_credentials_invalid" });
    }
    if (sent.definite) {
      await releaseReservation(kv, reservation!).catch(() => undefined);
      const recorded = await recordRejection(kv, { outcome: "broker_rejected", stage: "broker", error: "broker_rejected", reasons: [`${brokerName} rejected the order (HTTP ${sent.status}).`], mode, environment: "exchange_testnet", brokerContacted: true, brokerResponse: sent.data, request: summariseRequest(body), executionSource: summariseSource(source) }, now, (k, r) => journalRejection(env, k, r));
      await portfolioRecord(false, sent.data);
      return reply({ ok: false, outcome: "broker_rejected", error: "broker_rejected", broker, status: sent.status, detail: sent.data, mode, broker_contacted: true, audit_recorded: recorded }, 502);
    }
    await settleReservation(kv, reservation!, "indeterminate", { status: sent.status }, now).catch(() => undefined);
    const recorded = await recordRejection(kv, { outcome: "unknown", stage: "broker", error: "broker_outcome_unknown", reasons: [`${brokerName} did not give a definite answer (${sent.status || "no response"}). The order may or may not exist; check the broker before retrying. This clientOrderId stays reserved.`], mode, environment: "exchange_testnet", brokerContacted: true, brokerResponse: sent.data, request: summariseRequest(body), executionSource: summariseSource(source) }, now, (k, r) => journalRejection(env, k, r));
    return reply({ ok: false, outcome: "unknown", error: "broker_outcome_unknown", broker, status: sent.status, detail: sent.data, mode, broker_contacted: true, audit_recorded: recorded, message: "The broker did not give a definite answer. Check the broker's order list before retrying; this clientOrderId stays reserved." }, 502);
  }

  const result = sent.data, executedAt = new Date(now).toISOString();
  const brokerOrderId = result?.id ?? result?.orderId ?? null, brokerStatus = result?.status ?? null;
  const record = {
    outcome: "executed", executedAt, environment: "exchange_testnet", simulated: false, exchangeOrderPlaced: true, auth: authRef, broker, mode, symbol, side, type, quantity, limitPrice: facts.limitPrice ?? null, clientOrderId, readiness: readinessEvidence,
    brokerOrderId, brokerStatus, executionSource: execSource, safeguards: { engine: "in_process", preTrade }, order: result,
  };
  await settleReservation(kv, reservation!, "executed", { brokerOrderId }, now).catch(() => undefined);
  let auditRecorded = true;
  try { await kv.put("order:" + executedAt + ":" + clientOrderId, JSON.stringify(record), { expirationTtl: AUDIT_TTL_SECONDS }); } catch { auditRecorded = false; }
  await journalExecution(env, record);
  await portfolioRecord(true, result);
  return reply({ ok: true, outcome: "executed", broker, mode, order: result, brokerOrderId, brokerStatus, preTrade, executionSource: execSource, executedAt, live_trading: false, readiness: readinessEvidence, audit_recorded: auditRecorded }, 201);
}
