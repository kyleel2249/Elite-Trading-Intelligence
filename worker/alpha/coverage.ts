/**
 * Explicit market coverage registry. Computed from the live environment so it can never claim a source that is not configured.
 * "Global coverage" is NOT claimed: only the exchanges and instruments below with status connected/configured are scanned.
 */
import type { SecEnv } from "./sec.ts";
import { secConfigured } from "./sec.ts";
import type { EquityEnv } from "./equities.ts";
import { equityConfigured, feedOf } from "./equities.ts";

export type SourceStatus = "connected" | "configured" | "not_configured" | "implemented_live_unverified" | "not_ported" | "not_available";
export interface SourceInfo { id: string; name: string; kind: string; status: SourceStatus; fields: string[]; freshness: string; limits: string; notes: string }
export interface ExchangeInfo { exchange: string; region: string; assetClasses: string[]; status: "covered" | "covered_if_keys" | "no_provider"; provider: string | null; gap: string | null }
export interface CoverageEnv extends SecEnv, EquityEnv { ETHERSCAN_API_KEY?: string; QUIVER_API_KEY?: string }

export function coverage(env: CoverageEnv, now = Date.now()) {
  const eq = equityConfigured(env);
  const sources: SourceInfo[] = [
    { id: "binance", name: "Binance spot (public REST)", kind: "crypto market data", status: "connected", fields: ["OHLCV candles", "24h tickers (full universe)", "order book", "recent trades"], freshness: "live REST; candles validated, stale after 3 intervals", limits: "public rate limits; failover to Bybit and OKX for per-symbol data", notes: "Keyless. Spot USDT pairs only; no derivatives, funding rates or open interest are connected." },
    { id: "bybit", name: "Bybit spot (failover)", kind: "crypto market data", status: "connected", fields: ["OHLCV candles", "tickers", "order book", "recent trades"], freshness: "live REST", limits: "public rate limits", notes: "Used only when Binance fails; the serving venue is always reported." },
    { id: "okx", name: "OKX spot (failover)", kind: "crypto market data", status: "connected", fields: ["OHLCV candles", "tickers", "order book", "recent trades"], freshness: "live REST", limits: "public rate limits", notes: "Used only when Binance and Bybit fail." },
    { id: "alpaca_data", name: "Alpaca market data (US equities)", kind: "equity market data", status: eq ? "configured" : "not_configured", fields: ["daily OHLCV bars", "most-active and movers screener"], freshness: "daily bars; feed=" + feedOf(env), limits: "subrequest budget per run; free tier is IEX-only", notes: eq ? (feedOf(env) === "iex" ? "IEX feed: volume is a small share of consolidated volume, so volume and liquidity factors are understated; set ALPACA_DATA_FEED=sip with a subscription." : "SIP consolidated feed.") : "Set ALPACA_API_KEY and ALPACA_SECRET_KEY to enable US equity scanning. No fundamentals, options or short-interest data are available from this source." },
    { id: "sec_edgar", name: "SEC EDGAR", kind: "public disclosures", status: secConfigured(env) ? "configured" : "not_configured", fields: ["submissions index", "13F-HR information tables", "Form 4 transactions", "13D/13G filing index"], freshness: "13F quarterly and delayed up to 45 days; Form 4 within about 2 business days", limits: "10 requests/second; descriptive User-Agent required", notes: secConfigured(env) ? "Entity CIKs must be verified with POST /api/alpha/investors/verify before use." : "Set SEC_USER_AGENT (name and contact email) to enable EDGAR access." },
    { id: "openfigi", name: "OpenFIGI", kind: "identifier mapping", status: "implemented_live_unverified", fields: ["CUSIP to ticker"], freshness: "static mapping", limits: "25 requests/minute without a key", notes: "Used to turn 13F CUSIPs into tickers. Not exercised against the live API in the build sandbox." },
    { id: "dexscreener", name: "DexScreener", kind: "DEX liquidity and pricing", status: "implemented_live_unverified", fields: ["pairs", "liquidity", "24h volume and transactions", "new token profiles"], freshness: "near real time", limits: "public rate limits", notes: "Discovery and monitoring only; DEX tokens are never executable. Not exercised against the live API in the build sandbox." },
    { id: "goplus", name: "GoPlus token security", kind: "token contract verification", status: "implemented_live_unverified", fields: ["honeypot", "taxes", "ownership flags", "holder concentration"], freshness: "per request", limits: "public rate limits; EVM chains only (Solana not implemented)", notes: "'No flags found' is not a safety guarantee. Not exercised against the live API in the build sandbox." },
    { id: "etherscan", name: "Etherscan-compatible explorer (v2)", kind: "on-chain wallet activity", status: env.ETHERSCAN_API_KEY ? "implemented_live_unverified" : "not_configured", fields: ["ERC-20 transfers per address"], freshness: "near real time", limits: "API key plan limits", notes: "Wallet labels are user-supplied with a source and confidence; ETI ships no unverified labels." },
    { id: "quiver", name: "Quiver Quantitative", kind: "alternative data", status: "not_ported", fields: [], freshness: "n/a", limits: "plan-gated", notes: "Integrated only in the FastAPI backend (docs/QUIVER_LIQUID.md); not available in the Cloudflare Worker." },
    { id: "liquid", name: "Liquid / Quoine", kind: "exchange", status: "not_available", fields: [], freshness: "n/a", limits: "n/a", notes: "No currently supported public trading API was confirmed (docs/QUIVER_LIQUID.md); no integration is faked." },
  ];
  const nonUs = (exchange: string, region: string): ExchangeInfo => ({ exchange, region, assetClasses: ["equity"], status: "no_provider", provider: null, gap: "no market-data provider connected for this exchange" });
  const exchanges: ExchangeInfo[] = [
    { exchange: "Binance / Bybit / OKX spot", region: "Global crypto", assetClasses: ["crypto (USDT spot pairs)"], status: "covered", provider: "binance, bybit, okx", gap: "no futures, funding rates, open interest or exchange reserves" },
    ...["NYSE", "NASDAQ", "NYSE American"].map((e): ExchangeInfo => ({ exchange: e, region: "United States", assetClasses: ["equity"], status: "covered_if_keys", provider: "alpaca_data", gap: eq ? "daily bars only; no fundamentals; scan covers screener results and a watchlist, not every listed company" : "Alpaca keys not configured" })),
    nonUs("London Stock Exchange", "UK"), nonUs("Tokyo Stock Exchange", "Japan"), nonUs("Hong Kong Stock Exchange", "Hong Kong"), nonUs("Shanghai Stock Exchange", "China"), nonUs("Shenzhen Stock Exchange", "China"), nonUs("Euronext", "Europe"),
    nonUs("Frankfurt Stock Exchange", "Germany"), nonUs("Australian Securities Exchange", "Australia"), nonUs("Toronto Stock Exchange", "Canada"),
    { exchange: "ETFs", region: "United States", assetClasses: ["etf"], status: "covered_if_keys", provider: "alpaca_data", gap: "ETFs are scanned only when listed in ALPHA_EQUITY_WATCHLIST" },
    { exchange: "Commodities, FX, futures, options", region: "Global", assetClasses: ["commodity", "forex", "futures", "derivatives"], status: "no_provider", provider: null, gap: "no provider connected" },
    { exchange: "DEX pools and newly launched tokens", region: "EVM chains", assetClasses: ["token"], status: "covered", provider: "dexscreener, goplus", gap: "monitoring only; live API calls unverified in the build sandbox; Solana contract checks not implemented" },
  ];
  const gaps = ["Global equity coverage is NOT provided: only US-listed equities via Alpaca (when keys are set) and USDT spot crypto pairs are scanned", "No fundamentals, earnings, valuation, insider-sentiment or catalyst feed is connected, so those scoring factors are reported unavailable and excluded", "No derivatives data (funding, open interest, options flow) and no short-interest data", "On-chain wallet intelligence needs ETHERSCAN_API_KEY plus user-supplied sourced labels", "13F data is delayed and partial; Form 4 and 13D/G need the verified entity registry"];
  return { generatedAt: new Date(now).toISOString(), claim: "partial coverage", sources, exchanges, gaps };
}
