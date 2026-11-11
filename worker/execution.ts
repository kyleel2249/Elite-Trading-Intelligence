/**
 * ETI paper/testnet execution gateway.
 * Orders go ONLY to Alpaca Paper (paper-api.alpaca.markets) or the Binance Spot Testnet (testnet.binance.vision).
 * There is no live route and no external risk-gateway dependency: every pre-trade check runs inside this Worker.
 * No withdrawal, transfer, funding or wallet-management endpoints are called.
 */
import { readinessForOrder } from "./readiness/api.ts";
/** off | advisory (default: readiness is recorded on every order, never blocks) | enforce (AVOID TRADING and HIGH RISK block orders; a readiness failure blocks too) */
export type ReadinessGateMode = "off" | "advisory" | "enforce";
export interface ExecutionEnv {
  ETI_READINESS_GATE?: string;
  ETI_EXECUTION_TOKEN?: string;
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  ETI_MAX_ORDER_QUANTITY?: string;
  ETI_MAX_ORDER_NOTIONAL_USD?: string;
  ETI_KILL_SWITCH?: string;
  /** Informational only. ETI has no live execution path, so this flag never enables anything. */
  ETI_LIVE_TRADING_ENABLED?: string;
  ETI_EXECUTION_LOG?: KVNamespace;
}
const ALPACA_PAPER = "https://paper-api.alpaca.markets";
const ALPACA_DATA = "https://data.alpaca.markets";
const BINANCE_TESTNET = "https://testnet.binance.vision";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const TTL_90D = 60 * 60 * 24 * 90;

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
async function hmac(secret: string, query: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(query));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const safeOrderId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{8,36}$/.test(v);

async function getJson(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: {} }; }
}
async function binanceSigned(env: ExecutionEnv, path: string) {
  const q = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: "5000" });
  q.set("signature", await hmac(env.BINANCE_SECRET_KEY as string, q.toString()));
  return getJson(BINANCE_TESTNET + path + "?" + q.toString(), { headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY as string } });
}
const QUOTES = ["FDUSD", "USDT", "USDC", "BUSD", "BTC", "ETH", "BNB"];
export function splitSymbol(symbol: string): { base: string; quote: string } | null {
  for (const q of QUOTES) if (symbol.endsWith(q) && symbol.length > q.length) return { base: symbol.slice(0, -q.length), quote: q };
  return null;
}

interface Snapshot { quoteAsset: string; available: number; holdings: number; referencePrice: number | null; notionalUsd: number | null }
type Pre = { ok: true; snap: Snapshot } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Paper balance and holdings checks. Spot semantics: a BUY needs available quote balance (0.5% buffer for market orders),
 * a SELL needs existing holdings, so an ordinary SELL can never open a short. Fails closed if the paper account cannot be read.
 */
async function preTrade(env: ExecutionEnv, o: { broker: string; symbol: string; side: string; type: string; quantity: number; limitPrice: number }): Promise<Pre> {
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Pre => ({ ok: false, status, body: { error, ...extra } });
  let quoteAsset = "USD", available: number, holdings: number, price: number | null = o.type === "limit" ? o.limitPrice : null;
  if (o.broker === "alpaca") {
    const h = { "APCA-API-KEY-ID": env.ALPACA_API_KEY as string, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY as string };
    const [acct, pos] = await Promise.all([getJson(ALPACA_PAPER + "/v2/account", { headers: h }), getJson(ALPACA_PAPER + "/v2/positions/" + encodeURIComponent(o.symbol), { headers: h })]);
    if (!acct.ok) return fail(503, "paper_account_unavailable", { status: acct.status });
    if (acct.data.trading_blocked === true || acct.data.account_blocked === true) return fail(403, "paper_account_blocked");
    available = Number(acct.data.cash);
    if (!Number.isFinite(available)) return fail(503, "paper_account_unavailable");
    if (pos.status === 404) holdings = 0;
    else if (pos.ok && Number.isFinite(Number(pos.data.qty))) holdings = Number(pos.data.qty);
    else return fail(503, "paper_positions_unavailable", { status: pos.status });
    if (price === null && o.side === "buy") {
      const t = await getJson(`${ALPACA_DATA}/v2/stocks/${encodeURIComponent(o.symbol)}/trades/latest?feed=iex`, { headers: h }), p = Number(t.data?.trade?.p);
      price = t.ok && p > 0 ? p : null;
    }
  } else {
    const split = splitSymbol(o.symbol);
    if (!split) return fail(400, "unsupported_symbol_format", { message: "Use a Binance spot symbol such as BTCUSDT." });
    quoteAsset = split.quote;
    const acct = await binanceSigned(env, "/api/v3/account");
    if (!acct.ok) return fail(503, "paper_account_unavailable", { status: acct.status });
    const free = (asset: string) => Number((acct.data.balances ?? []).find((b: any) => b.asset === asset)?.free ?? 0);
    available = free(split.quote); holdings = free(split.base);
    if (price === null && o.side === "buy") {
      const t = await getJson(`${BINANCE_TESTNET}/api/v3/ticker/price?symbol=${encodeURIComponent(o.symbol)}`), p = Number(t.data?.price);
      price = t.ok && p > 0 ? p : null;
    }
  }
  const usdQuote = o.broker === "alpaca" || ["USDT", "USDC", "FDUSD", "BUSD"].includes(quoteAsset);
  const notional = price !== null ? o.quantity * price : null, cap = Number(env.ETI_MAX_ORDER_NOTIONAL_USD ?? "");
  if (Number.isFinite(cap) && cap > 0 && usdQuote && notional !== null && notional > cap) return fail(403, "risk_limit_exceeded", { limit: "max_notional_usd", max: cap, notional });
  if (o.side === "buy") {
    if (price === null || notional === null) return fail(503, "reference_price_unavailable", { message: "A price is needed to check the paper balance; retry or send a limit order." });
    const required = notional * 1.005;
    if (required > available) return fail(403, "insufficient_funds", { required, available, quoteAsset });
  } else if (o.quantity > holdings + 1e-9) return fail(403, "insufficient_holdings", { requested: o.quantity, held: holdings, message: "Spot SELL requires existing holdings; short selling is not available here." });
  return { ok: true, snap: { quoteAsset, available, holdings, referencePrice: price, notionalUsd: usdQuote ? notional : null } };
}

export function executionStatus(env: ExecutionEnv) {
  const raw = (env.ETI_READINESS_GATE || "").toLowerCase();
  return {
    mode: "paper_testnet_only", live_trading: "not_supported", live_trading_enabled: false, live_flag_set: env.ETI_LIVE_TRADING_ENABLED === "true",
    external_risk_gateway_required: false, readiness_gate: ["off", "enforce"].includes(raw) ? raw : "advisory",
    alpaca_paper_configured: !!(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY), binance_testnet_configured: !!(env.BINANCE_API_KEY && env.BINANCE_SECRET_KEY),
    execution_token_configured: !!env.ETI_EXECUTION_TOKEN, audit_log_configured: !!env.ETI_EXECUTION_LOG, kill_switch: env.ETI_KILL_SWITCH === "true",
    max_order_quantity: Number(env.ETI_MAX_ORDER_QUANTITY ?? "100"), max_order_notional_usd: Number(env.ETI_MAX_ORDER_NOTIONAL_USD ?? "") > 0 ? Number(env.ETI_MAX_ORDER_NOTIONAL_USD) : null,
    pre_trade_checks: ["authorization", "kill_switch", "order_validity", "quantity_limit", "notional_limit_if_configured", "duplicate_client_order_id", "paper_balance_or_holdings", "audit_log"],
    withdrawal_permissions: false,
  };
}

export async function handleExecution(req: Request, env: ExecutionEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/execution/status" && req.method === "GET") return reply(executionStatus(env));
  if (url.pathname === "/api/execution/history") {
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
    if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured" }, 503);
    const listed = await env.ETI_EXECUTION_LOG.list({ prefix: "order:", limit: 100 });
    const records = await Promise.all(listed.keys.map(async (key) => JSON.parse((await env.ETI_EXECUTION_LOG!.get(key.name)) || "null")));
    return reply({ records: records.filter(Boolean).sort((a, b) => String(b.executedAt).localeCompare(String(a.executedAt))) });
  }
  if (url.pathname !== "/api/orders" && url.pathname !== "/api/orders/live") return reply({ error: "not_found" }, 404);
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (env.ETI_KILL_SWITCH === "true") return reply({ error: "execution_disabled", reason: "Emergency kill switch is active" }, 423);
  if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
  if (url.pathname === "/api/orders/live") return reply({ error: "live_trading_not_supported", message: "ETI executes Alpaca Paper and Binance Spot Testnet orders only. There is no live execution route." }, 423);
  const kv = env.ETI_EXECUTION_LOG;
  if (!kv) return reply({ error: "audit_log_not_configured", message: "Configure the ETI_EXECUTION_LOG KV binding before submitting orders." }, 503);
  let body: any;
  try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); }
  const broker = body?.broker, symbol = typeof body?.symbol === "string" ? body.symbol.toUpperCase() : "";
  const side = body?.side, type = body?.type ?? "market", quantity = num(body?.quantity), clientOrderId = body?.clientOrderId;
  const source = body?.executionSource;
  if (!source || !["manual_user", "strategy", "system", "automation"].includes(source.actorType) || typeof source.actorId !== "string" || !source.actorId.trim() || typeof source.sourceName !== "string" || !source.sourceName.trim())
    return reply({ error: "execution_source_required", message: "Identify who or what initiated the order using executionSource.actorType, actorId and sourceName." }, 400);
  if (!["alpaca", "binance"].includes(broker) || !/^[A-Z0-9._-]{2,24}$/.test(symbol) || !["buy", "sell"].includes(side) || !["market", "limit"].includes(type) ||
    !Number.isFinite(quantity) || quantity <= 0 || !safeOrderId(clientOrderId) || body?.riskConfirmed !== true)
    return reply({ error: "invalid_order", message: "Provide broker, symbol, buy/sell, market/limit, positive quantity, unique clientOrderId (8–36 safe characters), and riskConfirmed:true after user review." }, 400);
  const maxQty = Number(env.ETI_MAX_ORDER_QUANTITY ?? "100");
  if (!Number.isFinite(maxQty) || maxQty <= 0 || quantity > maxQty) return reply({ error: "risk_limit_exceeded", limit: "max_quantity", max: maxQty }, 403);
  if (type === "limit" && (!Number.isFinite(num(body.limitPrice)) || num(body.limitPrice) <= 0)) return reply({ error: "invalid_limit_price" }, 400);
  if (type === "market" && body.limitPrice !== undefined) return reply({ error: "unexpected_limit_price" }, 400);
  const apiKey = broker === "alpaca" ? env.ALPACA_API_KEY : env.BINANCE_API_KEY, secret = broker === "alpaca" ? env.ALPACA_SECRET_KEY : env.BINANCE_SECRET_KEY;
  const mode = broker === "alpaca" ? "paper" : "testnet";
  if (!apiKey || !secret) return reply({ error: "broker_not_configured", broker, mode }, 503);
  const idemKey = "idem:" + broker + ":" + clientOrderId;
  if (await kv.get(idemKey)) return reply({ error: "duplicate_order", message: "This clientOrderId was already submitted. Use a new unique clientOrderId for a new order." }, 409);

  let readinessEvidence: any = null;
  {
    const raw = (env.ETI_READINESS_GATE || "advisory").toLowerCase(), gate: ReadinessGateMode = raw === "off" || raw === "enforce" ? raw : "advisory";
    if (gate !== "off") {
      try {
        const r = await readinessForOrder(env as any, broker === "binance" ? "crypto" : "equities", symbol);
        readinessEvidence = { gate, status: r.status, reasons: r.reasons, evaluated: r.evaluated, notEvaluated: r.notEvaluated, generatedAt: r.generatedAt };
        if (gate === "enforce" && (r.status === "AVOID_TRADING" || r.status === "HIGH_RISK"))
          return reply({ error: "readiness_gate_rejected", message: "The ETI Market Readiness Engine advises against opening new positions now.", readiness: { status: r.status, recommendation: r.recommendation, reasons: r.reasons, blockers: r.blockers } }, 403);
      } catch {
        if (gate === "enforce") return reply({ error: "readiness_unavailable", message: "Order blocked because the readiness check could not be completed (ETI_READINESS_GATE=enforce)." }, 503);
        readinessEvidence = { gate, status: "unavailable" };
      }
    }
  }

  const pre = await preTrade(env, { broker, symbol, side, type, quantity, limitPrice: num(body.limitPrice) });
  if (!pre.ok) return reply(pre.body, pre.status);
  const preTradeEvidence = { quoteAsset: pre.snap.quoteAsset, available: pre.snap.available, holdings: pre.snap.holdings, referencePrice: pre.snap.referencePrice, notionalUsd: pre.snap.notionalUsd };

  await kv.put(idemKey, new Date().toISOString(), { expirationTtl: TTL_90D });
  try {
    let result: any;
    if (broker === "alpaca") {
      const payload: any = { symbol, qty: String(quantity), side, type, time_in_force: body.timeInForce === "gtc" ? "gtc" : "day", client_order_id: clientOrderId };
      if (type === "limit") payload.limit_price = String(body.limitPrice);
      const r = await fetch(ALPACA_PAPER + "/v2/orders", { method: "POST", headers: { "content-type": "application/json", "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secret }, body: JSON.stringify(payload) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { await kv.delete(idemKey); return reply({ error: "broker_rejected", broker, status: r.status, detail: data, mode }, 502); }
      result = data;
    } else {
      const params = new URLSearchParams({ symbol, side: side.toUpperCase(), type: type.toUpperCase(), quantity: String(quantity), newClientOrderId: clientOrderId, timestamp: String(Date.now()), recvWindow: "5000" });
      if (type === "limit") { params.set("price", String(body.limitPrice)); params.set("timeInForce", body.timeInForce === "ioc" ? "IOC" : "GTC"); }
      params.set("signature", await hmac(secret, params.toString()));
      const r = await fetch(BINANCE_TESTNET + "/api/v3/order", { method: "POST", headers: { "X-MBX-APIKEY": apiKey, "content-type": "application/x-www-form-urlencoded" }, body: params.toString() });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { await kv.delete(idemKey); return reply({ error: "broker_rejected", broker, status: r.status, detail: data, mode }, 502); }
      result = data;
    }
    const record = {
      executedAt: new Date().toISOString(), broker, mode, symbol, side, type, quantity, clientOrderId, readiness: readinessEvidence, preTrade: preTradeEvidence,
      brokerOrderId: result?.id ?? result?.orderId ?? null,
      executionSource: { actorType: source.actorType, actorId: source.actorId, sourceName: source.sourceName, strategyId: source.strategyId ?? null, signalId: source.signalId ?? null, triggerReason: source.triggerReason ?? null },
      order: result,
    };
    await kv.put("order:" + record.executedAt + ":" + clientOrderId, JSON.stringify(record), { expirationTtl: TTL_90D });
    return reply({ ok: true, broker, mode, order: result, executionSource: record.executionSource, executedAt: record.executedAt, live_trading: false, preTrade: preTradeEvidence, readiness: readinessEvidence }, 201);
  } catch (e) {
    // The outcome is unknown (network error after submission may have reached the broker): keep the duplicate guard in place.
    return reply({ error: "execution_upstream_error", message: e instanceof Error ? e.message : "Unknown error", note: "Outcome unknown; verify at the broker before retrying with a NEW clientOrderId." }, 502);
  }
}
