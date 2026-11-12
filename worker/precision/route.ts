import { handlePrecision } from "./api.ts";
import type { PrecisionEnv } from "./stores.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
/** Serve /api/precision/* here and delegate every other route to the wrapped application untouched. */
export function withPrecision<E extends PrecisionEnv>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      if (new URL(request.url).pathname.startsWith("/api/precision/")) return handlePrecision(request, env);
      return base.fetch(request, env);
    },
  };
}
