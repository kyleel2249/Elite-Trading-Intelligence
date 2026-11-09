/**
 * Worker entrypoint. Layers, outermost first:
 *   1. ETI algorithmic-intelligence API (/api/algo/*)
 *   2. ETI multi-agent system (/api/agents/*)
 *   3. the existing application (worker/index.ts), left unchanged, which handles every other route.
 */
import base from "./index";
import { withAlgo } from "./algo/route.ts";
import { withAgents } from "./agents/route.ts";

export default withAlgo(withAgents(base as any) as any);
