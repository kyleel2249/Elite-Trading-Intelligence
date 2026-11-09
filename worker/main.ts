/**
 * Worker entrypoint. Layers, outermost first:
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   2. ETI multi-agent system (/api/agents/*)
 *   3. the existing application (worker/index.ts), left unchanged, which handles every other route.
 */
import base from "./index.ts";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";
import { runPaperCycle } from "./algo/paper-api.ts";

const app = withAlgo(withAgents(base as any) as any);

export default {
  fetch: (request: Request, env: any) => app.fetch(request, env),
  /** Cron Trigger: one paper-trading pass (manage open positions, evaluate configured symbols).
   *  Does nothing unless ETI_PAPER_SYMBOLS is set; new positions also need ETI_PAPER_AUTOEXECUTE=true. Simulated only. */
  async scheduled(_event: unknown, env: any, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runPaperCycle(env).then(() => undefined, e => console.error("paper cycle failed", e instanceof Error ? e.message : e)));
  },
};
