// GET /api/omnisignal/alerts (log and configuration status) and POST /api/omnisignal/alerts/test. Bearer-token protected.
import { authorized } from "../execution.ts";
import { providerStatus, raiseAlerts, readAlertLog, type AlertDeps, type AlertEnv } from "./alerts.ts";
import { executionLogAlerts, type ExecLog } from "./alert-rules.ts";
import { executionBase } from "./testnet-api.ts";

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });

export async function handleAlerts(req: Request, env: AlertEnv & Record<string, any>, deps: AlertDeps = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path !== "/api/omnisignal/alerts" && path !== "/api/omnisignal/alerts/test") return reply({ error: "not_found" }, 404);
  if (!(await authorized(req, env as any))) return reply({ error: "unauthorized" }, 401);
  if (path.endsWith("/test")) {
    if (req.method !== "POST") return reply({ error: "method_not_allowed", allowed: "POST" }, 405);
    const r = await raiseAlerts(env, [{ type: "test", severity: "info", title: "ETI test alert", detail: "If you can read this, email alerts are working. No action is needed.", dedupeKey: undefined }], deps);
    return reply({ ...r, provider: providerStatus(env) }, r.delivered ? 200 : 502);
  }
  if (req.method !== "GET") return reply({ error: "method_not_allowed", allowed: "GET" }, 405);
  const log = await readAlertLog(env);
  return reply({ provider: providerStatus(env), total: log.length, delivered: log.filter(a => a.delivered).length, undelivered: log.filter(a => !a.delivered).length, alerts: log.slice(-100).reverse() });
}

/** Poll the Python engine's log for new events on one account and raise alerts. The first run only records a cursor (no backfill flood). */
export async function pollExecutionAlerts(env: AlertEnv & Record<string, any>, accountId: string, deps: AlertDeps & { fetchImpl?: typeof fetch } = {}): Promise<{ polled: boolean; alerts: number; note: string }> {
  const base = executionBase(env), token = env.ETI_EXECUTION_API_TOKEN, kv = env.ETI_EXECUTION_LOG as { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> } | undefined;
  if (!base || !token || !kv) return { polled: false, alerts: 0, note: "execution API or storage not configured" };
  const now = (deps.now ?? Date.now)(), key = `algo:alert-cursor:${accountId}`;
  try {
    const r = await (deps.fetchImpl ?? fetch)(`${base}/api/execution/logs?account_id=${encodeURIComponent(accountId)}&limit=200`, { headers: { "x-api-key": token }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { polled: false, alerts: 0, note: `logs HTTP ${r.status}` };
    const logs = await r.json() as ExecLog[]; if (!Array.isArray(logs)) return { polled: false, alerts: 0, note: "unexpected logs payload" };
    const raw = await kv.get(key), since = raw ? Number(raw) : NaN;
    const first = !Number.isFinite(since), { alerts, newest } = executionLogAlerts(logs, accountId, first ? Infinity : since);
    await kv.put(key, String(first ? Math.max(now - 1000, ...logs.map(l => Date.parse(l.ts)).filter(Number.isFinite)) : newest));
    if (alerts.length) await raiseAlerts(env, alerts, deps);
    return { polled: true, alerts: alerts.length, note: first ? "cursor initialised" : "ok" };
  } catch (e) { return { polled: false, alerts: 0, note: e instanceof Error ? e.message.slice(0, 120) : "error" }; }
}
