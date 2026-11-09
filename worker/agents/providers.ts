/**
 * Keyless / optional-key research providers feeding the Fundamental, Macro, News and Crypto agents.
 * Every call is read-only, time-limited and reported in a ProviderStatus; failures never produce substitute data.
 *   News:      CoinDesk + Cointelegraph public RSS (asset-filtered)
 *   Tokenomics: CoinGecko public API (market cap, FDV, supply)
 *   Macro:     FRED API (requires FRED_API_KEY Worker secret; skipped if absent)
 */
import type { SuppliedData } from "./types.ts";
import { finite } from "./math.ts";

export interface ProviderStatus { provider: string; ok: boolean; latencyMs: number; fetchedAt: string; items?: number; detail?: string }
export interface ProviderEnv { FRED_API_KEY?: string }
interface HttpRes { ok: boolean; status: number; text: string; ms: number; err?: string }

const UA = "ETI-Agents/1.0 (read-only research)";
const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH"];
export function baseOf(symbol: string): string {
  for (const q of QUOTES) if (symbol.endsWith(q) && symbol.length - q.length >= 2) return symbol.slice(0, -q.length);
  return symbol;
}
const KNOWN: Record<string, { id: string; names: string[]; ticker?: string }> = {
  BTC: { id: "bitcoin", names: ["bitcoin"], ticker: "BTC" }, ETH: { id: "ethereum", names: ["ethereum", "ether"], ticker: "ETH" },
  SOL: { id: "solana", names: ["solana"], ticker: "SOL" }, BNB: { id: "binancecoin", names: ["bnb", "binance coin"] },
  XRP: { id: "ripple", names: ["xrp", "ripple"] }, ADA: { id: "cardano", names: ["cardano"] }, DOGE: { id: "dogecoin", names: ["dogecoin"], ticker: "DOGE" },
  AVAX: { id: "avalanche-2", names: ["avalanche"] }, DOT: { id: "polkadot", names: ["polkadot"] }, LINK: { id: "chainlink", names: ["chainlink"] },
  LTC: { id: "litecoin", names: ["litecoin"], ticker: "LTC" }, TRX: { id: "tron", names: ["tron"] },
};

async function http(url: string, accept: string, ms = 6000): Promise<HttpRes> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { accept, "user-agent": UA }, signal: AbortSignal.timeout(ms), cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
    return { ok: res.ok, status: res.status, text: await res.text(), ms: Date.now() - t0 };
  } catch (e) { return { ok: false, status: 0, text: "", ms: Date.now() - t0, err: e instanceof Error ? e.name : "error" }; }
}
const status = (provider: string, r: HttpRes, ok: boolean, extra: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({ provider, ok, latencyMs: r.ms, fetchedAt: new Date().toISOString(), ...(ok ? {} : { detail: r.err ?? "http_" + r.status }), ...extra });

// ------------------------------------------------------------------ RSS news
const clean = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
export interface FeedItem { headline: string; source: string; publishedAt: string }
export function parseRss(xml: string, source: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const it of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(it)?.[1], d = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(it)?.[1];
    if (!t || !d) continue;
    const ms = Date.parse(d.trim()); if (!Number.isFinite(ms)) continue;
    const h = clean(t); if (h) out.push({ headline: h.slice(0, 300), source, publishedAt: new Date(ms).toISOString() });
  }
  return out;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function filterForAsset(items: FeedItem[], names: string[], ticker?: string): FeedItem[] {
  const nameRe = names.length ? new RegExp("\\b(" + names.map(esc).join("|") + ")\\b", "i") : null, tickRe = ticker ? new RegExp("\\b" + esc(ticker) + "\\b") : null;
  return items.filter((i) => (nameRe && nameRe.test(i.headline)) || (tickRe && tickRe.test(i.headline)));
}

// ------------------------------------------------------------------ CoinGecko
async function coingecko(base: string): Promise<{ st: ProviderStatus; tokenomics?: Record<string, number>; name?: string }> {
  let id = KNOWN[base]?.id, r: HttpRes;
  if (!id) {
    r = await http("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(base), "application/json");
    try { id = (JSON.parse(r.text).coins ?? []).find((c: any) => String(c.symbol).toUpperCase() === base)?.id; } catch { /* handled below */ }
    if (!id) return { st: status("coingecko", r, false, { detail: r.ok ? "asset_not_found" : undefined }) };
  }
  r = await http("https://api.coingecko.com/api/v3/coins/" + encodeURIComponent(id) + "?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false", "application/json");
  if (!r.ok) return { st: status("coingecko", r, false) };
  try {
    const j = JSON.parse(r.text), m = j.market_data ?? {}, t: Record<string, number> = {};
    const put = (k: string, v: unknown) => { const n = finite(v); if (n !== undefined && n > 0) t[k] = n; };
    put("marketCapUsd", m.market_cap?.usd); put("fdvUsd", m.fully_diluted_valuation?.usd);
    put("circulatingSupply", m.circulating_supply); put("totalSupply", m.total_supply); put("maxSupply", m.max_supply);
    return { st: status("coingecko", r, Object.keys(t).length > 0, { items: Object.keys(t).length }), tokenomics: t, name: typeof j.name === "string" ? j.name : undefined };
  } catch { return { st: status("coingecko", r, false, { detail: "invalid_json" }) }; }
}

// ----------------------------------------------------------------------- FRED
export interface Obs { date: string; value: number }
export function parseFred(j: any): Obs[] {
  return (Array.isArray(j?.observations) ? j.observations : []).map((o: any) => ({ date: String(o.date), value: Number(o.value) })).filter((o: Obs) => Number.isFinite(o.value) && Number.isFinite(Date.parse(o.date)));
}
/** obs must be newest-first. Returns the newest observation at least `days` older than obs[0]. */
export function valueDaysBefore(obs: Obs[], days: number): Obs | undefined {
  if (!obs.length) return undefined;
  const cut = Date.parse(obs[0].date) - days * 86_400_000;
  return obs.find((o) => Date.parse(o.date) <= cut);
}
async function fred(key: string): Promise<{ st: ProviderStatus; macro?: Record<string, unknown> }> {
  const t0 = Date.now(), get = async (id: string, limit: number) => {
    const r = await http(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=${limit}`, "application/json");
    if (!r.ok) throw new Error(id + ":http_" + r.status);
    return parseFred(JSON.parse(r.text));
  };
  try {
    const [ry, usd, m2, vix, cpi] = await Promise.all([get("DFII10", 45), get("DTWEXBGS", 45), get("M2SL", 16), get("VIXCLS", 5), get("CPIAUCSL", 16)]);
    const macro: Record<string, unknown> = { source: "FRED" }, ryP = valueDaysBefore(ry, 30), usdP = valueDaysBefore(usd, 30), m2P = valueDaysBefore(m2, 365), cpiP = valueDaysBefore(cpi, 365);
    if (ry[0] && ryP) macro.realYield10yChange30dBps = (ry[0].value - ryP.value) * 100;
    if (usd[0] && usdP && usdP.value > 0) macro.dxyChange30dPct = (usd[0].value / usdP.value - 1) * 100;
    if (m2[0] && m2P && m2P.value > 0) macro.m2YoyPct = (m2[0].value / m2P.value - 1) * 100;
    if (vix[0]) macro.vix = vix[0].value;
    if (cpi[0] && cpiP && cpiP.value > 0) macro.cpiYoyPct = (cpi[0].value / cpiP.value - 1) * 100;
    const n = Object.keys(macro).length - 1;
    return { st: { provider: "fred", ok: n > 0, latencyMs: Date.now() - t0, fetchedAt: new Date().toISOString(), items: n, ...(n ? {} : { detail: "no_usable_series" }) }, macro: n ? macro : undefined };
  } catch (e) { return { st: { provider: "fred", ok: false, latencyMs: Date.now() - t0, fetchedAt: new Date().toISOString(), detail: e instanceof Error ? e.message.replace(key, "***") : "error" } }; }
}

export async function fetchProviderData(env: ProviderEnv, symbol: string, now = Date.now()): Promise<{ supplied: SuppliedData; status: ProviderStatus[] }> {
  const base = baseOf(symbol), known = KNOWN[base], supplied: SuppliedData = {}, sts: ProviderStatus[] = [];
  const feeds = [["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"], ["Cointelegraph", "https://cointelegraph.com/rss"]] as const;
  const [cg, macroRes, ...rss] = await Promise.all([coingecko(base), env.FRED_API_KEY ? fred(env.FRED_API_KEY) : Promise.resolve(null), ...feeds.map(([n, u]) => http(u, "application/rss+xml, application/xml, text/xml").then((r) => ({ n, r })))]);
  sts.push(cg.st);
  if (macroRes) { sts.push(macroRes.st); if (macroRes.macro) supplied.macro = macroRes.macro; } else sts.push({ provider: "fred", ok: false, latencyMs: 0, fetchedAt: new Date(now).toISOString(), detail: "FRED_API_KEY not configured" });
  if (cg.tokenomics && Object.keys(cg.tokenomics).length) supplied.fundamentals = { tokenomics: cg.tokenomics, source: "CoinGecko" };
  const names = [...(known?.names ?? []), ...(cg.name ? [cg.name.toLowerCase()] : [])], ticker = known?.ticker ?? (!known && base.length >= 3 ? base : undefined), items: FeedItem[] = [];
  for (const { n, r } of rss) {
    const parsed = r.ok ? parseRss(r.text, n) : [], hit = filterForAsset(parsed, names, ticker);
    sts.push(status("rss:" + n, r, r.ok && parsed.length > 0, { items: hit.length, ...(r.ok && !parsed.length ? { detail: "no_items_parsed" } : {}) }));
    items.push(...hit);
  }
  if (items.length) supplied.news = { items, source: "RSS" };
  return { supplied, status: sts };
}
