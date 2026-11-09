/**
 * Worker entrypoint. Layers, outermost first:
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   2. futures agents + gateway (/api/agents/futures/*, /api/futures/*)
 *   3. multi-agent system (/api/agents/*, /agents)
 *   4. the existing application (worker/index.ts), left unchanged, which handles every other route.
 */
import base from "./index.ts";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";
import { withFutures } from "./agents/futures-route.ts";
import { runPaperCycle } from "./algo/paper-api.ts";
import { runScheduled as runAlphaCycle } from "./alpha/routes.ts";

const app = withAlgo(withFutures(withAgents(base as any) as any) as any);

export default {
  fetch: (request: Request, env: any) => app.fetch(request, env),
  /** Cron Trigger. Two independent passes, each isolated so one failing never blocks the other:
   *  1. paper-trading cycle (off unless ETI_PAPER_SYMBOLS is set; simulated only)
   *  2. Global Alpha research loop (scans, SEC/DEX research, prediction resolution, paper-position monitoring) */
  async scheduled(_event: unknown, env: any, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runPaperCycle(env).then(() => undefined, e => console.error("paper cycle failed", e instanceof Error ? e.message : e)));
    ctx.waitUntil(runAlphaCycle(env).then(() => undefined, e => console.error("alpha cycle failed", e instanceof Error ? e.message : e)));
  },
};
