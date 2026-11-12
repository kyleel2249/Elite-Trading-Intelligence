import { elitePage } from "./page.ts";
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
export function withElite<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env) {
    if (request.method === "GET" && (new URL(request.url).pathname.replace(/\/+$/, "") === "/elite"))
      return new Response(elitePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    return base.fetch(request, env);
  } };
}
