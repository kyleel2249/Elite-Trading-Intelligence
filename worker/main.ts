/**
 * Worker entrypoint. Adds the ETI algorithmic-intelligence API in front of the existing
 * application (worker/index.ts), which is left unchanged and handles every other route.
 */
import base from "./index";
import { withAlgo } from "./algo/route.ts";

export default withAlgo(base);
