/**
 * Secure Bitget private WebSocket relay for production/demo UTA and Classic accounts.
 * Bitget credentials never leave Worker bindings; browser clients require an operator session.
 */
import { authenticate, isOperator, sameOrigin } from "../auth/session.ts";
import { bitgetSign } from "./api.ts";
import { bitgetClassicPrivateSubscriptions, bitgetPrivateCredentialSet, bitgetWsEndpoint, type BitgetWsAccount, type BitgetWsEnvironment } from "./transports.ts";

const UTA_TOPICS = ["account", "order", "position", "fill"] as const;
export function bitgetUtaPrivateSubscriptions() { return UTA_TOPICS.map((topic) => ({ instType: "UTA", topic })); }

export async function bitgetUtaLogin(env: Record<string, any>, now: () => number = Date.now) {
  return bitgetPrivateLogin(env, "production", "uta", now);
}
export function bitgetClassicPrivateTopics() { return bitgetClassicPrivateSubscriptions(); }

export async function bitgetPrivateLogin(env: Record<string, any>, environment: BitgetWsEnvironment = "production", account: BitgetWsAccount = "uta", now: () => number = Date.now) {
  const c = bitgetPrivateCredentialSet(env, environment, account);
  if (!c.key || !c.secret || !c.passphrase) throw new Error("credentials_missing");
  const timestamp = String(Math.floor(now() / 1000));
  const sign = await bitgetSign(c.secret, timestamp, "GET", "/user/verify", "");
  return { op: "login", args: [{ apiKey: c.key, passphrase: c.passphrase, timestamp, sign }] };
}

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handleBitgetPrivateWebSocket(req: Request, env: Record<string, any>): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonError("websocket_upgrade_required", 426);
  if (req.headers.get("origin") && !sameOrigin(req)) return jsonError("origin_not_allowed", 403);
  const auth = await authenticate(req, env as any);
  if (!isOperator(auth)) return jsonError("operator_auth_required", 401);

  const url = new URL(req.url);
  const environment = (url.searchParams.get("environment") || "production") as BitgetWsEnvironment;
  const account = (url.searchParams.get("account") || "uta") as BitgetWsAccount;
  if (!["production", "demo"].includes(environment) || !["uta", "classic"].includes(account)) return jsonError("invalid_transport_selection", 400);
  try { bitgetWsEndpoint(environment, account, "private"); } catch { return jsonError("unsupported_environment_account_combination", 400); }
  const creds = bitgetPrivateCredentialSet(env, environment, account);
  if (!creds.key || !creds.secret || !creds.passphrase) return jsonError("credentials_missing_for_selected_environment", 503);

  const Pair = (globalThis as any).WebSocketPair, Socket = (globalThis as any).WebSocket;
  if (!Pair || !Socket) return jsonError("websocket_runtime_unavailable", 501);
  const pair = new Pair(), client = pair[0], server = pair[1];
  server.accept();
  let upstream: WebSocket | null = null, loggedIn = false, closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let connectTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastUpstreamMessageAt = Date.now();

  const sendClient = (value: unknown) => {
    if (!closed && server.readyState === 1) try { server.send(typeof value === "string" ? value : JSON.stringify(value)); } catch { /* closing */ }
  };
  const close = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (connectTimeout) clearTimeout(connectTimeout);
    heartbeat = null;
    connectTimeout = null;
    try { upstream?.close(code, reason); } catch { /* already closed */ }
    try { server.close(code, reason); } catch { /* already closed */ }
  };

  sendClient({ event: "status", state: "connecting", environment, account });
  connectTimeout = setTimeout(() => { if (!loggedIn && !closed) { sendClient({ event: "error", code: "upstream_login_timeout" }); close(1011, "upstream login timeout"); } }, 20000);
  try {
    upstream = new Socket(bitgetWsEndpoint(environment, account, "private"));
    upstream.addEventListener("open", async () => {
      if (closed || !upstream) return;
      try { upstream.send(JSON.stringify(await bitgetPrivateLogin(env, environment, account))); }
      catch { sendClient({ event: "error", code: "login_signing_failed" }); close(1011, "login signing failed"); }
    });
    upstream.addEventListener("message", (event: MessageEvent) => {
      if (closed) return;
      const raw = typeof event.data === "string" ? event.data : "";
      lastUpstreamMessageAt = Date.now();
      if (raw === "pong") { sendClient("pong"); return; }
      if (raw === "ping") { try { upstream?.send("pong"); } catch { close(1011, "upstream ping response failed"); } return; }
      let message: any;
      try { message = JSON.parse(raw); } catch { sendClient(raw); return; }
      if (message?.event === "login") {
        if (String(message.code) !== "0" && String(message.code) !== "00000") {
          sendClient({ event: "error", code: "bitget_login_rejected", upstreamCode: String(message.code || "") });
          close(1011, "Bitget login rejected"); return;
        }
        loggedIn = true;
        if (connectTimeout) clearTimeout(connectTimeout);
        connectTimeout = null;
        const args = account === "uta" ? bitgetUtaPrivateSubscriptions() : bitgetClassicPrivateTopics();
        try { upstream?.send(JSON.stringify({ op: "subscribe", args })); }
        catch { close(1011, "subscription failed"); return; }
        sendClient({ event: "status", state: "authenticated", environment, account, topics: args });
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
  heartbeat = setInterval(() => {
    if (!closed && loggedIn && upstream?.readyState === 1) {
      if (Date.now() - lastUpstreamMessageAt > 65000) { close(1011, "upstream heartbeat timeout"); return; }
      try { upstream.send("ping"); } catch { close(1011, "heartbeat failed"); }
    }
  }, 30000);
  return new Response(null, { status: 101, webSocket: client } as any);
}
