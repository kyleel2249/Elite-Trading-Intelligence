import { handleAlgoSignal } from "./api.ts";
import { handleAlgoBacktest } from "./backtest-api.ts";
import { handleAlgoRegistry } from "./registry-api.ts";
import type { MarketEnv } from "../market.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
/** Serve /api/algo/signal here and delegate every other route to the wrapped application untouched. */
export function withAlgo<E extends MarketEnv>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      if (new URL(request.url).pathname === "/api/algo/signal") return handleAlgoSignal(request, env);
      if (new URL(request.url).pathname === "/api/algo/backtest") return handleAlgoBacktest(request, env);
      const p = new URL(request.url).pathname;
      if (p.startsWith("/api/algo/expectancy") || p.startsWith("/api/algo/journal")) return handleAlgoRegistry(request, env as never);
      return base.fetch(request, env);
    },
  };
}
