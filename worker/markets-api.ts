/**
 * /api/markets/* for the Worker (read-only planning endpoints; same paths and shapes as the FastAPI service where they overlap).
 * Not provided here: /snapshot, /calibrated-assess and order placement - the Worker has no OANDA/Alpaca adapter
 * (live quotes and calibration live in the Python service; crypto prices stay on /api/market/*).
 */
import { assess, calendarInfo, classify, listInstruments, marketRiskReview, overview, profileFor, profileKeys, sessionIds, sessionStatus, SESSIONS, type MarketsSettings } from "./markets.ts";

const SYMBOL = /^[A-Za-z0-9./:_\-^ ]{1,40}$/, PROVIDER = /^[A-Za-z0-9_\-]{1,32}$/, SESSION_ID = /^[a-z0-9_]{1,32}$/;
const CLASSES = ["forex", "metal", "crypto", "stock", "index", "commodity", "future", "option"];
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
class Bad extends Error {}

export function settingsFromEnv(env: Record<string, unknown> | undefined): MarketsSettings {
  const v = (k: string) => (typeof env?.[k] === "string" && (env![k] as string).length ? (env![k] as string) : null);
  return { oanda_api_token: v("OANDA_API_TOKEN"), oanda_account_id: v("OANDA_ACCOUNT_ID"), alpaca_api_key: v("ALPACA_API_KEY"),
           alpaca_secret_key: v("ALPACA_SECRET_KEY"), binance_api_key: v("BINANCE_API_KEY"), binance_secret_key: v("BINANCE_SECRET_KEY") };
}
function str(q: URLSearchParams, k: string, re: RegExp, required = false): string | null {
  const v = q.get(k);
  if (v === null || v === "") { if (required) throw new Bad(`${k} is required`); return null; }
  if (!re.test(v)) throw new Bad(`${k} is invalid`);
  return v;
}
function num(q: URLSearchParams, k: string, o: { gt?: number; ge?: number; le: number }): number | null {
  const raw = q.get(k);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || (o.gt !== undefined && !(n > o.gt)) || (o.ge !== undefined && !(n >= o.ge)) || n > o.le) throw new Bad(`${k} is out of range`);
  return n;
}
function classified(symbol: string, provider: string | null) {
  const i = classify(symbol, provider);
  if (i.asset_class === "unknown") throw new Bad("Symbol could not be classified as a supported market");
  return i;
}

/** Returns a Response for /api/markets/* routes, or null when the path is not ours. */
export function handleMarketsApi(request: Request, env?: Record<string, unknown>): Response | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/markets/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, OPTIONS" } });
  if (request.method !== "GET") return reply({ error: "method_not_allowed", detail: "These endpoints are read-only (GET)." }, 405);
  const q = url.searchParams, settings = settingsFromEnv(env), now = Date.now();
  try {
    switch (url.pathname.slice("/api/markets/".length).replace(/\/$/, "")) {
      case "overview": {
        const counts: Record<string, number> = {};
        for (const i of listInstruments()) counts[i.asset_class] = (counts[i.asset_class] ?? 0) + 1;
        return reply({ as_of_utc: new Date(now).toISOString(), catalog_counts: counts, ...overview(settings),
                       sessions: Object.fromEntries(sessionIds().map((s) => [s, sessionStatus(s, now)])), profile_keys: profileKeys(), edge: "cloudflare-worker",
                       edge_note: "Planning endpoints only: this Worker has no OANDA/Alpaca adapter, so no quotes or orders here." });
      }
      case "instruments": {
        const ac = q.get("asset_class");
        if (ac && !CLASSES.includes(ac)) throw new Bad("asset_class is invalid");
        const tier = str(q, "tier", /^[A-Za-z_]{1,24}$/), text = q.get("q");
        if (text && text.length > 40) throw new Bad("q is too long");
        const items = listInstruments(ac, text, tier);
        return reply({ count: items.length, instruments: items, note: "Curated catalog; any well-formed symbol can still be classified via /api/markets/classify." });
      }
      case "classify": return reply(classify(str(q, "symbol", SYMBOL, true)!, str(q, "provider", PROVIDER)));
      case "sessions": {
        const symbol = str(q, "symbol", SYMBOL), sid = str(q, "session_id", SESSION_ID);
        if (symbol) return reply(sessionStatus(classified(symbol, null).session_id, now));
        if (sid) return SESSIONS[sid] ? reply(sessionStatus(sid, now)) : reply({ detail: "Unknown session_id" }, 404);
        return reply({ as_of_utc: new Date(now).toISOString(), sessions: Object.fromEntries(sessionIds().map((s) => [s, sessionStatus(s, now)])) });
      }
      case "calendars": {
        const covered: Record<string, unknown> = {}, missing: unknown[] = [];
        for (const [sid, spec] of Object.entries<any>(SESSIONS)) {
          if (spec.always_open) continue;
          const info = spec.holiday_key ? calendarInfo(spec.holiday_key) : null;
          if (info) covered[sid] = info; else missing.push({ session_id: sid, name: spec.name, reason: "no verifiable holiday calendar loaded; the market may be closed on public holidays" });
        }
        return reply({ verification_levels: { official: "published by the exchange", secondary: "third-party list cross-checked against statutory rules; verify", derived: "computed from public-holiday rules and Easter; verify" }, covered, missing });
      }
      case "profile": {
        const provider = str(q, "provider", PROVIDER), i = classified(str(q, "symbol", SYMBOL, true)!, provider);
        return reply({ instrument: i, profile: profileFor(i, num(q, "listing_age_days", { ge: 0, le: 100000 }), num(q, "avg_daily_volume_usd", { gt: 0, le: 1e13 })) });
      }
      case "assess": {
        const symbol = str(q, "symbol", SYMBOL, true)!, side = q.get("side") ?? "buy", env2 = q.get("environment") ?? "paper";
        if (side !== "buy" && side !== "sell") throw new Bad("side must be buy or sell");
        if (!["paper", "testnet", "live"].includes(env2)) throw new Bad("environment must be paper, testnet or live");
        return reply(assess(symbol, {
          now, settings, side, environment: env2, provider: str(q, "provider", PROVIDER),
          price: num(q, "price", { gt: 0, le: 1e12 }), account_equity: num(q, "account_equity", { gt: 0, le: 1e12 }) ?? 10000, risk_pct: num(q, "risk_pct", { gt: 0, le: 10 }) ?? 1,
          stop_price: num(q, "stop_price", { gt: 0, le: 1e12 }), atr: num(q, "atr", { gt: 0, le: 1e12 }), measured_spread_bps: num(q, "measured_spread_bps", { ge: 0, le: 10000 }),
          avg_daily_volume_usd: num(q, "avg_daily_volume_usd", { gt: 0, le: 1e13 }), listing_age_days: num(q, "listing_age_days", { ge: 0, le: 100000 }),
          quote_to_usd: num(q, "quote_to_usd", { gt: 0, le: 1e9 }), max_notional_pct: num(q, "max_notional_pct", { gt: 0, le: 100 }) ?? 6,
        }));
      }
      case "review": {
        const env2 = q.get("environment") ?? "paper";
        if (!["paper", "testnet", "live"].includes(env2)) throw new Bad("environment must be paper, testnet or live");
        return reply(marketRiskReview(str(q, "symbol", SYMBOL, true)!, str(q, "provider", PROVIDER), env2, now));
      }
      default: return reply({ error: "not_found", path: url.pathname, detail: "Not available on the Worker (/snapshot and /calibrated-assess need the Python service)." }, 404);
    }
  } catch (e) {
    if (e instanceof Bad) return reply({ detail: e.message }, 422);
    console.error("markets api failed", e instanceof Error ? e.message : e);
    return reply({ error: "internal_error" }, 500);
  }
}
