import { handleAlgoSignal } from "./api.ts";
import type { MarketEnv } from "../market.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
/** Serve /api/algo/signal here and delegate every other route to the wrapped application untouched. */
export function withAlgo<E extends MarketEnv>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      if (new URL(request.url).pathname === "/api/algo/signal") return handleAlgoSignal(request, env);
      return base.fetch(request, env);
    },
  };
}
