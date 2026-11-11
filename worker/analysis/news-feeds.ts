// News ingestion: RSS 2.0 / Atom parsing and feed fetching. No DOM is available in Workers, so parsing is regex-based and defensive.
// Every item must carry a source and a valid timestamp; items that do not are REJECTED (reported, never scored).
import type { AnalysisEnv, FetchFn } from "./fundamental-sources.ts";

export type SourceType = "regulator" | "central_bank" | "exchange" | "company" | "wire" | "research" | "media" | "social" | "unknown";
export interface NewsItem { id: string; title: string; summary?: string; url?: string; source: string; sourceType: SourceType; publishedAt: string; retrievedAt?: string; subjects?: string[]; author?: string; anonymous?: boolean }
export interface FeedConfig { name: string; url: string; type: SourceType; /** True until the URL has been confirmed reachable from the deployed Worker. */ unverifiedUrl?: boolean }
export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: "Federal Reserve press releases", url: "https://www.federalreserve.gov/feeds/press_all.xml", type: "central_bank", unverifiedUrl: true },
  { name: "ECB press releases", url: "https://www.ecb.europa.eu/rss/press.xml", type: "central_bank", unverifiedUrl: true },
  { name: "Bank of England news", url: "https://www.bankofengland.co.uk/rss/news", type: "central_bank", unverifiedUrl: true },
  { name: "SEC press releases", url: "https://www.sec.gov/news/pressreleases.rss", type: "regulator", unverifiedUrl: true },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", type: "media", unverifiedUrl: true },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", type: "media", unverifiedUrl: true },
];
export const TIER: Record<SourceType, 1 | 2 | 3 | 4> = { regulator: 1, central_bank: 1, exchange: 1, company: 1, wire: 2, research: 2, media: 3, social: 4, unknown: 4 };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—" };
export function decodeText(s: string): string {
  const decode = (t: string) => t.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(0x10ffff, Number(d)))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16)))).replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);
  // Feeds often entity-encode their HTML (&lt;p&gt;), so tags are stripped again after decoding.
  return decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
const tag = (block: string, names: string[]): string | undefined => {
  for (const n of names) { const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i")); if (m) return m[1]; }
  return undefined;
};
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };

export interface ParsedFeed { items: NewsItem[]; rejected: { title: string; reason: string }[] }
export function parseFeed(xml: string, feed: Pick<FeedConfig, "name" | "type">, retrievedAt = new Date().toISOString()): ParsedFeed {
  const items: NewsItem[] = [], rejected: ParsedFeed["rejected"] = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(m => m[2]);
  for (const b of blocks) {
    const title = decodeText(tag(b, ["title"]) ?? ""), summary = decodeText(tag(b, ["description", "summary", "content:encoded", "content"]) ?? "");
    const link = (b.match(/<link[^>]*\shref=["']([^"']+)["']/i)?.[1]) ?? decodeText(tag(b, ["link", "guid"]) ?? "");
    const dateRaw = decodeText(tag(b, ["pubDate", "published", "updated", "dc:date"]) ?? ""), t = Date.parse(dateRaw);
    if (!title) { rejected.push({ title: "(untitled)", reason: "missing title" }); continue; }
    if (!dateRaw || !Number.isFinite(t)) { rejected.push({ title, reason: "missing or unparsable publication timestamp" }); continue; }
    items.push({ id: hash(`${feed.name}|${title}|${t}`), title, summary: summary.slice(0, 600) || undefined, url: /^https?:\/\//.test(link) ? link : undefined, source: feed.name, sourceType: feed.type, publishedAt: new Date(t).toISOString(), retrievedAt });
  }
  return { items, rejected };
}

export function feedConfig(env: AnalysisEnv): FeedConfig[] {
  if (!env.NEWS_FEEDS_JSON) return DEFAULT_FEEDS;
  try {
    const v = JSON.parse(env.NEWS_FEEDS_JSON);
    if (!Array.isArray(v)) throw new Error("not an array");
    return v.filter((f: any) => f && typeof f.name === "string" && /^https:\/\//.test(f.url) && f.type in TIER).map((f: any) => ({ name: f.name, url: f.url, type: f.type }));
  } catch { return DEFAULT_FEEDS; }
}
export interface FeedStatus { feed: string; url: string; status: "ok" | "failed"; items: number; rejected: number; error?: string; unverifiedUrl?: boolean }
export async function fetchNews(env: AnalysisEnv, f: FetchFn, now = Date.now()): Promise<{ items: NewsItem[]; rejected: { title: string; reason: string; source: string }[]; feeds: FeedStatus[] }> {
  const feeds = feedConfig(env), items: NewsItem[] = [], rejected: { title: string; reason: string; source: string }[] = [], status: FeedStatus[] = [];
  await Promise.all(feeds.map(async fd => {
    try {
      const r = await f(fd.url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "user-agent": env.SEC_USER_AGENT ?? "ETI-NewsMonitor/1.0" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (!/<(rss|feed|rdf)/i.test(text.slice(0, 2000))) throw new Error("response is not an RSS/Atom feed");
      const p = parseFeed(text.slice(0, 2_000_000), fd, new Date(now).toISOString());
      items.push(...p.items); rejected.push(...p.rejected.map(x => ({ ...x, source: fd.name })));
      status.push({ feed: fd.name, url: fd.url, status: "ok", items: p.items.length, rejected: p.rejected.length, unverifiedUrl: fd.unverifiedUrl });
    } catch (e) { status.push({ feed: fd.name, url: fd.url, status: "failed", items: 0, rejected: 0, error: e instanceof Error ? e.message : "error", unverifiedUrl: fd.unverifiedUrl }); }
  }));
  return { items, rejected, feeds: status };
}

const CRYPTO_NAMES: Record<string, string[]> = { BTC: ["bitcoin", "btc"], ETH: ["ethereum", "ether", "eth"], SOL: ["solana", "sol"], XRP: ["ripple", "xrp"], BNB: ["bnb", "binance coin"], ADA: ["cardano", "ada"], DOGE: ["dogecoin", "doge"] };
const CCY_NAMES: Record<string, string[]> = { USD: ["dollar", "federal reserve", "fed", "fomc", "treasury", "u.s."], EUR: ["euro", "ecb", "european central bank", "eurozone", "euro area"], GBP: ["sterling", "pound", "bank of england", "boe", "u.k."], JPY: ["yen", "bank of japan", "boj"], CHF: ["franc", "snb", "swiss national bank"], AUD: ["australian dollar", "rba", "reserve bank of australia"], CAD: ["canadian dollar", "bank of canada"], NZD: ["new zealand dollar", "rbnz"] };
/** Terms used to decide whether a news item concerns a subject. */
export function subjectAliases(symbol: string, cls: "crypto" | "fx" | "stock" | "unknown"): string[] {
  const s = symbol.toUpperCase().replace(/[-_/]/g, "");
  if (cls === "crypto") { const base = s.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, ""); return [...(CRYPTO_NAMES[base] ?? [base.toLowerCase()]), "crypto", "digital asset", "digital assets"]; }
  if (cls === "fx") return [...(CCY_NAMES[s.slice(0, 3)] ?? []), ...(CCY_NAMES[s.slice(3)] ?? [])];
  return [s.toLowerCase()];
}

/** Keeps items whose title/summary mention any alias as a whole word/phrase. */
export function filterBySubject(items: NewsItem[], aliases: string[]): NewsItem[] {
  if (!aliases.length) return items;
  const esc = (a: string) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])(${aliases.map(esc).join("|")})([^a-z0-9]|$)`, "i");
  return items.filter(i => re.test(`${i.title} ${i.summary ?? ""}`));
}
