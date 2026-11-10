// POST /api/omnisignal/execute: bridge from an Omnisignal plan to the Python execution engine (testnet/paper accounts only).
// The Worker never holds exchange credentials and never talks to the exchange. The engine enforces the account's approved
// instruments and capital limits, the server-side risk gate, venue rules (balance, precision, minimum notional), fill
// verification, protective stop/take-profit orders and reconciliation. Spot cannot short, so only BUY plans are routed.
import { authorized } from "../execution.ts";
import { STRATEGIES } from "./omni-api.ts";
import type { Strategy } from "./timeframes.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { costBpsFrom, runOmnisignal } from "./omnisignal.ts";
import { activeOptions } from "./params.ts";
import type { PaperEnv } from "./paper-api.ts";

export type TestnetEnv = PaperEnv & { ETI_EXECUTION_API_URL?: string };
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
const floor = (x: number, step = 1e-6) => Math.floor(x / step + 1e-9) * step;

/** Base URL of the Python API: explicit ETI_EXECUTION_API_URL, otherwise the origin of the risk-gateway URL. */
export function executionBase(env: TestnetEnv): string | null {
  try { return new URL(env.ETI_EXECUTION_API_URL || env.ETI_RISK_GATE_URL || "").origin; } catch { return null; }
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
  const base = executionBase(env), token = env.ETI_RISK_GATE_TOKEN, f = deps.fetchImpl ?? fetch, now = (deps.now ?? Date.now)();
  if (!base || !token) return reply({ error: "execution_api_not_configured", message: "Set ETI_RISK_GATE_URL (or ETI_EXECUTION_API_URL) and ETI_RISK_GATE_TOKEN." }, 503);
  const call = async (path: string, init?: RequestInit) => { const r = await f(base + path, { ...init, headers: { "content-type": "application/json", "x-api-key": token, "x-operator": "omnisignal-worker" }, signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };

  // 1. The account must exist and must not be a live account: this route is testnet/paper only.
  let acct; try { acct = await call(`/api/execution/accounts/${encodeURIComponent(accountId)}`); } catch { return reply({ error: "execution_api_unreachable", submitsOrder: false }, 503); }
  if (acct.status !== 200) return reply({ error: "account_unavailable", status: acct.status, submitsOrder: false }, acct.status === 404 ? 404 : 502);
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

  // 3. Submit. The engine applies account policy, risk gate, venue rules and places protective orders after the fill.
  const tps = plan.takeProfits!, signalId = `omni-${symbol}-${strategy}-${plan.generatedAt.slice(0, 16)}`;
  let sub; try { sub = await call("/api/execution/signals", { method: "POST", body: JSON.stringify({ account_id: accountId, symbol, side: "buy", qty, order_type: "limit", limit_price: plan.entryZone![1], strategy: "omnisignal",
    thesis: `Omnisignal ${strategy} BUY; evidence score ${plan.confidence}/100 (uncalibrated); ${plan.reasons.slice(0, 3).join(" | ")}`.slice(0, 1900), signal_id: signalId,
    stop_loss: stop, take_profits: [{ price: tps[0].price, fraction: 0.4 }, { price: tps[1].price, fraction: 0.3 }, { price: tps[2].price, fraction: 0.3 }] }) }); }
  catch { return reply({ ...out, error: "execution_api_unreachable", message: "The outcome is unknown; check /api/execution/orders before retrying. The signal_id makes a retry idempotent.", signalId }, 502); }
  return reply({ ...out, submitted: sub.status === 200, signalId, quantity: qty, plan: { entryZone: plan.entryZone, stopLoss: stop, takeProfits: tps }, execution: sub.body, httpStatus: sub.status }, sub.status === 200 ? 200 : 502);
}
