/**
 * Global-intelligence API (Cloudflare Workers, no keys, no paid infrastructure).
 *   GET /api/intel/sec?form=13F-HR|4|SC 13D|SC 13G|8-K&count=20   SEC EDGAR "current filings" feed
 *   GET /api/intel/research?count=15                              arXiv quantitative-finance papers
 *   GET /api/intel/dex/latest                                     DexScreener latest token profiles (a subset, not every new token)
 *   GET /api/intel/security/token?chain=1&address=0x...           GoPlus token-security report mapped to findings
 * Rules: every response names its source and fetch time; an upstream failure is an error, never invented data;
 * a missing data point is reported as unknown and is never treated as evidence that a token is safe.
 */
export interface IntelEnv { SEC_USER_AGENT?: string }

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=120", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const nowIso = () => new Date().toISOString();

async function upstream(url: string, init: RequestInit = {}, ms = 9000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal, cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit); }
  finally { clearTimeout(timer); }
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">")); return m ? decode(m[1]).trim() : ""; };
const attr = (xml: string, name: string, a: string) => { const m = xml.match(new RegExp("<" + name + "\\b[^>]*\\b" + a + "=\"([^\"]*)\"")); return m ? decode(m[1]) : ""; };
const entries = (xml: string) => xml.split("<entry>").slice(1).map(e => e.split("</entry>")[0]);

export const SEC_FORMS = ["13F-HR", "4", "SC 13D", "SC 13G", "8-K"];

export function parseSec(xml: string) {
  return entries(xml).map(e => {
    const title = tag(e, "title"), summary = tag(e, "summary").replace(/<[^>]*>/g, " ");  // EDGAR wraps labels in <b> tags
    const m = title.match(/^(.+?) - (.+?) \((\d{6,10})\)(?: \((.+?)\))?$/);
    return {
      form: m ? m[1] : title.split(" - ")[0], company: m ? m[2] : title, cik: m ? m[3] : null, role: m && m[4] ? m[4] : null,
      filedDate: (summary.match(/Filed:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null, acceptedAt: tag(e, "updated") || null, url: attr(e, "link", "href") || null,
    };
  });
}

export function parseArxiv(xml: string) {
  return entries(xml).map(e => ({
    id: tag(e, "id"), title: tag(e, "title").replace(/\s+/g, " "), published: tag(e, "published"), updated: tag(e, "updated"),
    authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => decode(a[1]).trim()).slice(0, 6),
    category: attr(e, "arxiv:primary_category", "term") || null, summary: tag(e, "summary").replace(/\s+/g, " ").slice(0, 420),
  }));
}

// GoPlus chain ids we support, and DexScreener chain names that map onto them.
export const CHAINS: Record<string, string> = { "1": "Ethereum", "56": "BNB Chain", "137": "Polygon", "42161": "Arbitrum", "8453": "Base", "10": "Optimism", "43114": "Avalanche" };
const DEX_TO_CHAIN: Record<string, string> = { ethereum: "1", bsc: "56", polygon: "137", arbitrum: "42161", base: "8453", optimism: "10", avalanche: "43114" };
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";
export interface Finding { id: string; severity: Severity; title: string; evidence: string }
const WEIGHT: Record<Severity, number> = { CRITICAL: 40, HIGH: 20, MEDIUM: 8, LOW: 3, INFORMATIONAL: 0 };

/** Map a GoPlus token_security record to findings. Unknown fields are listed separately and never counted as safe. */
export function assessToken(raw: Record<string, any>) {
  const findings: Finding[] = [], unknown: string[] = [];
  const num = (k: string) => (raw[k] === undefined || raw[k] === "" || raw[k] === null ? undefined : Number(raw[k]));
  const flag = (k: string, sev: Severity, title: string, bad = "1") => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") { unknown.push(k); return; }
    if (String(v) === bad) findings.push({ id: k, severity: sev, title, evidence: k + " = " + v });
  };
  flag("is_honeypot", "CRITICAL", "Flagged as a honeypot: sells may be blocked");
  flag("cannot_sell_all", "HIGH", "Holders cannot sell their full balance");
  flag("honeypot_with_same_creator", "HIGH", "Creator has deployed honeypot tokens before");
  flag("owner_change_balance", "CRITICAL", "Owner can change holder balances");
  flag("selfdestruct", "CRITICAL", "Contract can self-destruct");
  flag("is_mintable", "HIGH", "Owner can mint new supply");
  flag("can_take_back_ownership", "HIGH", "Ownership can be reclaimed after renouncing");
  flag("hidden_owner", "HIGH", "Hidden owner address");
  flag("is_blacklisted", "HIGH", "Contract can blacklist addresses");
  flag("transfer_pausable", "HIGH", "Transfers can be paused");
  flag("slippage_modifiable", "HIGH", "Owner can change tax or slippage");
  flag("personal_slippage_modifiable", "HIGH", "Owner can set per-address tax");
  flag("is_whitelisted", "MEDIUM", "Transfers restricted by a whitelist");
  flag("trading_cooldown", "MEDIUM", "Trading cooldown is enforced");
  flag("anti_whale_modifiable", "MEDIUM", "Owner can change anti-whale limits");
  flag("is_proxy", "MEDIUM", "Upgradeable proxy: logic can change");
  flag("is_open_source", "HIGH", "Contract source is not verified", "0");
  flag("external_call", "LOW", "Contract makes external calls");
  for (const [k, label] of [["buy_tax", "Buy tax"], ["sell_tax", "Sell tax"]] as const) {
    const v = num(k);
    if (v === undefined) { unknown.push(k); continue; }
    if (k === "sell_tax" && v >= 1) findings.push({ id: k, severity: "CRITICAL", title: "Sell tax of 100% or more: effectively unsellable", evidence: k + " = " + v });
    else if (v > 0.3) findings.push({ id: k, severity: "CRITICAL", title: label + " above 30%", evidence: k + " = " + v });
    else if (v > 0.1) findings.push({ id: k, severity: "HIGH", title: label + " above 10%", evidence: k + " = " + v });
  }
  for (const k of ["creator_percent", "owner_percent"]) {
    const v = num(k);
    if (v === undefined) { unknown.push(k); continue; }
    if (v > 0.2) findings.push({ id: k, severity: "HIGH", title: (k === "creator_percent" ? "Creator" : "Owner") + " holds over 20% of supply", evidence: k + " = " + v });
  }
  const holders: any[] = Array.isArray(raw.holders) ? raw.holders : [];
  if (!holders.length) unknown.push("holders");
  else {
    const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0);
    if (top10 > 0.5) findings.push({ id: "top10_holders", severity: "MEDIUM", title: "Top 10 holders control over 50% (includes LP and locked wallets)", evidence: "top10 = " + (top10 * 100).toFixed(1) + "%" });
  }
  const lp: any[] = Array.isArray(raw.lp_holders) ? raw.lp_holders : [];
  let lockedPct: number | null = null;
  if (!lp.length) unknown.push("lp_holders");
  else {
    lockedPct = lp.filter(h => Number(h.is_locked) === 1).reduce((s, h) => s + (Number(h.percent) || 0), 0);
    if (lockedPct < 0.5) findings.push({ id: "lp_unlocked", severity: "HIGH", title: "Less than half of liquidity is locked", evidence: "locked LP = " + (lockedPct * 100).toFixed(1) + "% (of the LP holders reported)" });
  }
  const dex: any[] = Array.isArray(raw.dex) ? raw.dex : [];
  let liquidityUsd: number | null = null;
  if (!dex.length) unknown.push("dex");
  else {
    liquidityUsd = dex.reduce((s, d) => s + (Number(d.liquidity) || 0), 0);
    if (liquidityUsd < 10_000) findings.push({ id: "low_liquidity", severity: "HIGH", title: "Very low DEX liquidity: exits may be impossible", evidence: "liquidity = $" + Math.round(liquidityUsd) });
  }
  const score = Math.min(100, findings.reduce((s, f) => s + WEIGHT[f.severity], 0));
  const core = ["is_honeypot", "is_open_source", "is_mintable", "sell_tax", "buy_tax", "lp_holders", "dex"];
  const coreUnknown = core.filter(k => unknown.includes(k)).length;
  const has = (s: Severity) => findings.some(f => f.severity === s);
  const level = has("CRITICAL") || score >= 80 ? "CRITICAL" : has("HIGH") || score >= 50 ? "HIGH" : has("MEDIUM") ? "MEDIUM" : coreUnknown >= 4 ? "UNKNOWN" : "LOW";
  const action = level === "CRITICAL" ? "Do not buy. If already held, check whether selling is possible and consider exiting at once; suspend new entries."
    : level === "HIGH" ? "Avoid new entries and review the flagged risks before holding."
    : level === "MEDIUM" ? "Proceed only with reduced size after reviewing the flagged risks."
    : level === "UNKNOWN" ? "Too little provider data to judge. Do not treat this as safe."
    : "No flags found in the provider data. This is not a safety guarantee.";
  return { score, level, findings: findings.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity]), unknown, recommendedAction: action, liquidityUsd, lockedLiquidityPct: lockedPct === null ? null : Number((lockedPct * 100).toFixed(1)) };
}

const fail = (source: string, e: unknown, status = 502) => reply({ error: "upstream_unavailable", source, detail: e instanceof Error ? e.message : "unknown", fetchedAt: nowIso() }, status);

export async function handleIntel(req: Request, env: IntelEnv): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/api/intel/")) return null;
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
  const q = url.searchParams;

  if (path === "/api/intel/sec") {
    const form = q.get("form") || "13F-HR", count = Math.max(1, Math.min(40, Number(q.get("count") || 20) || 20));
    if (!SEC_FORMS.includes(form)) return reply({ error: "invalid_form", forms: SEC_FORMS }, 400);
    const src = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=" + encodeURIComponent(form) + "&company=&dateb=&owner=include&start=0&count=" + count + "&output=atom";
    try {
      const r = await upstream(src, { headers: { "user-agent": env.SEC_USER_AGENT || "ETI-Research/1.0 (+https://github.com/kyleel2249/Elite-Trading-Intelligence)", accept: "application/atom+xml" } });
      if (!r.ok) return fail("SEC EDGAR", new Error("HTTP " + r.status));
      const items = parseSec(await r.text());
      return reply({ source: "SEC EDGAR current filings feed", sourceUrl: src, form, fetchedAt: nowIso(), count: items.length, items,
        caveat: "Filing and acceptance dates are when a document was submitted to the SEC. Form 4 and 13F describe past transactions or holdings and are not real-time trading activity." });
    } catch (e) { return fail("SEC EDGAR", e); }
  }

  if (path === "/api/intel/research") {
    const count = Math.max(1, Math.min(30, Number(q.get("count") || 15) || 15));
    const src = "https://export.arxiv.org/api/query?search_query=" + encodeURIComponent("cat:q-fin.TR OR cat:q-fin.PM OR cat:q-fin.RM OR cat:q-fin.ST OR cat:q-fin.CP") + "&sortBy=submittedDate&sortOrder=descending&max_results=" + count;
    try {
      const r = await upstream(src, { headers: { accept: "application/atom+xml" } });
      if (!r.ok) return fail("arXiv q-fin", new Error("HTTP " + r.status));
      const items = parseArxiv(await r.text());
      return reply({ source: "arXiv quantitative finance (trading, portfolio, risk, statistical, computational)", sourceUrl: src, fetchedAt: nowIso(), count: items.length, items,
        caveat: "Preprints are not peer reviewed. Findings must be validated before they influence any production strategy. SSRN offers no open API and is not queried." });
    } catch (e) { return fail("arXiv", e); }
  }

  if (path === "/api/intel/dex/latest") {
    const src = "https://api.dexscreener.com/token-profiles/latest/v1";
    try {
      const r = await upstream(src);
      if (!r.ok) return fail("DexScreener", new Error("HTTP " + r.status));
      const raw = await r.json() as any[];
      const items = (Array.isArray(raw) ? raw : []).slice(0, 30).map(t => ({ chain: String(t.chainId || ""), address: String(t.tokenAddress || ""), url: t.url || null, description: String(t.description || "").slice(0, 160), checkChain: DEX_TO_CHAIN[String(t.chainId || "")] || null }));
      return reply({ source: "DexScreener latest token profiles", sourceUrl: src, fetchedAt: nowIso(), count: items.length, items,
        caveat: "These are tokens that recently published a profile on DexScreener, a subset of new tokens and not a complete launch feed. Only EVM chains can be security-checked here." });
    } catch (e) { return fail("DexScreener", e); }
  }

  if (path === "/api/intel/security/token") {
    const chain = q.get("chain") || "", address = q.get("address") || "";
    if (!CHAINS[chain]) return reply({ error: "unsupported_chain", chains: CHAINS }, 400);
    if (!ADDRESS.test(address)) return reply({ error: "invalid_address", message: "Expected a 0x-prefixed 40-hex-character EVM contract address" }, 400);
    const src = "https://api.gopluslabs.io/api/v1/token_security/" + chain + "?contract_addresses=" + address.toLowerCase();
    try {
      const r = await upstream(src);
      if (!r.ok) return fail("GoPlus", new Error("HTTP " + r.status));
      const body = await r.json() as any;
      const rec = body?.result?.[address.toLowerCase()];
      if (!rec || typeof rec !== "object" || !Object.keys(rec).length)
        return reply({ chain, chainName: CHAINS[chain], address, level: "UNKNOWN", score: null, findings: [], unknown: ["entire report"], recommendedAction: "The provider has no data for this contract. Absence of data is not evidence of safety.", source: "GoPlus Security", sourceUrl: src, fetchedAt: nowIso(), confidence: "none" });
      const a = assessToken(rec);
      return reply({ chain, chainName: CHAINS[chain], address, tokenName: rec.token_name || null, tokenSymbol: rec.token_symbol || null, ...a, source: "GoPlus Security", sourceUrl: src, fetchedAt: nowIso(),
        confidence: "Provider-reported static analysis. No independent on-chain verification and no transaction-level simulation was performed; holder and liquidity data may lag." });
    } catch (e) { return fail("GoPlus", e); }
  }
  return reply({ error: "not_found", routes: ["/api/intel/sec", "/api/intel/research", "/api/intel/dex/latest", "/api/intel/security/token"] }, 404);
}
