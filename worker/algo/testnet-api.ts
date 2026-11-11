// POST /api/omnisignal/execute: routes an Omnisignal BUY plan to a paper/testnet venue. Spot cannot short, so only BUY plans are routed.
// Two paths, and neither needs a risk gateway:
//  1. In-Worker (default, always available): the plan becomes an ordinary order for the Worker's own execution flow
//     (ETI Internal Paper, or Alpaca paper / Binance testnet when credentials exist), so every in-process safeguard applies:
//     kill switch, auth, order validation, quantity cap, duplicate protection, balance/holdings check, audit log.
//     This path does NOT place stop/take-profit orders: the plan's stop and targets are returned for the operator.
//  2. Optional Python execution engine (ETI_EXECUTION_API_URL + ETI_EXECUTION_API_TOKEN): adds per-account approved
//     instruments and capital limits, venue rules, fill verification, protective OCO orders and reconciliation.
import { authorized, handleExecution } from "../execution.ts";
import { sha256Hex } from "../safeguards.ts";
import { STRATEGIES } from "./omni-api.ts";
import type { Strategy } from "./timeframes.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { costBpsFrom, runOmnisignal } from "./omnisignal.ts";
import { activeOptions } from "./params.ts";
import type { PaperEnv } from "./paper-api.ts";

export type TestnetEnv = PaperEnv & { ETI_EXECUTION_API_URL?: string; ETI_EXECUTION_API_TOKEN?: string };
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
const floor = (x: number, step = 1e-6) => Math.floor(x / step + 1e-9) * step;

/** Origin of the optional Python execution engine (ETI_EXECUTION_API_URL), or null when it is not configured. */
export function executionBase(env: TestnetEnv): string | null {
  try { return new URL(env.ETI_EXECUTION_API_URL || "").origin; } catch { return null; }
}
/** Position size from explicit operator limits: the smaller of risk-based and notional-capped quantity. */
export function sizeFor(entry: number, stop: number, riskUsd: number, maxNotionalUsd: number): number {
  const perUnit = entry - stop;
  if (!(entry > 0) || !(perUnit > 0) || !(riskUsd > 0) || !(maxNotionalUsd > 0)) return 0;
  return floor(Math.min(riskUsd / perUnit, maxNotionalUsd / entry));
}

export async function handleTestnetExecute(req: Request, env: TestnetEnv, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/omnisignal/execute") return reply({ error: "not_found" }, 404);
  if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return reply({ error: "method_not_allowed", allowed: "POST" }, 405);
  if (env.ETI_KILL_SWITCH === "true") return reply({ error: "kill_switch_active", submitsOrder: false }, 423);
  const body: any = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return reply({ error: "invalid_json_body" }, 400);
  const symbol = String(body.symbol ?? "").toUpperCase(), strategy = String(body.strategy ?? "intraday") as Strategy, accountId = String(body.accountId ?? "");
  const riskUsd = Number(body.riskUsd), maxNotionalUsd = Number(body.maxNotionalUsd);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !STRATEGIES.includes(strategy) || !/^[A-Za-z0-9_.-]{1,64}$/.test(accountId)) return reply({ error: "invalid_request", message: "symbol, strategy and accountId are required" }, 400);
  if (typeof body.riskUsd !== "number" || typeof body.maxNotionalUsd !== "number" || !(riskUsd > 0) || !(maxNotionalUsd > 0)) return reply({ error: "invalid_request", message: "riskUsd and maxNotionalUsd must be positive numbers (explicit operator limits)" }, 400);
  const base = executionBase(env), token = env.ETI_EXECUTION_API_TOKEN, f = deps.fetchImpl ?? fetch, now = (deps.now ?? Date.now)();
  const engine = !!(base && token);
  const call = async (path: string, init?: RequestInit) => { const r = await f(base + path, { ...init, headers: { "content-type": "application/json", "x-api-key": token, "x-operator": "omnisignal-worker" }, signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };

  // 1. Engine path only: the account must exist and must not be a live account (this route is testnet/paper only).
  let acct: any = { status: 200, body: { environment: "paper", halted: false } };
  if (engine) try { acct = await call(`/api/execution/accounts/${encodeURIComponent(accountId)}`); } catch { return reply({ error: "execution_api_unreachable", submitsOrder: false }, 503); }
  if (engine && acct.status !== 200) return reply({ error: "account_unavailable", status: acct.status, submitsOrder: false }, acct.status === 404 ? 404 : 502);
  if (acct.body.environment === "live") return reply({ error: "live_accounts_not_supported_here", message: "This route only submits to paper/testnet accounts. Live trading stays behind its own authorization.", submitsOrder: false }, 403);
  if (acct.body.halted) return reply({ error: "account_halted", reason: acct.body.halted_reason, submitsOrder: false }, 409);

  // 2. Fresh analysis with the champion parameters; fail closed if the registry cannot be read.
  let active; try { active = await activeOptions(env.ETI_EXECUTION_LOG as any, () => now); } catch { return reply({ error: "params_unavailable", submitsOrder: false }, 503); }
  const inputs = await loadSignalInputs(env, symbol, strategy, null, now);
  if ("error" in inputs) return reply({ decision: "DATA_UNRELIABLE", error: inputs.error, submitsOrder: false }, 503);
  const { version, name, ...opts } = active;
  const plan = runOmnisignal({ symbol, strategy, candles: inputs.candles, depth: inputs.depth, now }, { roundTripCostBps: costBpsFrom(env), ...opts });
  const out: Record<string, unknown> = { symbol, strategy, parameters: { version, name }, decision: plan.decision, confidence: plan.confidence, calibration: plan.calibration, submitted: false };
  if (plan.decision === "SELL") return reply({ ...out, message: "Spot venues cannot short; SELL plans are not routed. No order submitted." });
  if (plan.decision !== "BUY") return reply({ ...out, message: `Decision is ${plan.decision}; nothing to execute`, reasons: plan.reasons.slice(0, 5) });
  const entry = plan.entryZone![1] /* size on the worst-case fill: the limit price at the top of the zone */, stop = plan.stopLoss!, qty = sizeFor(entry, stop, riskUsd, maxNotionalUsd);
  if (!(qty > 0)) return reply({ ...out, message: "Position size rounds to zero under the supplied riskUsd and maxNotionalUsd" }, 422);

  // 3. Submit.
  const tps = plan.takeProfits!, signalId = `omni-${symbol}-${strategy}-${plan.generatedAt.slice(0, 16)}`;
  if (!engine) {
    // In-Worker path: an ordinary paper/testnet limit BUY at the top of the entry zone through the Worker's own execution flow.
    const broker = body.broker === "binance" ? "binance" : "eti_paper";
    const h = new Headers(); for (const k of ["authorization", "cookie", "origin", "sec-fetch-site"]) { const v = req.headers.get(k); if (v) h.set(k, v); }
    h.set("content-type", "application/json");
    const order = { broker, symbol, side: "buy", type: "limit", quantity: qty, limitPrice: plan.entryZone![1], timeInForce: "gtc", clientOrderId: "omni" + (await sha256Hex(signalId)).slice(0, 28), riskConfirmed: true,
      fallbackToPaper: body.fallbackToPaper === true,
      executionSource: { actorType: "strategy", actorId: accountId, sourceName: "Omnisignal", strategyId: strategy, signalId, triggerReason: `Omnisignal ${strategy} BUY, evidence score ${plan.confidence}/100 (uncalibrated)` } };
    const r = await handleExecution(new Request(new URL("/api/orders", req.url), { method: "POST", headers: h, body: JSON.stringify(order) }), env as any, { now: () => now, fetchImpl: f });
    const exec = await r.json().catch(() => ({})) as any;
    return reply({ ...out, submitted: r.status === 201, path: "in_worker", signalId, quantity: qty, plan: { entryZone: plan.entryZone, stopLoss: stop, takeProfits: tps },
      protectiveOrders: { placed: false, note: "The in-Worker path does not place stop/take-profit orders; set them from the plan, or configure the optional Python execution engine (ETI_EXECUTION_API_URL + ETI_EXECUTION_API_TOKEN)." },
      execution: exec, httpStatus: r.status }, r.status === 201 ? 200 : r.status >= 400 && r.status < 500 ? r.status : 502);
  }
  // Engine path: the engine applies account policy, venue rules and places protective orders after the fill.
  let sub; try { sub = await call("/api/execution/signals", { method: "POST", body: JSON.stringify({ account_id: accountId, symbol, side: "buy", qty, order_type: "limit", limit_price: plan.entryZone![1], strategy: "omnisignal",
    thesis: `Omnisignal ${strategy} BUY; evidence score ${plan.confidence}/100 (uncalibrated); ${plan.reasons.slice(0, 3).join(" | ")}`.slice(0, 1900), signal_id: signalId,
    stop_loss: stop, take_profits: [{ price: tps[0].price, fraction: 0.4 }, { price: tps[1].price, fraction: 0.3 }, { price: tps[2].price, fraction: 0.3 }] }) }); }
  catch { return reply({ ...out, error: "execution_api_unreachable", message: "The outcome is unknown; check /api/execution/orders before retrying. The signal_id makes a retry idempotent.", signalId }, 502); }
  return reply({ ...out, submitted: sub.status === 200, signalId, quantity: qty, plan: { entryZone: plan.entryZone, stopLoss: stop, takeProfits: tps }, execution: sub.body, httpStatus: sub.status }, sub.status === 200 ? 200 : 502);
}
