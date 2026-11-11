/**
 * Worker entrypoint. Layers, outermost first:
 *  -4. security headers (nonce CSP, nosniff, HSTS, ...) on every response
 *  -3. identity (/account, /api/identity/*), provider status (/providers, /api/providers/*), encrypted backup (/api/backup/*)
 *  -2.5 ETI Pro dashboard (/pro): neon dashboard that reads only live ETI endpoints
 *  -2. ETI DAILY INTELLIGENCE REPORT (/api/daily-report/*, /daily), read-only and analytical
 *  -1. ETI PRECISION SIGNAL ENGINE (/api/precision/*), read-only and analytical
 *   0. command centre (/command) and global-intelligence API (/api/intel/*)
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   1.5 multi-market intelligence (/api/markets/*, read-only planning endpoints; no quotes or orders)
 *   2. futures agents + gateway + monitor (/api/agents/futures/*, /api/futures/*, /agents/futures)
 *   3. multi-agent system (/api/agents/*, /agents)
 *   4. the existing application (worker/index.ts), left unchanged, which handles every other route.
 * Scheduled events: the every-minute cron runs the futures protective-stop monitor; any other cron runs the simulated
 * paper-trading cycle (a no-op unless ETI_PAPER_SYMBOLS is set; new entries also need ETI_PAPER_AUTOEXECUTE=true and no kill switch),
 * the Global Alpha loop, execution-session maintenance and the daily-report cycle (at most one report per UTC weekday, see
 * docs/DAILY_REPORT.md), then is forwarded unchanged to the existing application's scheduled handler.
 */
import base from "./index.ts";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";
import { withFutures } from "./agents/futures-route.ts";
import { withCommand } from "./command/route.ts";
import { withPrecision } from "./precision/route.ts";
import { withDailyReport } from "./daily/route.ts";
import { runDailyReportCycle } from "./daily/api.ts";
import { withPro } from "./pro/route.ts";
import { runFuturesMonitor } from "./futures-monitor.ts";
import { runPaperCycle } from "./algo/paper-api.ts";
import { runUniverseBatch, UNIVERSE_CRON } from "./algo/universe.ts";
import { manageAccount } from "./algo/manage.ts";
import { raiseAlerts } from "./algo/alerts.ts";
import { signalAlerts } from "./algo/alert-rules.ts";
import { pollExecutionAlerts } from "./algo/alerts-api.ts";
import { runScheduled as runAlphaCycle } from "./alpha/routes.ts";
import { maintain as maintainAuth } from "./auth/session.ts";
import { runPortfolioCycle } from "./portfolio/routes.ts";
import { withIdentity } from "./identity/routes.ts";
import { withProviders, runProviderProbe } from "./providers/routes.ts";
import { withBackup } from "./backup/routes.ts";
import { handleMarketsApi } from "./markets-api.ts";
import { withSecurityHeaders } from "./security/headers.ts";

const withMarkets = (next: any) => ({ fetch: (request: Request, env: any) => handleMarketsApi(request, env) ?? next.fetch(request, env) });
const core = withPro(withDailyReport(withPrecision(withCommand(withMarkets(withAlgo(withFutures(withAgents(base as any) as any) as any)) as any) as any) as any) as any);
// Identity, provider status and backup sit in front of the application; the security-headers layer wraps everything (see docs/SECURITY.md).
const app = withSecurityHeaders(withIdentity(withProviders(withBackup(core as any) as any) as any) as any);
const inner: any = base;
const MONITOR_CRON = "* * * * *";

export default {
  fetch: (request: Request, env: any) => app.fetch(request, env),
  async scheduled(event: { cron?: string }, env: any, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (event.cron === UNIVERSE_CRON) {
      // Position monitoring for the accounts listed in ETI_MANAGE_ACCOUNTS (comma separated). Closing needs ETI_MANAGE_AUTOCLOSE=true; otherwise report only.
      const accounts = String(env.ETI_MANAGE_ACCOUNTS ?? "").split(",").map((x: string) => x.trim()).filter((x: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(x)).slice(0, 3);
      for (const id of accounts) ctx.waitUntil(manageAccount(env as any, id, { strategy: (["scalp", "intraday", "swing", "position"].includes(env.ETI_MANAGE_STRATEGY) ? env.ETI_MANAGE_STRATEGY : "intraday"), close: env.ETI_MANAGE_AUTOCLOSE === "true", now: Date.now() }).then(r => { if (r.status !== 200) console.error("position management", id, r.status, JSON.stringify(r.body).slice(0, 200)); }, e => console.error("position management failed", e instanceof Error ? e.message : e)));
      const alertAccounts = String(env.ETI_ALERT_ACCOUNTS ?? env.ETI_MANAGE_ACCOUNTS ?? "").split(",").map((x: string) => x.trim()).filter((x: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(x)).slice(0, 3);
      for (const id of alertAccounts) ctx.waitUntil(pollExecutionAlerts(env as any, id).then(() => undefined, () => undefined));
      if (env.ETI_UNIVERSE_ENABLED === "true" && env.ETI_EXECUTION_LOG) ctx.waitUntil(runUniverseBatch(env, env.ETI_EXECUTION_LOG, Date.now(), (["scalp", "intraday", "swing", "position"].includes(env.ETI_UNIVERSE_STRATEGY) ? env.ETI_UNIVERSE_STRATEGY : "intraday")).then(async b => { const strat = (["scalp", "intraday", "swing", "position"].includes(env.ETI_UNIVERSE_STRATEGY) ? env.ETI_UNIVERSE_STRATEGY : "intraday"); const ev = signalAlerts(b.previous, b.newRows ?? [], strat); if (b.universeError) ev.push({ type: "market_data_failure", severity: "warning", title: "Universe refresh failed", detail: b.universeError, dedupeKey: `universe:${new Date().toISOString().slice(0, 13)}` }); await raiseAlerts(env as any, ev); }, e => console.error("universe batch failed", e instanceof Error ? e.message : e))); return; }
    if (event.cron === MONITOR_CRON) {
      ctx.waitUntil(runFuturesMonitor(env).catch(() => undefined));
      ctx.waitUntil(runPortfolioCycle(env).then(() => undefined, e => console.error("portfolio cycle failed", e instanceof Error ? e.message : e))); // match resting paper orders and exits on every closed 1m bar; sync testnet fills
      return;
    }
    ctx.waitUntil(runProviderProbe(env).then(() => undefined, () => undefined)); // refresh provider status and data freshness
    ctx.waitUntil(maintainAuth(env, Date.now()).then(() => undefined, () => undefined)); // rotate an aged signing key, retire old ones
    // Other cron ticks: paper-trading cycle (off unless ETI_PAPER_SYMBOLS is set) and the Global Alpha research loop.
    // Each pass is isolated so one failing never blocks the other.
    ctx.waitUntil(runPaperCycle(env).then(() => undefined, e => console.error("paper cycle failed", e instanceof Error ? e.message : e)));
    ctx.waitUntil(runAlphaCycle(env).then(() => undefined, e => console.error("alpha cycle failed", e instanceof Error ? e.message : e)));
    // Daily intelligence report: one stored report per UTC weekday (no-op when already generated, on weekends, before ETI_DAILY_HOUR_UTC, or without the KV binding).
    ctx.waitUntil(runDailyReportCycle(env, Date.now()).then(() => undefined, e => console.error("daily report failed", e instanceof Error ? e.message : e)));
    if (typeof inner.scheduled === "function") return inner.scheduled(event, env, ctx);
  },
};
