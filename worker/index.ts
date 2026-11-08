/**
 * ETI edge Worker — reverse proxy to an external FastAPI origin.
 *
 * Cloudflare Containers are NOT used. Run the Python app with Docker Compose,
 * a VPS, Fly.io (see fly.toml), a Cloudflare Tunnel or any container host, then set BACKEND_URL
 * (e.g. https://eti-trading-intelligence.fly.dev).
 *
 * Secrets and provider keys stay on the origin; this Worker only forwards HTTP.
 * Server-Sent Events (/api/stream/sse) stream straight through.
 */

export interface Env {
  /** Origin of the ETI FastAPI process, no trailing slash. Example: https://eti.example.com */
  BACKEND_URL?: string;
  ETI_EDGE?: string;
}

const DOCS_URL =
  "https://github.com/kyleel2249/Elite-Trading-Intelligence/blob/main/docs/CLOUDFLARE.md";

/** Headers that must not be forwarded to the origin. */
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
  "cf-worker",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-forwarded-host",
]);

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function missingBackendResponse(): Response {
  return json(
    {
      service: "Elite Trading Intelligence",
      role: "edge-proxy",
      status: "misconfigured",
      message:
        "BACKEND_URL is not set. Deploy the FastAPI app (Docker Compose or any host), then set the Worker variable BACKEND_URL to that origin (no trailing slash).",
      fix: [
        "1. Deploy the origin (Fly.io: run the 'Deploy' GitHub workflow; or self-host with docker-compose.tunnel.yml).",
        "2. Run: npx wrangler secret put BACKEND_URL   (paste https://your-origin, no trailing slash)",
        "3. Or in the dashboard: Workers & Pages -> this Worker -> Settings -> Variables and Secrets -> add BACKEND_URL.",
        "4. Re-test: curl <worker-url>/api/system/health",
      ],
      docs: DOCS_URL,
      local: "docker compose up --build → http://localhost:8000",
    },
    503,
  );
}

/** Parse BACKEND_URL; returns the origin URL or an error string. */
function parseBackend(raw: string | undefined): { url: URL } | { error: string } | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "BACKEND_URL is not a valid absolute URL (expected e.g. https://eti.example.com)" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "BACKEND_URL must use http:// or https://" };
  }
  return { url };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const parsed = parseBackend(env.BACKEND_URL);

    // Worker-owned status endpoint: never proxied, useful for deploy checks.
    if (incoming.pathname === "/__eti/status") {
      return json(
        {
          service: "Elite Trading Intelligence",
          role: "edge-proxy",
          status: parsed && "url" in parsed ? "configured" : "misconfigured",
          backend: parsed && "url" in parsed ? parsed.url.origin : null,
          error: parsed && "error" in parsed ? parsed.error : undefined,
        },
        parsed && "url" in parsed ? 200 : 503,
      );
    }

    if (!parsed) return missingBackendResponse();
    if ("error" in parsed) {
      return json({ error: "invalid_backend_url", message: parsed.error, docs: DOCS_URL }, 500);
    }
    const targetBase = parsed.url;

    // Guard against a proxy loop (BACKEND_URL pointing at this very Worker).
    if (targetBase.host === incoming.host) {
      return json(
        {
          error: "proxy_loop",
          message: "BACKEND_URL points at this Worker. Set it to the FastAPI origin instead.",
          docs: DOCS_URL,
        },
        500,
      );
    }

    const target = new URL(incoming.pathname + incoming.search, targetBase);

    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    });
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
      const upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
      });
      const outHeaders = new Headers(upstream.headers);
      outHeaders.set("x-eti-proxy", "cloudflare-worker");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "upstream fetch failed";
      return json(
        {
          error: "backend_unreachable",
          message,
          backend: targetBase.origin,
          hint: "Check that the origin is running and publicly reachable over HTTPS.",
        },
        502,
      );
    }
  },
};
