// Thesis-invalidation monitoring for positions ETI opened (Phase 9). Re-analyses each open position and closes it, reduce-only,
// when predefined invalidation conditions hold on consecutive evaluations. Spot long positions only.
// Safety: never acts on unreliable data, never opens or adds exposure, closing is off unless explicitly requested (`close: true`
// or ETI_MANAGE_AUTOCLOSE=true for the scheduled run), live accounts are refused, and one noisy reading cannot trigger an exit.
import { authorized } from "../execution.ts";
import { STRATEGIES } from "./omni-api.ts";
import type { Strategy } from "./timeframes.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { costBpsFrom, runOmnisignal, type OmnisignalResult } from "./omnisignal.ts";
import { activeOptions } from "./params.ts";
import { executionBase, type TestnetEnv } from "./testnet-api.ts";

export const MAX_POSITIONS_PER_RUN = 3;
export const DEFAULT_CONFIRMATIONS = 2;
export const CONFIRMATION_WINDOW_MS = 3 * 3600_000;
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
type KV = { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> };

export interface Holding { symbol: string; qty: number; entryPrice: number | null }
export interface Invalidation { invalidated: boolean; reasons: string[]; evaluable: boolean; note: string }

/** Pure. Decide whether the evidence now contradicts a long position. Unreliable data is "not evaluable", never "invalidated". */
export function evaluateInvalidation(plan: OmnisignalResult, holding: Holding): Invalidation {
  if (plan.decision === "DATA_UNRELIABLE" || plan.decision === ("ERROR" as any)) return { invalidated: false, evaluable: false, reasons: [], note: "Data unreliable; no action is taken on unreliable data." };
  const reasons: string[] = [];
  if (plan.decision === "SELL") reasons.push("Both engines and the validator now confirm a SELL (the thesis has reversed)");
  const flowOpp = plan.flow?.available && plan.flow.supports === "opposes", eliteOpp = plan.elite?.available && plan.elite.alignment === "opposes";
  if (plan.decision !== "BUY" && flowOpp && eliteOpp) reasons.push("Documented methodologies and the volume footprint both oppose the position while the buy case is gone");
  if (plan.liquidity?.status === "blocked" && plan.liquidity.deteriorating) reasons.push("Order-book liquidity has deteriorated and is now blocked");
  const exec = plan.consensus;
  if (exec && exec.direction === -1 && exec.confidence >= 60 && !exec.degraded && plan.decision !== "BUY") reasons.push(`Multi-timeframe consensus turned bearish (confidence ${exec.confidence.toFixed(0)}/100)`);
  return { invalidated: reasons.length > 0, evaluable: true, reasons, note: reasons.length ? "Invalidation conditions hold" : "Thesis intact or merely weakened; stops and targets still govern the exit" };
}

export interface ConfirmState { count: number; lastAt: number; reasons: string[] }
/** Pure. Consecutive-evaluation counter: resets when the condition clears, when the reading is not evaluable, or when readings are too far apart. */
export function nextConfirmation(prev: ConfirmState | null, inv: Invalidation, now: number): ConfirmState {
  if (!inv.evaluable) return prev ?? { count: 0, lastAt: now, reasons: [] };   // unreliable data neither confirms nor clears
  if (!inv.invalidated) return { count: 0, lastAt: now, reasons: [] };
  const fresh = prev && now - prev.lastAt <= CONFIRMATION_WINDOW_MS ? prev.count : 0;
  return { count: fresh + 1, lastAt: now, reasons: inv.reasons };
}

export type ManageEnv = TestnetEnv & { ETI_MANAGE_AUTOCLOSE?: string; ETI_INVALIDATION_CONFIRMATIONS?: string; ETI_KILL_SWITCH?: string };
export const confirmationsFrom = (env: { ETI_INVALIDATION_CONFIRMATIONS?: string }) => { const n = Number(env.ETI_INVALIDATION_CONFIRMATIONS); return Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_CONFIRMATIONS; };

export interface ManageOutcome { symbol: string; entryPrice: number | null; decision: string; evaluable: boolean; invalidated: boolean; confirmations: number; required: number; action: "none" | "report_only" | "close_requested" | "close_failed"; reasons: string[]; execution?: unknown }
export async function manageAccount(env: ManageEnv, accountId: string, o: { strategy: Strategy; close: boolean; now: number; fetchImpl?: typeof fetch }): Promise<{ status: number; body: unknown }> {
  const base = executionBase(env), token = env.ETI_RISK_GATE_TOKEN, f = o.fetchImpl ?? fetch, kv = env.ETI_EXECUTION_LOG as unknown as KV | undefined;
  if (!base || !token) return { status: 503, body: { error: "execution_api_not_configured" } };
  if (!kv) return { status: 503, body: { error: "storage_not_configured" } };
  const call = async (path: string, init?: RequestInit) => { const r = await f(base + path, { ...init, headers: { "content-type": "application/json", "x-api-key": token, "x-operator": "omnisignal-manage" }, signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  let acct, pos;
  try { acct = await call(`/api/execution/accounts/${encodeURIComponent(accountId)}`); if (acct.status === 200) pos = await call(`/api/execution/accounts/${encodeURIComponent(accountId)}/managed-positions`); }
  catch { return { status: 503, body: { error: "execution_api_unreachable" } }; }
  if (acct.status !== 200) return { status: acct.status === 404 ? 404 : 502, body: { error: "account_unavailable", status: acct.status } };
  if (acct.body.environment === "live") return { status: 403, body: { error: "live_accounts_not_supported_here" } };
  if (!pos || pos.status !== 200) return { status: 502, body: { error: "positions_unavailable" } };
  const holdings: Holding[] = (pos.body.positions ?? []).map((p: any) => ({ symbol: String(p.symbol), qty: Number(p.qty), entryPrice: p.entry_price == null ? null : Number(p.entry_price) })).filter((h: Holding) => /^[A-Z0-9]{5,20}$/.test(h.symbol) && h.qty > 0);
  let active; try { active = await activeOptions(kv as any, () => o.now); } catch { return { status: 503, body: { error: "params_unavailable" } }; }
  const { version: _v, name: _n, ...opts } = active, required = confirmationsFrom(env), outcomes: ManageOutcome[] = [];
  for (const h of holdings.slice(0, MAX_POSITIONS_PER_RUN)) {
    const inputs = await loadSignalInputs(env, h.symbol, o.strategy, null, o.now);
    const key = `algo:manage:${accountId}:${h.symbol}`;
    const prev = await kv.get(key).then(v => (v ? JSON.parse(v) as ConfirmState : null)).catch(() => null);
    if ("error" in inputs) { outcomes.push({ symbol: h.symbol, entryPrice: h.entryPrice, decision: "DATA_UNRELIABLE", evaluable: false, invalidated: false, confirmations: prev?.count ?? 0, required, action: "none", reasons: [inputs.error] }); continue; }
    const plan = runOmnisignal({ symbol: h.symbol, strategy: o.strategy, candles: inputs.candles, depth: inputs.depth, now: o.now }, { roundTripCostBps: costBpsFrom(env), ...opts });
    const inv = evaluateInvalidation(plan, h), st = nextConfirmation(prev, inv, o.now);
    await kv.put(key, JSON.stringify(st), { expirationTtl: 86400 }).catch(() => undefined);
    const out: ManageOutcome = { symbol: h.symbol, entryPrice: h.entryPrice, decision: plan.decision, evaluable: inv.evaluable, invalidated: inv.invalidated, confirmations: st.count, required, action: "none", reasons: inv.reasons };
    if (inv.invalidated && st.count >= required) {
      if (!o.close) out.action = "report_only";
      else {
        const reason = `Thesis invalidated on ${st.count} consecutive evaluations: ${inv.reasons.join("; ")}`.slice(0, 290);
        try { const r = await call(`/api/execution/accounts/${encodeURIComponent(accountId)}/positions/${h.symbol}/close`, { method: "POST", body: JSON.stringify({ reason }) });
          out.execution = r.body; out.action = r.status === 200 && ["closed", "closing_order_sent", "already_sent_this_minute"].includes(r.body?.status) ? "close_requested" : "close_failed";
          if (out.action === "close_requested") await kv.put(key, JSON.stringify({ count: 0, lastAt: o.now, reasons: [] }), { expirationTtl: 86400 }).catch(() => undefined);
        } catch { out.action = "close_failed"; out.execution = { error: "execution_api_unreachable" }; }
      }
    }
    outcomes.push(out);
  }
  return { status: 200, body: { accountId, strategy: o.strategy, evaluated: outcomes.length, skippedForBudget: Math.max(0, holdings.length - MAX_POSITIONS_PER_RUN), closeEnabled: o.close, outcomes, opensPositions: false, increasesExposure: false } };
}

export async function handleManage(req: Request, env: ManageEnv, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/omnisignal/manage") return reply({ error: "not_found" }, 404);
  if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return reply({ error: "method_not_allowed", allowed: "POST" }, 405);
  const body: any = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return reply({ error: "invalid_json_body" }, 400);
  const accountId = String(body.accountId ?? ""), strategy = String(body.strategy ?? "intraday") as Strategy;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(accountId) || !STRATEGIES.includes(strategy) || (body.close !== undefined && typeof body.close !== "boolean")) return reply({ error: "invalid_request", message: "accountId, an optional strategy and an optional boolean close are required" }, 400);
  const r = await manageAccount(env, accountId, { strategy, close: body.close === true, now: (deps.now ?? Date.now)(), fetchImpl: deps.fetchImpl });
  return reply(r.body, r.status);
}
