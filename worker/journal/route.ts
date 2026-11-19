import { handleJournal } from "./api.ts";
import { journalPage } from "./page.ts";
import { journalProfilePage } from "./profile.ts";
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
/** Serves journal APIs and dashboards; journal API remains authenticated. */
export function withJournal<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\\/+$/, "") || "/";
    if (path === "/api/journal" || path.startsWith("/api/journal/")) return handleJournal(request, env);
    if (request.method === "GET" && path === "/journal/profile") return new Response(journalProfilePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    if (request.method === "GET" && path === "/journal") return new Response(journalPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    return base.fetch(request, env);
  } };
}
