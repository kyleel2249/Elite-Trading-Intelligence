/**
 * Whale, order-flow and on-chain intelligence.
 *
 * - Exchange order flow (REAL data from the connected exchanges): large-print analysis, order-book imbalance and
 *   persistence, wash-trading heuristics. This is exchange-side activity, not on-chain activity.
 * - DEX pairs (DexScreener) and token-contract security (GoPlus): public APIs, parsed defensively.
 * - Wallet watching (Etherscan-compatible API, needs ETHERSCAN_API_KEY): attribution always carries a confidence;
 *   a wallet is never tied to a named person or institution without a sourced label.
 * The DEX/security/explorer parsers follow the providers' documented response shapes but could not be exercised against the
 * live APIs from the build sandbox (no outbound network); coverage reports them as "implemented, live-unverified".
 */
import type { Depth, Trade } from "../market.ts";
import { clamp, round, sum } from "./indicators.ts";
import { Budget, type FetchLike } from "./budget.ts";

// ------------------------------------------------------------- exchange order flow
export interface FlowAnalysis {
  sampleTrades: number; thresholdUsd: number; largePrints: number; largeBuyUsd: number; largeSellUsd: number; netLargeUsd: number; largeShare: number;
  bookImbalance1pct: number; bidDepth1pct: number; askDepth1pct: number; washScore: number; washFlags: string[]; verdict: "accumulation_pressure" | "distribution_pressure" | "balanced" | "insufficient_data"; evidence: string[];
}
export function analyseFlow(trades: Trade[], depth: Depth | null): FlowAnalysis {
  const evidence: string[] = [], n = trades.length, notional = trades.map(t => t.price * t.qty);
  const sorted = [...notional].sort((a, b) => a - b), thr = n >= 20 ? Math.max(sorted[Math.floor(n * 0.95)], 1) : Infinity;
  let buy = 0, sell = 0, big = 0;
  trades.forEach((t, i) => { if (notional[i] >= thr) { big++; if (t.isBuyerMaker) sell += notional[i]; else buy += notional[i]; } });
  const total = sum(notional), mid = depth && depth.bids[0] && depth.asks[0] ? (depth.bids[0][0] + depth.asks[0][0]) / 2 : null;
  let bid = 0, ask = 0; if (depth && mid) { bid = sum(depth.bids.filter(l => l[0] >= mid * 0.99).map(l => l[0] * l[1])); ask = sum(depth.asks.filter(l => l[0] <= mid * 1.01).map(l => l[0] * l[1])); }
  const imb = bid + ask > 0 ? (bid - ask) / (bid + ask) : 0;
  // wash-trading heuristics: repeated identical qty/price prints, and alternating same-size buy/sell pairs
  const key = (t: Trade) => t.price + "|" + t.qty, counts = new Map<string, number>(); trades.forEach(t => counts.set(key(t), (counts.get(key(t)) || 0) + 1));
  const repeated = n ? sum([...counts.values()].filter(c => c >= 3)) / n : 0; let alt = 0; for (let i = 1; i < n; i++) if (trades[i].qty === trades[i - 1].qty && trades[i].isBuyerMaker !== trades[i - 1].isBuyerMaker) alt++;
  const altShare = n > 1 ? alt / (n - 1) : 0, wash = clamp(repeated * 1.5 + Math.max(0, altShare - 0.15) * 2), flags: string[] = [];
  if (repeated > 0.15) flags.push(round(repeated * 100, 0) + "% of prints repeat an identical price and size");
  if (altShare > 0.3) flags.push(round(altShare * 100, 0) + "% of consecutive prints are same-size buy/sell pairs");
  const net = buy - sell; let verdict: FlowAnalysis["verdict"] = "insufficient_data";
  if (n >= 20 && big >= 2) verdict = net > 0.25 * (buy + sell) && imb >= -0.1 ? "accumulation_pressure" : net < -0.25 * (buy + sell) && imb <= 0.1 ? "distribution_pressure" : "balanced";
  evidence.push(n + " recent prints; large-print threshold (95th pct) " + (Number.isFinite(thr) ? Math.round(thr).toLocaleString("en-US") : "n/a") + " quote units");
  evidence.push("large prints: " + big + ", net aggressive " + (net >= 0 ? "buying " : "selling ") + Math.round(Math.abs(net)).toLocaleString("en-US"));
  if (mid) evidence.push("visible book within 1%: bids " + Math.round(bid).toLocaleString("en-US") + " vs asks " + Math.round(ask).toLocaleString("en-US") + " (imbalance " + round(imb, 2) + ")");
  return { sampleTrades: n, thresholdUsd: Number.isFinite(thr) ? Math.round(thr) : 0, largePrints: big, largeBuyUsd: Math.round(buy), largeSellUsd: Math.round(sell), netLargeUsd: Math.round(net), largeShare: total > 0 ? round((buy + sell) / total, 3) : 0, bookImbalance1pct: round(imb, 3), bidDepth1pct: Math.round(bid), askDepth1pct: Math.round(ask), washScore: round(wash, 2), washFlags: flags, verdict, evidence };
}
/** Persistence of bid-side support across stored order-book snapshots (share of samples with a bid-heavy book). */
export function bidSupportPersistence(samples: number[]): { share: number; n: number; persistent: boolean } {
  const n = samples.length; const share = n ? samples.filter(s => s > 0.1).length / n : 0; return { share: round(share, 2), n, persistent: n >= 6 && share >= 0.7 };
}
/** Converts exchange flow into 0..1 evidence for fusion (exchange order flow, not on-chain). */
export function flowEvidence(f: FlowAnalysis, persistence?: { persistent: boolean; share: number; n: number }): { score: number; evidence: string[] } | null {
  if (f.verdict === "insufficient_data") return null;
  let s = f.verdict === "accumulation_pressure" ? 0.8 : f.verdict === "balanced" ? 0.5 : 0.15; s -= f.washScore * 0.5;
  if (persistence?.persistent) s += 0.1;
  return { score: clamp(s), evidence: [...f.evidence, ...f.washFlags.map(w => "wash-trading indicator: " + w), ...(persistence && persistence.n ? ["bid-heavy book in " + round(persistence.share * 100, 0) + "% of " + persistence.n + " stored snapshots"] : [])] };
}

// ------------------------------------------------------------------ DEX pairs
export interface DexPair { chainId: string; dex: string; pairAddress: string; tokenAddress: string; symbol: string; name: string; quote: string; priceUsd: number | null; liquidityUsd: number; volume24hUsd: number; buys24h: number; sells24h: number; priceChange24h: number | null; fdv: number | null; marketCap: number | null; createdAt: number | null; url: string | null }
export function parseDexPairs(json: any): DexPair[] {
  const pairs = Array.isArray(json?.pairs) ? json.pairs : []; const n = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  return pairs.filter((p: any) => p?.chainId && p?.pairAddress && p?.baseToken?.address).map((p: any) => ({ chainId: String(p.chainId), dex: String(p.dexId || ""), pairAddress: String(p.pairAddress), tokenAddress: String(p.baseToken.address), symbol: String(p.baseToken.symbol || ""), name: String(p.baseToken.name || ""), quote: String(p.quoteToken?.symbol || ""),
    priceUsd: n(p.priceUsd), liquidityUsd: n(p.liquidity?.usd) ?? 0, volume24hUsd: n(p.volume?.h24) ?? 0, buys24h: n(p.txns?.h24?.buys) ?? 0, sells24h: n(p.txns?.h24?.sells) ?? 0, priceChange24h: n(p.priceChange?.h24), fdv: n(p.fdv), marketCap: n(p.marketCap), createdAt: n(p.pairCreatedAt), url: p.url ? String(p.url) : null }));
}
export function parseDexProfiles(json: any): { chainId: string; tokenAddress: string }[] {
  const a = Array.isArray(json) ? json : []; return a.filter((x: any) => x?.chainId && x?.tokenAddress).map((x: any) => ({ chainId: String(x.chainId), tokenAddress: String(x.tokenAddress) }));
}
export interface DexAssessment { riskScore: number; flags: string[]; tradeable: false; reason: string; liquidityUsd: number; ageHours: number | null }
/** Risk assessment from market-structure facts only. A DEX token is never marked tradeable by ETI (no connected DEX execution). */
export function assessDexPair(p: DexPair, now: number): DexAssessment {
  const flags: string[] = [], age = p.createdAt ? (now - p.createdAt) / 3600000 : null; let risk = 0;
  if (p.liquidityUsd < 50_000) { flags.push("liquidity below $50k: any real size moves the price"); risk += 0.35; }
  if (age !== null && age < 24) { flags.push("pair is under 24 hours old"); risk += 0.2; }
  if (p.liquidityUsd > 0 && p.volume24hUsd / p.liquidityUsd > 30) { flags.push("24h volume is " + round(p.volume24hUsd / p.liquidityUsd, 0) + "x liquidity: possible artificial volume"); risk += 0.2; }
  const tx = p.buys24h + p.sells24h; if (tx >= 50 && (p.sells24h === 0 || p.buys24h / Math.max(1, p.sells24h) > 8)) { flags.push("almost no sells versus buys: possible honeypot or one-way market"); risk += 0.25; }
  if (p.fdv && p.liquidityUsd > 0 && p.fdv / p.liquidityUsd > 500) { flags.push("FDV is " + round(p.fdv / p.liquidityUsd, 0) + "x liquidity: tiny float"); risk += 0.15; }
  return { riskScore: round(clamp(risk), 2), flags, tradeable: false, reason: "no connected execution venue for DEX tokens; discovery and monitoring only", liquidityUsd: p.liquidityUsd, ageHours: age === null ? null : round(age, 1) };
}
export const DEX_CHAIN_IDS: Record<string, number> = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114 };
export function parseTokenSecurity(json: any, address: string): TokenSecurity | null {
  const e = json?.result?.[address.toLowerCase()] ?? json?.result?.[address]; if (!e || typeof e !== "object") return null;
  const f = (k: string) => String(e[k] ?? "") === "1", p = (k: string) => { const x = Number(e[k]); return Number.isFinite(x) ? x : null; };
  const flags: string[] = []; let level = 0;
  const crit = (c: boolean, t: string) => { if (c) { flags.push(t); level = Math.max(level, 3); } }, high = (c: boolean, t: string) => { if (c) { flags.push(t); level = Math.max(level, 2); } }, caution = (c: boolean, t: string) => { if (c) { flags.push(t); level = Math.max(level, 1); } };
  crit(f("is_honeypot"), "contract is flagged as a honeypot (cannot sell)"); crit(f("cannot_sell_all"), "holders cannot sell their full balance");
  high(f("hidden_owner"), "hidden owner"); high(f("can_take_back_ownership"), "ownership can be taken back"); high(f("selfdestruct"), "contract can self-destruct"); high(f("transfer_pausable"), "transfers can be paused by the owner");
  high((p("sell_tax") ?? 0) > 0.1, "sell tax above 10%"); high((p("buy_tax") ?? 0) > 0.1, "buy tax above 10%"); caution(f("is_mintable"), "supply is mintable"); caution(e.is_open_source !== undefined && !f("is_open_source"), "source code is not verified"); caution(f("is_proxy"), "upgradeable proxy contract");
  const holders: any[] = Array.isArray(e.holders) ? e.holders : [], top10 = sum(holders.slice(0, 10).map(h => Number(h.percent) || 0)) * 100;
  caution(top10 > 50, "top 10 holders control " + round(top10, 0) + "% of supply"); high(top10 > 80, "top 10 holders control " + round(top10, 0) + "% of supply (extreme concentration)");
  return { verdict: level >= 3 ? "critical" : level === 2 ? "high_risk" : level === 1 ? "caution" : "no_flags_found", flags: [...new Set(flags)], honeypot: f("is_honeypot"), buyTax: p("buy_tax"), sellTax: p("sell_tax"), top10Percent: holders.length ? round(top10, 1) : null, holderCount: p("holder_count"), note: "no_flags_found is NOT a safety guarantee; the provider cannot see everything" };
}
export interface TokenSecurity { verdict: "critical" | "high_risk" | "caution" | "no_flags_found"; flags: string[]; honeypot: boolean; buyTax: number | null; sellTax: number | null; top10Percent: number | null; holderCount: number | null; note: string }

export async function fetchDexPairsForTokens(tokens: { chainId: string; tokenAddress: string }[], b: Budget, f: FetchLike = fetch): Promise<DexPair[]> {
  const out: DexPair[] = [], byChain = new Map<string, string[]>(); tokens.forEach(t => byChain.set(t.chainId, [...(byChain.get(t.chainId) || []), t.tokenAddress]));
  for (const addrs of byChain.values()) for (let i = 0; i < addrs.length; i += 30) { if (!b.take()) return out; try { const r = await f("https://api.dexscreener.com/latest/dex/tokens/" + addrs.slice(i, i + 30).join(","), { headers: { accept: "application/json" } }); if (r.ok) out.push(...parseDexPairs(await r.json())); } catch { /* provider failure: partial result */ } }
  return out;
}
export async function fetchLatestDexProfiles(b: Budget, f: FetchLike = fetch): Promise<{ chainId: string; tokenAddress: string }[]> {
  if (!b.take()) return []; try { const r = await f("https://api.dexscreener.com/token-profiles/latest/v1", { headers: { accept: "application/json" } }); return r.ok ? parseDexProfiles(await r.json()) : []; } catch { return []; }
}
export async function fetchTokenSecurity(chainId: string, address: string, b: Budget, f: FetchLike = fetch): Promise<TokenSecurity | null> {
  const id = DEX_CHAIN_IDS[chainId]; if (!id || !b.take()) return null;
  try { const r = await f("https://api.gopluslabs.io/api/v1/token_security/" + id + "?contract_addresses=" + address, { headers: { accept: "application/json" } }); return r.ok ? parseTokenSecurity(await r.json(), address) : null; } catch { return null; }
}
export function onchainEvidenceForDex(p: DexPair, sec: TokenSecurity | null, now: number): { score: number; evidence: string[]; sources: string[] } {
  const a = assessDexPair(p, now); let s = 1 - a.riskScore;
  if (sec) { if (sec.verdict === "critical") s = 0; else if (sec.verdict === "high_risk") s = Math.min(s, 0.2); else if (sec.verdict === "caution") s = Math.min(s, 0.5); }
  return { score: clamp(s), evidence: [...a.flags, ...(sec ? sec.flags.map(x => "contract: " + x) : ["contract security not checked"])], sources: ["dexscreener.com", ...(sec ? ["gopluslabs.io"] : [])] };
}

// ------------------------------------------------------------------ wallet watching
export interface WalletLabel { address: string; label: string; kind: "exchange" | "fund" | "treasury" | "contract" | "unknown"; source: string | null; confidence: number; addedAt: string }
export interface Transfer { hash: string; time: number; from: string; to: string; token: string; amount: number; contract: string }
export function parseEtherscanTransfers(json: any): Transfer[] {
  if (!json || !Array.isArray(json.result)) return [];
  return json.result.map((r: any) => ({ hash: String(r.hash), time: Number(r.timeStamp) * 1000, from: String(r.from).toLowerCase(), to: String(r.to).toLowerCase(), token: String(r.tokenSymbol || "ETH"), amount: Number(r.value) / Math.pow(10, Number(r.tokenDecimal ?? 18)), contract: String(r.contractAddress || "").toLowerCase() })).filter((t: Transfer) => Number.isFinite(t.time) && Number.isFinite(t.amount));
}
export interface WalletActivity { address: string; attribution: string; attributionConfidence: number; windowTransfers: number; netByToken: Record<string, number>; exchangeInflow: Record<string, number>; exchangeOutflow: Record<string, number>; dormantActivated: boolean; lastActivity: string | null; notes: string[] }
export function analyseWallet(address: string, transfers: Transfer[], labels: WalletLabel[], now: number, dormantDays = 180): WalletActivity {
  const a = address.toLowerCase(), lab = labels.find(l => l.address.toLowerCase() === a), ex = new Set(labels.filter(l => l.kind === "exchange").map(l => l.address.toLowerCase()));
  const net: Record<string, number> = {}, inn: Record<string, number> = {}, out: Record<string, number> = {}, notes: string[] = [];
  for (const t of transfers) { const sign = t.to === a ? 1 : t.from === a ? -1 : 0; if (!sign) continue; net[t.token] = (net[t.token] || 0) + sign * t.amount; if (sign < 0 && ex.has(t.to)) inn[t.token] = (inn[t.token] || 0) + t.amount; if (sign > 0 && ex.has(t.from)) out[t.token] = (out[t.token] || 0) + t.amount; }
  const times = transfers.map(t => t.time).sort((x, y) => y - x), dormant = times.length >= 2 && times[0] > now - 7 * 86400000 && times[0] - times[1] > dormantDays * 86400000;
  const attribution = lab && lab.source && lab.confidence >= 0.8 ? lab.label + " (sourced: " + lab.source + ")" : "unattributed address " + address.slice(0, 8) + "..." + address.slice(-4) + (lab ? " (low-confidence label '" + lab.label + "' not asserted)" : "");
  if (dormant) notes.push("dormant wallet activated: " + Math.round((times[0] - times[1]) / 86400000) + " days since its previous transfer");
  for (const [tkn, v] of Object.entries(inn)) notes.push("sent " + Math.round(v).toLocaleString("en-US") + " " + tkn + " to labelled exchange addresses (possible distribution)");
  for (const [tkn, v] of Object.entries(out)) notes.push("received " + Math.round(v).toLocaleString("en-US") + " " + tkn + " from labelled exchange addresses (possible accumulation)");
  return { address: a, attribution, attributionConfidence: lab ? lab.confidence : 0, windowTransfers: transfers.length, netByToken: Object.fromEntries(Object.entries(net).map(([k, v]) => [k, round(v, 4)])), exchangeInflow: inn, exchangeOutflow: out, dormantActivated: dormant, lastActivity: times.length ? new Date(times[0]).toISOString() : null, notes };
}
export async function fetchWalletTransfers(address: string, chainId: number, key: string | undefined, b: Budget, f: FetchLike = fetch): Promise<{ ok: true; data: Transfer[] } | { ok: false; reason: string }> {
  if (!key) return { ok: false, reason: "etherscan_api_key_not_configured" }; if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, reason: "invalid_address" }; if (!b.take()) return { ok: false, reason: "subrequest_budget_exhausted" };
  try { const r = await f("https://api.etherscan.io/v2/api?chainid=" + chainId + "&module=account&action=tokentx&address=" + address + "&page=1&offset=100&sort=desc&apikey=" + encodeURIComponent(key)); if (!r.ok) return { ok: false, reason: "http_" + r.status }; const j: any = await r.json(); if (j.status === "0" && !Array.isArray(j.result)) return { ok: false, reason: "explorer_" + String(j.message || "error").toLowerCase().replace(/\W+/g, "_") }; return { ok: true, data: parseEtherscanTransfers(j) }; } catch { return { ok: false, reason: "network_error" }; }
}
