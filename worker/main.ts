/**
 * Worker entrypoint. Layers, outermost first:
 *   0. command centre (/command) and global-intelligence API (/api/intel/*)
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   2. futures agents + gateway + monitor (/api/agents/futures/*, /api/futures/*, /agents/futures)
 *   3. multi-agent system (/api/agents/*, /agents)
 *   4. the existing application (worker/index.ts), left unchanged, which handles every other route.
 * Scheduled events: the every-minute cron runs the futures protective-stop monitor; any other cron is forwarded
 * unchanged to the existing application's scheduled handler (if it has one).
 */
import base from "./index.ts";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";
import { withFutures } from "./agents/futures-route.ts";
import { withCommand } from "./command/route.ts";
import { runFuturesMonitor } from "./futures-monitor.ts";
import { runPaperCycle } from "./algo/paper-api.ts";
import { runScheduled as runAlphaCycle } from "./alpha/routes.ts";
import { maintain as maintainAuth } from "./auth/session.ts";

const app = withCommand(withAlgo(withFutures(withAgents(base as any) as any) as any) as any);
const inner: any = base;
export const MONITOR_CRON = "* * * * *";

export default {
  fetch: (request: Request, env: any) => app.fetch(request, env),
  async scheduled(event: { cron?: string }, env: any, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (event.cron === MONITOR_CRON) { ctx.waitUntil(runFuturesMonitor(env).catch(() => undefined)); return; }
    ctx.waitUntil(maintainAuth(env, Date.now()).then(() => undefined, () => undefined)); // rotate an aged signing key, retire old ones
    // Other cron ticks: paper-trading cycle (off unless ETI_PAPER_SYMBOLS is set) and the Global Alpha research loop.
    // Each pass is isolated so one failing never blocks the other.
    ctx.waitUntil(runPaperCycle(env).then(() => undefined, e => console.error("paper cycle failed", e instanceof Error ? e.message : e)));
    ctx.waitUntil(runAlphaCycle(env).then(() => undefined, e => console.error("alpha cycle failed", e instanceof Error ? e.message : e)));
    if (typeof inner.scheduled === "function") return inner.scheduled(event, env, ctx);
  },
};
