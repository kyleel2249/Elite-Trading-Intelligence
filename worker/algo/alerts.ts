// Alerts (Phase 15): email notifications plus a persisted alert log. Plain text only, never contains credentials, de-duplicated,
// rate limited, and honest about delivery: every alert is logged with whether it was actually sent, and a missing or failing email
// provider is recorded as "not delivered" rather than hidden. The recipient comes from the ETI_ALERT_EMAIL variable, never from code.
export const ALERT_LOG_KEY = "algo:alerts:v1";
export type AlertType =
  | "new_signal" | "high_conviction" | "signal_disagreement" | "trade_executed" | "take_profit_hit" | "stop_activated" | "stop_loss_hit" | "position_closed"
  | "thesis_invalidated" | "risk_rejection" | "protection_failure" | "account_halted" | "exchange_outage" | "market_data_failure"
  | "strategy_degradation" | "parameter_change" | "kill_switch" | "test";
export type Severity = "info" | "warning" | "critical";
export interface AlertEvent { type: AlertType; severity: Severity; title: string; detail: string; symbol?: string; accountId?: string; dedupeKey?: string; at?: number }
export interface AlertRecord extends AlertEvent { at: number; delivered: boolean; deliveryNote: string; provider: string | null }
type KV = { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> };
export type AlertEnv = {
  ETI_EXECUTION_LOG?: unknown; ETI_ALERT_EMAIL?: string; ETI_ALERT_FROM?: string; RESEND_API_KEY?: string; ALERT_EMAIL?: { send(m: unknown): Promise<void> };
  ETI_ALERT_MAX_PER_HOUR?: string; ETI_ALERTS_DISABLED?: string;
};
export interface AlertDeps { fetchImpl?: typeof fetch; now?: () => number; sendBinding?: (env: AlertEnv, from: string, to: string, subject: string, text: string) => Promise<void> }

const DEDUPE_SECONDS: Record<Severity, number> = { critical: 30 * 60, warning: 3 * 3600, info: 6 * 3600 };
export const MAX_LOG = 200, DEFAULT_MAX_PER_HOUR = 20, MAX_DETAIL = 1500;
const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,255}\.[A-Za-z]{2,}$/;
const SECRET_LIKE = /\b(?:[A-Za-z0-9_-]{40,}|sk_[A-Za-z0-9]{16,}|re_[A-Za-z0-9_]{16,}|Bearer\s+\S+)\b/g;
/** Strip anything shaped like a credential and control characters (headers cannot be injected through a subject or body). */
export const clean = (s: string, max = MAX_DETAIL) => String(s ?? "").replace(SECRET_LIKE, "[redacted]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
const oneLine = (s: string, max = 150) => clean(s, max).replace(/[\r\n]+/g, " ");

export function providerStatus(env: AlertEnv): { configured: boolean; provider: "resend" | "cloudflare_email" | null; recipientConfigured: boolean; missing: string[] } {
  const missing: string[] = [], to = !!env.ETI_ALERT_EMAIL && EMAIL.test(env.ETI_ALERT_EMAIL);
  if (!to) missing.push("ETI_ALERT_EMAIL");
  const resend = !!env.RESEND_API_KEY, cf = !!env.ALERT_EMAIL;
  if (!resend && !cf) missing.push("RESEND_API_KEY (with ETI_ALERT_FROM) or an ALERT_EMAIL send_email binding");
  if ((resend || cf) && !env.ETI_ALERT_FROM) missing.push("ETI_ALERT_FROM");
  const provider = resend ? "resend" : cf ? "cloudflare_email" : null;
  return { configured: missing.length === 0, provider, recipientConfigured: to, missing };
}

export const subjectFor = (events: AlertEvent[]) => {
  const top = [...events].sort((a, b) => rank(b.severity) - rank(a.severity))[0];
  return oneLine(`[ETI ${top.severity.toUpperCase()}] ${events.length > 1 ? `${events.length} alerts: ` : ""}${top.title}`, 120);
};
const rank = (s: Severity) => (s === "critical" ? 2 : s === "warning" ? 1 : 0);
export function bodyFor(events: AlertEvent[], at: number): string {
  const lines = events.map(e => `${e.severity.toUpperCase()}  ${e.type}${e.symbol ? "  " + e.symbol : ""}${e.accountId ? "  account " + e.accountId : ""}\n${oneLine(e.title, 200)}\n${clean(e.detail)}`);
  return `${lines.join("\n\n")}\n\n---\nElite Trading Intelligence - ${new Date(at).toISOString()}\nAnalytical evidence, not financial advice. Paper/testnet only; live trading is disabled by default.`;
}

async function sendEmail(env: AlertEnv, subject: string, text: string, deps: AlertDeps): Promise<{ ok: boolean; provider: string | null; note: string }> {
  const st = providerStatus(env);
  if (!st.configured) return { ok: false, provider: null, note: `email not configured: ${st.missing.join("; ")}` };
  const to = env.ETI_ALERT_EMAIL!, from = env.ETI_ALERT_FROM!;
  try {
    if (st.provider === "resend") {
      const r = await (deps.fetchImpl ?? fetch)("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }), signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { ok: false, provider: "resend", note: `resend HTTP ${r.status}: ${clean(await r.text().catch(() => ""), 160)}` };
      return { ok: true, provider: "resend", note: "accepted by Resend" };
    }
    await (deps.sendBinding ?? sendViaBinding)(env, from, to, subject, text);
    return { ok: true, provider: "cloudflare_email", note: "accepted by Cloudflare Email" };
  } catch (e) { return { ok: false, provider: st.provider, note: `send failed: ${clean(e instanceof Error ? e.message : String(e), 160)}` }; }
}
async function sendViaBinding(env: AlertEnv, from: string, to: string, subject: string, text: string) {
  const mod: any = await import("cloudflare:email");
  const raw = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${crypto.randomUUID()}@eti.alerts>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  await env.ALERT_EMAIL!.send(new mod.EmailMessage(from, to, raw));
}

/** Persist, de-duplicate, rate limit and send. Never throws: alerting must not break trading or analysis. */
export async function raiseAlerts(env: AlertEnv, events: AlertEvent[], deps: AlertDeps = {}): Promise<{ sent: number; suppressed: number; delivered: boolean; note: string }> {
  const now = (deps.now ?? Date.now)(), kv = env.ETI_EXECUTION_LOG as KV | undefined;
  if (!events.length) return { sent: 0, suppressed: 0, delivered: false, note: "no events" };
  if (env.ETI_ALERTS_DISABLED === "true") return { sent: 0, suppressed: events.length, delivered: false, note: "alerts disabled" };
  try {
    const fresh: AlertEvent[] = [];
    for (const e of events) {
      const ev: AlertEvent = { ...e, title: oneLine(e.title, 200), detail: clean(e.detail), at: e.at ?? now };
      const key = e.dedupeKey ? `algo:alert-seen:${clean(e.dedupeKey, 120)}` : null;
      if (kv && key && await kv.get(key).catch(() => null)) continue;
      fresh.push(ev);
    }
    const suppressed = events.length - fresh.length;
    if (!fresh.length) return { sent: 0, suppressed, delivered: false, note: "all duplicates" };
    // hourly budget; critical alerts always pass so a storm of info alerts cannot hide a failure
    const cap = Math.min(200, Math.max(1, Number(env.ETI_ALERT_MAX_PER_HOUR) || DEFAULT_MAX_PER_HOUR)), hourKey = `algo:alert-rate:${Math.floor(now / 3600_000)}`;
    const used = kv ? Number(await kv.get(hourKey).catch(() => "0")) || 0 : 0;
    const allowed = fresh.filter((e, i) => e.severity === "critical" || used + i < cap);
    const dropped = fresh.length - allowed.length;
    const log: AlertRecord[] = [];
    let res = { ok: false, provider: null as string | null, note: "rate limit reached" };
    if (allowed.length) res = await sendEmail(env, subjectFor(allowed), bodyFor(allowed, now), deps);
    for (const e of fresh) log.push({ ...e, at: e.at ?? now, delivered: res.ok && allowed.includes(e), deliveryNote: allowed.includes(e) ? res.note : "hourly alert limit reached", provider: res.provider });
    if (kv) {
      await kv.put(hourKey, String(used + allowed.length), { expirationTtl: 7200 }).catch(() => undefined);
      // only mark as seen when delivery worked, so a failed send is retried on the next occurrence
      if (res.ok) for (const e of allowed) if (e.dedupeKey) await kv.put(`algo:alert-seen:${clean(e.dedupeKey, 120)}`, "1", { expirationTtl: DEDUPE_SECONDS[e.severity] }).catch(() => undefined);
      const prev: AlertRecord[] = await kv.get(ALERT_LOG_KEY).then(v => (v ? JSON.parse(v) : [])).catch(() => []);
      await kv.put(ALERT_LOG_KEY, JSON.stringify([...prev, ...log].slice(-MAX_LOG))).catch(() => undefined);
    }
    return { sent: res.ok ? allowed.length : 0, suppressed: suppressed + dropped, delivered: res.ok, note: res.note };
  } catch (e) { return { sent: 0, suppressed: 0, delivered: false, note: `alerting error: ${clean(e instanceof Error ? e.message : String(e), 120)}` }; }
}
export async function readAlertLog(env: AlertEnv): Promise<AlertRecord[]> {
  try { const v = await (env.ETI_EXECUTION_LOG as KV | undefined)?.get(ALERT_LOG_KEY); return v ? JSON.parse(v) : []; } catch { return []; }
}
