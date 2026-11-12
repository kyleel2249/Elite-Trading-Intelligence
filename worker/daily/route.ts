import { handleDailyReport } from "./api.ts";
import { dailyPage } from "./page.ts";
import type { DailyEnv } from "./collect.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/** Serves /api/daily-report*, and the /daily page; every other route is delegated to the wrapped application untouched. */
export function withDailyReport<E extends DailyEnv>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/api/daily-report" || path.startsWith("/api/daily-report/")) return handleDailyReport(request, env);
      if (request.method === "GET" && path === "/daily") return new Response(dailyPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
      return base.fetch(request, env);
    },
  };
}
