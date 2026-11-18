/**
 * Bitget Unified Trading Account WebSocket gateway.
 * API secrets stay in Worker bindings; browser clients authenticate with the ETI execution token
 * in the first WebSocket message (never in the URL), then receive a fixed allowlist of UTA topics.
 */
import { authenticate, isOperator, sameOrigin } from "../auth/session.ts";
import { bitgetCreds, bitgetSign } from "./api.ts";

const PRIVATE_URL = "wss://ws.bitget.com/v3/ws/private";
const PRIVATE_TOPICS = ["account", "order", "position", "fill"] as const;

export function bitgetUtaPrivateSubscriptions() {
  return PRIVATE_TOPICS.map((topic) => ({ instType: "UTA", topic }));
}

export async function bitgetUtaLogin(env: Record<string, any>, now: () => number = Date.now) {
  const c = bitgetCreds(env);
  if (!c.complete) throw new Error("credentials_missing");
  // Bitget WS login timestamps are Unix seconds (REST signing uses milliseconds).
  const timestamp = String(Math.floor(now() / 1000));
  const sign = await bitgetSign(c.secret!, timestamp, "GET", "/user/verify", "");
  return { op: "login", args: [{ apiKey: c.key!, passphrase: c.passphrase!, timestamp, sign }] };
}

export async function handleBitgetPrivateWebSocket(req: Request, env: Record<string, any>): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ error: "websocket_upgrade_required" }), { status: 426, headers: { "content-type": "application/json" } });
  }
  if (req.headers.get("origin") && !sameOrigin(req)) return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  const auth = await authenticate(req, env as any);
  if (!isOperator(auth)) return new Response(JSON.stringify({ error: "operator_auth_required" }), { status: 401, headers: { "content-type": "application/json" } });
  if (!bitgetCreds(env).complete) {
    return new Response(JSON.stringify({ error: "credentials_missing" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const Pair = (globalThis as any).WebSocketPair;
  const Socket = (globalThis as any).WebSocket;
  if (!Pair || !Socket) return new Response(JSON.stringify({ error: "websocket_runtime_unavailable" }), { status: 501, headers: { "content-type": "application/json" } });

  const pair = new Pair();
  const client = pair[0], server = pair[1];
  server.accept();
  let upstream: WebSocket | null = null;
  let loggedIn = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const sendClient = (value: unknown) => {
    if (!closed && server.readyState === 1) {
      try { server.send(typeof value === "string" ? value : JSON.stringify(value)); } catch { /* socket is closing */ }
    }
  };
  const close = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try { upstream?.close(code, reason); } catch { /* already closed */ }
    try { server.close(code, reason); } catch { /* already closed */ }
  };

  sendClient({ event: "status", state: "connecting" });
  try {
    upstream = new Socket(PRIVATE_URL);
    upstream.addEventListener("open", async () => {
      if (closed || !upstream) return;
      try { upstream.send(JSON.stringify(await bitgetUtaLogin(env))); }
      catch { sendClient({ event: "error", code: "login_signing_failed" }); close(1011, "login signing failed"); }
    });
    upstream.addEventListener("message", (upEvent: MessageEvent) => {
      if (closed) return;
      const raw = typeof upEvent.data === "string" ? upEvent.data : "";
      let message: any;
      try { message = JSON.parse(raw); } catch { sendClient(raw); return; }
      if (message?.event === "login") {
        if (String(message.code) !== "0" && String(message.code) !== "00000") {
          sendClient({ event: "error", code: "bitget_login_rejected", upstreamCode: String(message.code || "") });
          close(1011, "Bitget login rejected");
          return;
        }
        loggedIn = true;
        try { upstream?.send(JSON.stringify({ op: "subscribe", args: bitgetUtaPrivateSubscriptions() })); }
        catch { close(1011, "subscription failed"); return; }
        sendClient({ event: "status", state: "authenticated", topics: PRIVATE_TOPICS });
      }
      sendClient(raw);
    });
    upstream.addEventListener("error", () => { sendClient({ event: "error", code: "upstream_websocket_error" }); close(1011, "upstream error"); });
    upstream.addEventListener("close", () => { if (!closed) { sendClient({ event: "status", state: "disconnected" }); close(1011, "upstream closed"); } });
  } catch { sendClient({ event: "error", code: "upstream_connect_failed" }); close(1011, "upstream connect failed"); }

  server.addEventListener("message", (event: MessageEvent) => {
    if (closed) return;
    const value = typeof event.data === "string" ? event.data : "";
    if (value === "ping") sendClient("pong");
    else if (value) sendClient({ event: "error", code: "client_message_not_supported" });
  });

  server.addEventListener("close", () => close());
  server.addEventListener("error", () => close(1011, "client socket error"));
  // Bitget requires a ping at least once every two minutes; use 30 seconds as recommended.
  heartbeat = setInterval(() => {
    if (!closed && loggedIn && upstream?.readyState === 1) {
      try { upstream.send("ping"); } catch { close(1011, "heartbeat failed"); }
    }
  }, 30000);

  return new Response(null, { status: 101, webSocket: client } as any);
}
