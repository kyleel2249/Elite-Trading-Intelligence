/**
 * Worker entrypoint. Layers, outermost first:
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   2. futures agents + gateway + monitor (/api/agents/futures/*, /api/futures/*, /agents/futures)
 *   3. multi-agent system (/api/agents/*, /agents)
 *   4. the existing application (worker/index.ts), left unchanged, which handles every other route.
 * Scheduled events: the every-minute cron runs the futures protective-stop monitor; any other cron is forwarded
 * unchanged to the existing application's scheduled handler (if it has one).
 */
import base from "./index";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";
import { withFutures } from "./agents/futures-route.ts";
import { runFuturesMonitor } from "./futures-monitor.ts";

const app = withAlgo(withFutures(withAgents(base as any) as any) as any);
const inner: any = base;
export const MONITOR_CRON = "* * * * *";

export default {
  fetch: (request: Request, env: any) => app.fetch(request, env),
  async scheduled(event: { cron?: string }, env: any, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (event.cron === MONITOR_CRON) { ctx.waitUntil(runFuturesMonitor(env).catch(() => undefined)); return; }
    if (typeof inner.scheduled === "function") return inner.scheduled(event, env, ctx);
  },
};
