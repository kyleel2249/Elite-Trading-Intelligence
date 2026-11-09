/**
 * Worker entrypoint. Layers, outermost first:
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   2. futures agents + gateway (/api/agents/futures/*, /api/futures/*)
 *   3. multi-agent system (/api/agents/*, /agents)
 *   4. the existing application (worker/index.ts), left unchanged, which handles every other route.
 */
import base from "./index";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";
import { withFutures } from "./agents/futures-route.ts";

export default withAlgo(withFutures(withAgents(base as any) as any) as any);
