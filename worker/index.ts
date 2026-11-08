/**
 * ETI edge Worker — reverse proxy to an external FastAPI origin.
 *
 * Cloudflare Containers are NOT used. Run the Python app with Docker Compose,
 * a VPS, or any container host, then set BACKEND_URL (e.g. https://api.example.com).
 *
 * Secrets and provider keys stay on the origin; this Worker only forwards HTTP.
 */

export interface Env {
  /** Origin of the ETI FastAPI process, no trailing slash. Example: https://eti.example.com */
  BACKEND_URL?: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "x-forwarded-for",
]);

function missingBackendResponse(): Response {
  const body = {
    service: "Elite Trading Intelligence",
    role: "edge-proxy",
    status: "misconfigured",
    message:
      "BACKEND_URL is not set. Deploy the FastAPI app (Docker Compose or any host), then set the Worker variable BACKEND_URL to that origin (no trailing slash).",
    docs: "https://github.com/kyleel2249/Elite-Trading-Intelligence/blob/main/docs/CLOUDFLARE.md",
    local: "docker compose up --build → http://localhost:8000",
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const backend = (env.BACKEND_URL || "").trim().replace(/\/+$/, "");
    if (!backend) {
      return missingBackendResponse();
    }

    let targetBase: URL;
    try {
      targetBase = new URL(backend);
    } catch {
      return new Response(
        JSON.stringify({
          error: "BACKEND_URL is not a valid absolute URL",
          backend_url: backend,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, targetBase);

    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        headers.set(key, value);
      }
    });
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      // @ts-expect-error duplex required for streaming bodies in some runtimes
      init.duplex = "half";
    }

    try {
      const upstream = await fetch(target.toString(), init);
      const outHeaders = new Headers(upstream.headers);
      outHeaders.set("x-eti-proxy", "cloudflare-worker");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "upstream fetch failed";
      return new Response(
        JSON.stringify({
          error: "backend_unreachable",
          message,
          backend: targetBase.origin,
        }),
        {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  },
};
